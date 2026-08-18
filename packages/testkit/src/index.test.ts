import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { CONTRACT_VERSION, type GoalSnapshot, type WakeSnapshot } from "@goah/ledger-contract";
import { ProcessRunner } from "@goah/runner-pi";
import { GitWorkspaceManager, Supervisor } from "@goah/supervisor";
import { assertLedgerConformance, createMemoryLedger, fauxRunnerWorkerPath, MockConnector, SimulatedClock } from "./index.js";

const metric = { source: "test", window: "1h", direction: "at_least" as const, target: 1, freshnessMs: 60_000, onMissing: "abnormal" as const, onStale: "wake_owner" as const };
function queuedWake(id: string, agent = "worker", triggerRef = `trigger:${id}`): WakeSnapshot { return { id, agent, triggerRef, status: "queued", leaseUntil: null, attempt: 0, startedAt: null, endedAt: null, enqueuedSeq: 0, leaseToken: null, runnerPid: null }; }
function goal(): GoalSnapshot { return { id: "root", parentId: null, objective: "produce a checked artifact", metric, target: 1, owner: "worker", budget: null, phase: "active", revision: 0 }; }
function repository(): string {
  const path = mkdtempSync(join(tmpdir(), "goah-workspace-"));
  git(path, ["init", "-b", "main"]); git(path, ["config", "user.email", "goah@example.test"]); git(path, ["config", "user.name", "GOAH Test"]);
  writeFileSync(join(path, "README.md"), "# artifact workspace\n"); git(path, ["add", "README.md"]); git(path, ["commit", "-m", "initial"]);
  return path;
}

test("public ledger conformance suite validates the SQLite implementation", () => {
  assertLedgerConformance((clock) => createMemoryLedger({ clock }));
});

test("vertical slice commits handoff, acknowledges mail, and merges the artifact", async () => {
  const repo = repository();
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const contextFile = join(mkdtempSync(join(tmpdir(), "goah-context-")), "context.json");
  const runner = fauxRunner([
    { tokens: 100, write: { path: "artifact.txt", content: "verified\n" }, trace: [{ kind: "tool", data: { name: "write_artifact" } }] },
    { tokens: 50, handoff: { handoff: { observations: ["workspace clean"], results: ["artifact written"], nextSteps: ["check later"] }, mail: [], nextWakeAt: "2026-08-19T00:00:00.000Z" } },
  ], contextFile);
  const supervisor = new Supervisor(ledger, runner, clock, { workspace: new GitWorkspaceManager(repo) });
  supervisor.createGoal(goal());
  ledger.putMail({ id: "mail-1", to: "worker", from: "human", level: "decision", body: {}, readAt: null }, "human");
  supervisor.planWake("worker", clock.now().toISOString(), "initial run");
  const completed = await supervisor.tick();
  assert.equal(completed?.status, "done");
  assert.equal(readFileSync(join(repo, "artifact.txt"), "utf8"), "verified\n");
  assert.equal((JSON.parse(readFileSync(contextFile, "utf8")) as { mail: unknown[] }).mail.length, 1);
  assert.equal(ledger.unreadMail("worker").length, 0);
  const merged = ledger.events().find((event) => event.kind === "workspace.merged");
  assert.ok(merged);
  assert.equal(git(repo, ["rev-parse", "HEAD"]), (merged.data as { commitSha: string }).commitSha);
  ledger.close();
});

test("crashed wake keeps emergency mail unread and recovery receives both mail and salvage events", async () => {
  const repo = repository();
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const workspace = new GitWorkspaceManager(repo);
  const crashing = fauxRunner([{ tokens: 10, write: { path: "partial.txt", content: "keep\n" } }, { tokens: 1, crash: "boom" }]);
  const first = new Supervisor(ledger, crashing, clock, { workspace });
  first.createGoal(goal());
  ledger.putMail({ id: "urgent", to: "worker", from: "human", level: "emergency", body: { alert: true }, readAt: null }, "human");
  first.planWake("worker", clock.now().toISOString(), "crash");
  const abnormal = await first.tick();
  assert.equal(abnormal?.status, "abnormal");
  assert.equal(ledger.unreadMail("worker").length, 1);
  const salvage = ledger.events().find((event) => event.kind === "workspace.salvaged");
  assert.ok(salvage);
  assert.equal(existsSync(join(repo, "partial.txt")), false);
  assert.equal(git(repo, ["show", `${(salvage.data as { ref: string }).ref}:partial.txt`]), "keep");

  const recoveryContext = join(mkdtempSync(join(tmpdir(), "goah-context-")), "context.json");
  const recovering = fauxRunner([{ tokens: 5, handoff: { handoff: { observations: [], results: [], nextSteps: [] }, mail: [], nextWakeAt: null } }], recoveryContext);
  ledger.enqueueWake(queuedWake("recovery", "worker", `recovery:${abnormal!.id}`), "supervisor");
  const second = new Supervisor(ledger, recovering, clock, { workspace });
  assert.equal((await second.tick())?.status, "done");
  const context = JSON.parse(readFileSync(recoveryContext, "utf8")) as { mail: unknown[]; recoveryEvents: unknown[] };
  assert.equal(context.mail.length, 1);
  assert.ok(context.recoveryEvents.length > 0);
  assert.equal(ledger.unreadMail("worker").length, 0);
  ledger.close();
});

test("recovery kills the recorded runner process before salvaging its worktree", async () => {
  const repo = repository();
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const workspace = new GitWorkspaceManager(repo);
  const runner = new ProcessRunner({ command: process.execPath, args: [fauxRunnerWorkerPath()], env: { GOAH_FAUX_STEPS: JSON.stringify([{ tokens: 1, write: { path: "running.txt", content: "partial\n" }, hang: true }]) }, killGraceMs: 25 });
  ledger.enqueueWake(queuedWake("running"), "supervisor");
  const leased = ledger.claimNextWake(clock.now().toISOString(), new Date(clock.now().getTime() + 100).toISOString(), "lease")!;
  const path = await workspace.prepare(leased);
  const running = ledger.markWakeRunning(leased.id, clock.now().toISOString(), "lease");
  const handle = runner.prepare({ wake: running, context: {}, workspacePath: path, limits: { maxTokens: 100, maxWallClockMs: 10_000, handoffReserveTokens: 10, handoffReserveWallClockMs: 100 }, now: () => clock.now().toISOString(), emit: () => undefined });
  ledger.attachWakeProcess(running.id, "lease", handle.pid!, clock.now().toISOString());
  handle.begin();
  await waitFor(() => existsSync(join(path, "running.txt")));
  clock.advance(200);
  await new Supervisor(ledger, runner, clock, { workspace }).recover();
  assert.equal(ledger.wake("running")?.status, "abnormal");
  assert.throws(() => process.kill(handle.pid!, 0));
  const event = ledger.events().findLast((item) => item.kind === "workspace.salvaged");
  assert.ok(event);
  assert.equal(git(repo, ["show", `${(event.data as { ref: string }).ref}:running.txt`]), "partial");
  ledger.close();
});

test("real rebase conflict is retained as a ref and never overwrites main", async () => {
  const repo = repository();
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const runner = fauxRunner([
    { tokens: 10, write: { path: "README.md", content: "worker change\n" } },
    { tokens: 1, delayMs: 200 },
    { tokens: 5, handoff: { handoff: { observations: [], results: [], nextSteps: [] }, mail: [], nextWakeAt: null } },
  ]);
  const supervisor = new Supervisor(ledger, runner, clock, { workspace: new GitWorkspaceManager(repo) });
  supervisor.createGoal(goal()); supervisor.planWake("worker", clock.now().toISOString(), "conflict");
  const pending = supervisor.tick();
  const worktrees = join(repo, ".goah", "worktrees");
  await waitFor(() => readdirSync(worktrees).some((entry) => existsSync(join(worktrees, entry, "README.md")) && readFileSync(join(worktrees, entry, "README.md"), "utf8") === "worker change\n"));
  writeFileSync(join(repo, "README.md"), "main change\n"); git(repo, ["add", "README.md"]); git(repo, ["commit", "-m", "main change"]);
  const result = await pending;
  assert.equal(result?.status, "merge_blocked");
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "main change\n");
  const event = ledger.events().find((item) => item.kind === "workspace.merge_blocked");
  assert.ok(event);
  assert.equal(git(repo, ["show", `${(event.data as { ref: string }).ref}:README.md`]), "worker change");
  ledger.close();
});

test("gated action can be approved, connector crash becomes unknown, and audit advice is injected", async () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const connector = new MockConnector("external");
  connector.manifest.dryRun = false;
  connector.failAfterEffect = true;
  const contextFile = join(mkdtempSync(join(tmpdir(), "goah-context-")), "context.json");
  const supervisor = new Supervisor(ledger, fauxRunner([{ tokens: 5, handoff: { handoff: { observations: [], results: [], nextSteps: [] }, mail: [], nextWakeAt: null } }], contextFile), clock);
  supervisor.registerConnector(connector.spec);
  const evidence = ledger.appendEvent({ ts: clock.now().toISOString(), agent: "worker", kind: "observed", data: {}, wakeId: null });
  const requested = await supervisor.submitAction({ id: "a1", agent: "worker", kind: "mock.write", payload: {}, reason: "evidence", evidence: [evidence.seq], auditAdvice: null, adviceAcked: false }, "external");
  assert.equal(requested.status, "requested");
  await assert.rejects(() => supervisor.approveAction("a1", "human", "approved", [evidence.seq]), /injected connector crash/);
  await supervisor.recover();
  assert.equal(ledger.action("a1")?.status, "unknown");
  assert.equal((await supervisor.reconcileAction("a1")).status, "confirmed");
  assert.deepEqual(connector.dispatched, ["a1"]);
  supervisor.putAuditAdvice("a1", { by: "verifier", body: { issue: "review" }, evidence: [evidence.seq] });
  supervisor.createGoal(goal()); supervisor.planWake("worker", clock.now().toISOString(), "audit");
  await supervisor.tick();
  assert.equal((JSON.parse(readFileSync(contextFile, "utf8")) as { auditAdvice: unknown[] }).auditAdvice.length, 1);
  supervisor.ackAuditAdvice("a1", "worker");
  assert.equal(ledger.unackedAuditAdvice("worker").length, 0);
  ledger.close();
});

test("connector subprocess does not inherit ambient supervisor secrets", async () => {
  process.env.GOAH_AMBIENT_SECRET_TEST = "must-not-leak";
  try {
    const clock = new SimulatedClock();
    const ledger = createMemoryLedger({ clock });
    const supervisor = new Supervisor(ledger, fauxRunner([]), clock);
    supervisor.registerConnector({
      manifest: { contractVersion: CONTRACT_VERSION, connector: "isolated", dryRun: true, capabilities: [{ kind: "check.env", nativeIdempotency: true, query: "none", automaticRetry: false, risk: "reversible", constraints: {} }] },
      command: process.execPath,
      args: ["-e", "process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({status:process.env.GOAH_AMBIENT_SECRET_TEST?'failed':'confirmed'})))"],
    });
    const evidence = ledger.appendEvent({ ts: clock.now().toISOString(), agent: "worker", kind: "observed", data: {}, wakeId: null });
    const result = await supervisor.submitAction({ id: "env", agent: "worker", kind: "check.env", payload: {}, reason: "verify isolation", evidence: [evidence.seq], auditAdvice: null, adviceAcked: false }, "isolated");
    assert.equal(result.status, "confirmed");
    ledger.close();
  } finally {
    delete process.env.GOAH_AMBIENT_SECRET_TEST;
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("condition timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}
function fauxRunner(steps: unknown[], contextFile?: string): ProcessRunner {
  return new ProcessRunner({ command: process.execPath, args: [fauxRunnerWorkerPath()], env: { GOAH_FAUX_STEPS: JSON.stringify(steps), ...(contextFile ? { GOAH_FAUX_CONTEXT_FILE: contextFile } : {}) }, killGraceMs: 25 });
}
function git(cwd: string, args: string[]): string { const result = spawnSync("git", args, { cwd, encoding: "utf8" }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim(); }
