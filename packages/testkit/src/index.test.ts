import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { CONTRACT_VERSION, type GoalSnapshot, type WakeSnapshot } from "@goah/ledger-contract";
import { piWorkerPath, ProcessRunner, verificationWorkerPath } from "@goah/runner-pi";
import { calibrateVerificationThreshold, evaluateVerification, GitWorkspaceManager, ProcessVerifierModel, renderDashboard, runSupervisorDaemon, Supervisor, VerificationPlane, type VerifierModel } from "@goah/supervisor";
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

test("schedule, mail, metric, and heartbeat triggers are durable and coalesced", async () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const supervisor = new Supervisor(ledger, fauxRunner([{ tokens: 5, handoff: { handoff: { observations: [], results: [], nextSteps: [] }, mail: [], nextWakeAt: null } }]), clock, {
    heartbeatPolicies: [{ agent: "silent", maxSilentMs: 100, escalateTo: "ceo", since: new Date(clock.now().getTime() - 1_000).toISOString() }],
  });
  supervisor.createGoal(goal());
  ledger.putMail({ id: "decision", to: "worker", from: "human", level: "decision", body: {}, readAt: null }, "human");
  supervisor.planWake("worker", clock.now().toISOString(), "scheduled");
  const evaluation = supervisor.recordMetric({ goalId: "root", source: "test", observedAt: clock.now().toISOString(), value: 0 });
  assert.equal(evaluation.status, "missed");
  await supervisor.tick();
  assert.equal(ledger.wakes().filter((wake) => wake.agent === "worker").length, 1);
  assert.equal(ledger.wakes().some((wake) => wake.agent === "ceo" && wake.status === "queued"), true);
  assert.equal(ledger.events().some((event) => event.kind === "wake.trigger_coalesced"), true);
  assert.equal(ledger.events().some((event) => event.kind === "watchdog.heartbeat_violation"), true);
  ledger.close();
});

test("verification plane enforces blind-first audit and reports calibrated metrics", async () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const supervisor = new Supervisor(ledger, fauxRunner([]), clock);
  supervisor.createGoal(goal());
  const evidence = ledger.appendEvent({ ts: clock.now().toISOString(), agent: "worker", kind: "tool.fact", data: { value: 1 }, wakeId: "w" });
  ledger.requestAction({ id: "a", agent: "worker", kind: "mock.write", connector: "mock", payload: {}, reason: "private rationale", evidence: [evidence.seq], gated: false, status: "requested", reconciledAt: null, externalRef: null, auditAdvice: null, adviceAcked: false }, "worker", "w");
  ledger.appendEvent({ ts: clock.now().toISOString(), agent: "worker", kind: "handoff.recorded", data: { results: ["claimed"] }, wakeId: "w" });
  let blindPayload = "";
  const model: VerifierModel = {
    verifySession: async () => ({ findings: [{ actionId: "a", body: { issue: "unsupported" }, evidence: [evidence.seq], riskWeight: 2 }], tokensUsed: 10 }),
    blindAudit: async (facts) => { blindPayload = JSON.stringify(facts); return { findings: [], tokensUsed: 5 }; },
    reasonAudit: async () => ({ findings: [], tokensUsed: 5 }),
  };
  const plane = new VerificationPlane(ledger, supervisor, model);
  await plane.verifySession("w");
  assert.equal(ledger.unackedAuditAdvice("worker").length, 1);
  await plane.auditGlobal();
  assert.doesNotMatch(blindPayload, /private rationale|claimed/);
  assert.deepEqual(evaluateVerification([
    { id: "high", shouldFlag: true, riskWeight: 9 },
    { id: "low", shouldFlag: true, riskWeight: 1 },
    { id: "ok", shouldFlag: false, riskWeight: 1 },
  ], ["high", "ok"]), { precision: 0.5, riskWeightedRecall: 0.9 });
  assert.equal(calibrateVerificationThreshold([
    { id: "high", shouldFlag: true, riskWeight: 9 }, { id: "low", shouldFlag: true, riskWeight: 1 }, { id: "ok", shouldFlag: false, riskWeight: 1 },
  ], [{ id: "high", score: 0.9 }, { id: "low", score: 0.4 }, { id: "ok", score: 0.6 }], 0.9), 0.9);
  ledger.close();
});

test("two agents run concurrently while CEO context and dashboard see the organization", async () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const runner = fauxRunner([{ tokens: 5, delayMs: 50 }, { tokens: 5, handoff: { handoff: { observations: [], results: ["done"], nextSteps: [] }, mail: [], nextWakeAt: null } }]);
  const supervisor = new Supervisor(ledger, runner, clock, { profiles: [{ agent: "ceo", role: "ceo" }, { agent: "a", role: "child" }, { agent: "b", role: "child" }] });
  ledger.putGoal({ id: "root", parentId: null, objective: "organization", metric, target: 1, owner: "ceo", budget: null, phase: "active", revision: 0 }, "human");
  ledger.putGoal({ id: "a-goal", parentId: "root", objective: "a", metric, target: 1, owner: "a", budget: null, phase: "active", revision: 0 }, "ceo");
  ledger.putGoal({ id: "b-goal", parentId: "root", objective: "b", metric, target: 1, owner: "b", budget: null, phase: "active", revision: 0 }, "ceo");
  supervisor.planWake("a", clock.now().toISOString(), "a");
  supervisor.planWake("b", clock.now().toISOString(), "b");
  const completed = await supervisor.runAvailable(2);
  assert.deepEqual(completed.map((wake) => wake.agent).sort(), ["a", "b"]);
  assert.match(renderDashboard(ledger), /organization/);

  const ceoContext = join(mkdtempSync(join(tmpdir(), "goah-context-")), "context.json");
  const ceoSupervisor = new Supervisor(ledger, fauxRunner([{ tokens: 5, handoff: { handoff: { observations: [], results: [], nextSteps: [] }, mail: [], nextWakeAt: null } }], ceoContext), clock, { profiles: [{ agent: "ceo", role: "ceo" }] });
  ceoSupervisor.planWake("ceo", clock.now().toISOString(), "replan");
  await ceoSupervisor.tick();
  assert.equal((JSON.parse(readFileSync(ceoContext, "utf8")) as { goals: unknown[] }).goals.length, 3);

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await runSupervisorDaemon(supervisor, { pollMs: 5, concurrency: 2, signal: controller.signal });
  ledger.close();
});

test("accelerated 30-day soak keeps wake context bounded and projections replayable", async () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const contextFile = join(mkdtempSync(join(tmpdir(), "goah-soak-")), "context.json");
  const supervisor = new Supervisor(ledger, fauxRunner([{ tokens: 2, handoff: { handoff: { observations: ["healthy"], results: [], nextSteps: [] }, mail: [], nextWakeAt: null } }], contextFile), clock);
  supervisor.createGoal(goal());
  for (let day = 0; day < 30; day += 1) {
    supervisor.planWake("worker", clock.now().toISOString(), `day-${day}`);
    assert.equal((await supervisor.tick())?.status, "done");
    assert.ok(readFileSync(contextFile).byteLength < 20_000);
    clock.advance(86_400_000);
  }
  assert.equal(ledger.wakes().filter((wake) => wake.status === "done").length, 30);
  const before = JSON.stringify({ goals: ledger.goals(), wakes: ledger.wakes(), schedules: ledger.schedules() });
  ledger.rebuildProjections();
  assert.equal(JSON.stringify({ goals: ledger.goals(), wakes: ledger.wakes(), schedules: ledger.schedules() }), before);
  ledger.close();
});

test("official Pi agent core worker completes a structured handoff through the process boundary", async () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const runner = new ProcessRunner({ command: process.execPath, args: [piWorkerPath()], env: {
    GOAH_PI_PROVIDER: "faux",
    GOAH_PI_MODEL: "faux-goah",
    GOAH_PI_COMPACT_AT_TOKENS: "1",
    GOAH_PI_FAUX_HANDOFF: JSON.stringify({ observations: ["pi core ran"], results: ["ok"], nextSteps: [] }),
  } });
  const supervisor = new Supervisor(ledger, runner, clock);
  supervisor.createGoal(goal()); supervisor.planWake("worker", clock.now().toISOString(), "pi integration");
  assert.equal((await supervisor.tick())?.status, "done");
  assert.equal(ledger.events().some((event) => event.kind.startsWith("runner.pi.")), true);
  assert.equal(ledger.events().some((event) => event.kind === "runner.context.compacted"), true);
  assert.deepEqual(ledger.lastEvent("worker", "handoff.recorded")?.data, { observations: ["pi core ran"], results: ["ok"], nextSteps: [] });
  ledger.close();
});

test("bidirectional runner RPC applies child capabilities and rejects parent-only goal writes", async () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const connector = new MockConnector();
  const seed = ledger.appendEvent({ ts: clock.now().toISOString(), agent: "worker", kind: "fact", data: { text: "rpcseed" }, wakeId: null });
  const runner = fauxRunner([
    { tokens: 1, rpc: { method: "ledger.search", params: { query: "rpcseed" } } },
    { tokens: 1, rpc: { method: "budget.read", params: {} } },
    { tokens: 1, rpc: { method: "mail.send", params: { to: "human", level: "fyi", body: { message: "working" } } } },
    { tokens: 1, rpc: { method: "schedule.set", params: { at: "2026-08-20T00:00:00.000Z", reason: "continue" } } },
    { tokens: 1, rpc: { method: "action.submit", params: { id: "rpc-action", kind: "mock.write", connector: "mock", payload: {}, reason: "seed supports it", evidence: [seed.seq] } } },
    { tokens: 1, handoff: { handoff: { observations: [], results: [], nextSteps: [] }, mail: [], nextWakeAt: null } },
  ]);
  const supervisor = new Supervisor(ledger, runner, clock, { profiles: [{ agent: "worker", role: "child" }] });
  supervisor.registerConnector(connector.spec);
  supervisor.createGoal(goal()); supervisor.planWake("worker", clock.now().toISOString(), "rpc");
  assert.equal((await supervisor.tick())?.status, "done");
  assert.equal(ledger.action("rpc-action")?.status, "confirmed");
  assert.equal(ledger.mailbox().some((mail) => mail.to === "human"), true);
  assert.equal(ledger.schedules()[0]?.nextWakeAt, "2026-08-20T00:00:00.000Z");
  assert.equal(ledger.events().filter((event) => event.kind.startsWith("rpc.")).length, 5);

  const denied = new Supervisor(ledger, fauxRunner([{ tokens: 1, rpc: { method: "goal.put", params: { goal: { ...goal(), revision: 1 } } } }]), clock, { profiles: [{ agent: "worker", role: "child" }] });
  clock.advance(1);
  denied.planWake("worker", clock.now().toISOString(), "denied");
  assert.equal((await denied.tick())?.status, "abnormal");
  assert.equal(ledger.goal("root")?.revision, 0);
  ledger.close();
});

test("CEO role can create a child goal and receives its dedicated system prompt", async () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const root = { id: "ceo-root", parentId: null, objective: "build organization", metric, target: 1, owner: "ceo", budget: null, phase: "active", revision: 0 } as const;
  const child = { id: "child", parentId: "ceo-root", objective: "own metric", metric, target: 1, owner: "worker", budget: null, phase: "active", revision: 0 } as const;
  const contextFile = join(mkdtempSync(join(tmpdir(), "goah-ceo-")), "context.json");
  const supervisor = new Supervisor(ledger, fauxRunner([
    { tokens: 1, rpc: { method: "goal.put", params: { goal: child } } },
    { tokens: 1, handoff: { handoff: { observations: [], results: ["delegated"], nextSteps: [] }, mail: [], nextWakeAt: null } },
  ], contextFile), clock, { profiles: [{ agent: "ceo", role: "ceo" }] });
  ledger.putGoal(root, "human"); supervisor.planWake("ceo", clock.now().toISOString(), "replan");
  assert.equal((await supervisor.tick())?.status, "done");
  assert.equal(ledger.goal("child")?.owner, "worker");
  assert.match((JSON.parse(readFileSync(contextFile, "utf8")) as { systemPrompt: string }).systemPrompt, /goal tree/i);
  ledger.close();
});

test("process verifier model runs on official Pi core and writes advice", async () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const supervisor = new Supervisor(ledger, fauxRunner([]), clock);
  supervisor.createGoal(goal());
  const evidence = ledger.appendEvent({ ts: clock.now().toISOString(), agent: "worker", kind: "fact", data: {}, wakeId: "verify-wake" });
  ledger.requestAction({ id: "verify-action", agent: "worker", kind: "mock", connector: "mock", payload: {}, reason: "r", evidence: [evidence.seq], gated: false, status: "requested", reconciledAt: null, externalRef: null, auditAdvice: null, adviceAcked: false }, "worker", "verify-wake");
  const model = new ProcessVerifierModel({ command: process.execPath, args: [verificationWorkerPath()], env: { GOAH_PI_PROVIDER: "faux", GOAH_PI_MODEL: "faux-verifier", GOAH_VERIFIER_FAUX_FINDINGS: JSON.stringify([{ actionId: "verify-action", body: { issue: "found" }, evidence: [evidence.seq], riskWeight: 3 }]) } });
  await new VerificationPlane(ledger, supervisor, model).verifySession("verify-wake");
  assert.equal(ledger.unackedAuditAdvice("worker").length, 1);
  ledger.close();
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("condition timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}
function fauxRunner(steps: unknown[], contextFile?: string): ProcessRunner {
  return new ProcessRunner({ command: process.execPath, args: [fauxRunnerWorkerPath()], env: { GOAH_FAUX_STEPS: JSON.stringify(steps), ...(contextFile ? { GOAH_FAUX_CONTEXT_FILE: contextFile } : {}) }, killGraceMs: 25 });
}
function git(cwd: string, args: string[]): string { const result = spawnSync("git", args, { cwd, encoding: "utf8" }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim(); }
