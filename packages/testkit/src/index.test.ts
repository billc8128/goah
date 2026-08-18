import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type { GoalSnapshot, WakeSnapshot } from "@goah/ledger-contract";
import { PiRunnerAdapter } from "@goah/runner-pi";
import { GitWorkspaceManager, Supervisor } from "@goah/supervisor";
import { createMemoryLedger, FauxPiDriver, MockConnector, SimulatedClock } from "./index.js";

const metric = {
  source: "test", window: "1h", direction: "at_least" as const, target: 1,
  freshnessMs: 60_000, onMissing: "abnormal" as const, onStale: "wake_owner" as const,
};

function repository(): string {
  const path = mkdtempSync(join(tmpdir(), "goah-workspace-"));
  git(path, ["init", "-b", "main"]);
  git(path, ["config", "user.email", "goah@example.test"]);
  git(path, ["config", "user.name", "GOAH Test"]);
  writeFileSync(join(path, "README.md"), "# artifact workspace\n");
  git(path, ["add", "README.md"]);
  git(path, ["commit", "-m", "initial"]);
  return path;
}

function goal(): GoalSnapshot {
  return { id: "root", parentId: null, objective: "produce a checked artifact", metric, target: 1, owner: "worker", budget: null, phase: "active", revision: 0 };
}

test("vertical slice: goal and schedule become a leased faux run, handoff, git commit and done wake", async () => {
  const repo = repository();
  const ledger = createMemoryLedger();
  const clock = new SimulatedClock();
  const driver = new FauxPiDriver(clock, [[
    { tokens: 100, write: { path: "artifact.txt", content: "verified\n" }, trace: [{ kind: "tool", data: { name: "write_artifact" } }] },
    { tokens: 50, handoff: { handoff: { observations: ["workspace clean"], results: ["artifact written"], nextSteps: ["check later"] }, mail: [], nextWakeAt: "2026-08-19T00:00:00.000Z" } },
  ]]);
  const supervisor = new Supervisor(ledger, new PiRunnerAdapter(driver), clock, { workspace: new GitWorkspaceManager(repo) });
  supervisor.createGoal(goal());
  ledger.putMail({ id: "mail-1", to: "worker", from: "human", level: "decision", body: { question: "run now" }, readAt: null }, "human");
  assert.ok(supervisor.planWake("worker", clock.now().toISOString(), "initial run"));
  const completed = await supervisor.tick();

  assert.equal(completed?.status, "done");
  assert.equal(readFileSync(join(repo, "artifact.txt"), "utf8"), "verified\n");
  assert.equal(ledger.schedules()[0]?.nextWakeAt, "2026-08-19T00:00:00.000Z");
  assert.ok(ledger.events().some((event) => event.kind === "handoff.recorded"));
  assert.equal((driver.requests[0]?.context as { mail: unknown[] }).mail.length, 1);
  assert.equal(ledger.mailbox()[0]?.readAt, clock.now().toISOString());
  const merged = ledger.events().find((event) => event.kind === "workspace.merged");
  assert.ok(merged);
  const sha = (merged.data as { commitSha: string }).commitSha;
  assert.equal(git(repo, ["rev-parse", "HEAD"]), sha);

  const projectionEvents = ledger.events().filter((event) => typeof event.data === "object" && event.data !== null && !Array.isArray(event.data) && "projection" in event.data);
  assert.ok(projectionEvents.some((event) => (event.data as { projection: string }).projection === "goals"));
  assert.ok(projectionEvents.some((event) => (event.data as { projection: string }).projection === "schedule"));
  assert.ok(projectionEvents.some((event) => (event.data as { projection: string }).projection === "wakes"));
  ledger.close();
});

test("agent crash records abnormal, preserves a salvage ref, and a recovery wake receives the event slice", async () => {
  const repo = repository();
  const ledger = createMemoryLedger();
  const clock = new SimulatedClock();
  const crashing = new FauxPiDriver(clock, [[
    { tokens: 100, write: { path: "partial.txt", content: "do not lose\n" } },
    { tokens: 10, crash: "injected agent crash" },
  ]]);
  const workspace = new GitWorkspaceManager(repo);
  const firstSupervisor = new Supervisor(ledger, new PiRunnerAdapter(crashing), clock, { workspace });
  firstSupervisor.createGoal(goal());
  firstSupervisor.planWake("worker", clock.now().toISOString(), "crash test");
  const abnormal = await firstSupervisor.tick();
  assert.equal(abnormal?.status, "abnormal");
  assert.equal(existsSync(join(repo, "partial.txt")), false);
  const salvage = ledger.events().find((event) => event.kind === "workspace.salvaged");
  assert.ok(salvage);
  const ref = (salvage.data as { ref: string }).ref;
  assert.equal(git(repo, ["show", `${ref}:partial.txt`]), "do not lose");

  const recovering = new FauxPiDriver(clock, [[
    { tokens: 20, handoff: { handoff: { observations: ["salvage present"], results: [], nextSteps: [] }, mail: [], nextWakeAt: null } },
  ]]);
  const recoveryWake: WakeSnapshot = {
    id: "recovery-wake", agent: "worker", triggerRef: `recovery:${abnormal.id}`,
    status: "queued", leaseUntil: null, attempt: 0, startedAt: null, endedAt: null,
  };
  ledger.enqueueWake(recoveryWake, "supervisor");
  const secondSupervisor = new Supervisor(ledger, new PiRunnerAdapter(recovering), clock, { workspace });
  assert.equal((await secondSupervisor.tick())?.status, "done");
  const context = recovering.requests[0]?.context as { recoveryEvents: unknown[] };
  assert.ok(context.recoveryEvents.length > 0);
  ledger.close();
});

test("supervisor crash recovers running wake as abnormal and salvages its worktree", async () => {
  const repo = repository();
  const ledger = createMemoryLedger();
  const clock = new SimulatedClock();
  const workspace = new GitWorkspaceManager(repo);
  const wake: WakeSnapshot = { id: "supervisor-crash", agent: "worker", triggerRef: "manual", status: "queued", leaseUntil: null, attempt: 0, startedAt: null, endedAt: null };
  ledger.enqueueWake(wake, "supervisor");
  ledger.claimNextWake(clock.now().toISOString(), new Date(clock.now().getTime() + 1_000).toISOString());
  const path = await workspace.prepare(wake);
  ledger.markWakeRunning(wake.id, clock.now().toISOString());
  writeFileSync(join(path, "supervisor-partial.txt"), "salvage me\n");
  clock.advance(2_000);

  const idle = new FauxPiDriver(clock, []);
  await new Supervisor(ledger, new PiRunnerAdapter(idle), clock, { workspace }).recover();
  assert.equal(ledger.wakes()[0]?.status, "abnormal");
  const event = ledger.events().findLast((item) => item.kind === "workspace.salvaged");
  assert.ok(event);
  assert.equal(git(repo, ["show", `${(event.data as { ref: string }).ref}:supervisor-partial.txt`]), "salvage me");
  ledger.close();
});

test("a real rebase conflict is merge_blocked and never overwrites the main artifact", async () => {
  const repo = repository();
  const ledger = createMemoryLedger();
  const clock = new SimulatedClock();
  const conflicting = new FauxPiDriver(clock, [[
    {
      tokens: 50,
      write: { path: "README.md", content: "worker change\n" },
      effect: () => {
        writeFileSync(join(repo, "README.md"), "main change\n");
        git(repo, ["add", "README.md"]);
        git(repo, ["commit", "-m", "concurrent main change"]);
      },
    },
    { tokens: 20, handoff: { handoff: { observations: [], results: ["changed README"], nextSteps: [] }, mail: [], nextWakeAt: null } },
  ]]);
  const supervisor = new Supervisor(ledger, new PiRunnerAdapter(conflicting), clock, { workspace: new GitWorkspaceManager(repo) });
  supervisor.createGoal(goal());
  supervisor.planWake("worker", clock.now().toISOString(), "conflict test");
  const result = await supervisor.tick();
  assert.equal(result?.status, "merge_blocked");
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "main change\n");
  assert.ok(ledger.events().some((event) => event.kind === "workspace.merge_blocked"));
  assert.equal(git(repo, ["show", `goah/wake-${result?.id}:README.md`]), "worker change");
  ledger.close();
});

test("connector crash is not replayed: dispatching becomes unknown and query reconciles it", async () => {
  const ledger = createMemoryLedger();
  const clock = new SimulatedClock();
  const connector = new MockConnector();
  connector.failAfterEffect = true;
  const supervisor = new Supervisor(ledger, new PiRunnerAdapter(new FauxPiDriver(clock, [])), clock);
  supervisor.registerConnector(connector);
  const evidence = ledger.appendEvent({ ts: clock.now().toISOString(), agent: "worker", kind: "observed", data: {}, wakeId: null });

  await assert.rejects(() => supervisor.submitAction({
    id: "action-1", agent: "worker", kind: "mock.write", payload: { value: 1 }, reason: "observed state requires it",
    evidence: [evidence.seq], auditAdvice: null, adviceAcked: false,
  }, "mock"), /injected connector crash/);
  assert.equal(ledger.actions()[0]?.status, "dispatching");
  await supervisor.recover();
  assert.equal(ledger.actions()[0]?.status, "unknown");
  const reconciled = await supervisor.reconcileAction("action-1", "mock");
  assert.equal(reconciled.status, "confirmed");
  assert.equal(reconciled.reconciledAt, clock.now().toISOString());
  assert.deepEqual(connector.dispatched, ["action-1"]);

  const closed = await supervisor.submitAction({
    id: "undeclared", agent: "worker", kind: "unknown.capability", payload: {}, reason: "test fail closed",
    evidence: [evidence.seq], auditAdvice: null, adviceAcked: false,
  }, "missing");
  assert.equal(closed.gated, true);
  assert.equal(closed.status, "requested");

  const external = new MockConnector("external");
  external.manifest.dryRun = false;
  supervisor.registerConnector(external);
  const externalAction = await supervisor.submitAction({
    id: "external-default-closed", agent: "worker", kind: "mock.write", payload: {}, reason: "external test",
    evidence: [evidence.seq], auditAdvice: null, adviceAcked: false,
  }, "external");
  assert.equal(externalAction.gated, true);
  assert.deepEqual(external.dispatched, []);
  ledger.close();
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
