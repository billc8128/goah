import assert from "node:assert/strict";
import test from "node:test";
import type { ActionSnapshot, GoalSnapshot, WakeSnapshot } from "@goah/ledger-contract";
import { SqliteLedger } from "./index.js";

const metric = {
  source: "test", window: "1h", direction: "at_least" as const, target: 1,
  freshnessMs: 60_000, onMissing: "abnormal" as const, onStale: "wake_owner" as const,
};

function wake(id: string, agent = "agent-1"): WakeSnapshot {
  return { id, agent, triggerRef: `trigger:${id}`, status: "queued", leaseUntil: null, attempt: 0, startedAt: null, endedAt: null };
}

test("event and projection rollback together at the injected transaction boundary", () => {
  const ledger = new SqliteLedger(":memory:", { faultInjector: () => { throw new Error("kill -9"); } });
  assert.throws(() => ledger.putSchedule({ id: "s1", agent: "a", nextWakeAt: "2026-08-18T00:00:00.000Z", reason: "test", setBy: "a" }, "a"), /kill -9/);
  assert.deepEqual(ledger.events(), []);
  assert.deepEqual(ledger.schedules(), []);
  ledger.close();
});

test("schema has events plus exactly five rebuildable projections", () => {
  const ledger = new SqliteLedger();
  const tables = (ledger.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name);
  assert.deepEqual(tables, ["actions", "events", "goals", "mailbox", "schedule", "wakes"]);

  const root: GoalSnapshot = { id: "root", parentId: null, objective: "keep tests green", metric, target: 1, owner: "agent-1", budget: null, phase: "active", revision: 0 };
  ledger.putGoal(root, "human");
  ledger.putSchedule({ id: "s1", agent: "agent-1", nextWakeAt: "2026-08-18T00:00:00.000Z", reason: "start", setBy: "agent-1" }, "agent-1");
  ledger.enqueueWake(wake("w1"), "supervisor");
  ledger.putMail({ id: "m1", to: "agent-1", from: "human", level: "decision", body: { question: "continue?" }, readAt: null }, "human");
  const evidence = ledger.appendEvent({ ts: "2026-08-18T00:00:00.000Z", agent: "agent-1", kind: "observed", data: {}, wakeId: null });
  ledger.requestAction({ id: "a1", agent: "agent-1", kind: "mock.write", payload: {}, reason: "test evidence", evidence: [evidence.seq], gated: false, status: "requested", reconciledAt: null, externalRef: null, auditAdvice: null, adviceAcked: false });
  const before = { goals: ledger.goals(), schedules: ledger.schedules(), wakes: ledger.wakes(), mailbox: ledger.mailbox(), actions: ledger.actions() };
  ledger.rebuildProjections();
  assert.deepEqual({ goals: ledger.goals(), schedules: ledger.schedules(), wakes: ledger.wakes(), mailbox: ledger.mailbox(), actions: ledger.actions() }, before);
  assert.throws(() => ledger.db.prepare("DELETE FROM events").run(), /append-only/);
  ledger.close();
});

test("every wake mutation rolls back both event and projection when killed between them", () => {
  const cases: Array<{ name: string; setup(ledger: SqliteLedger): void; mutate(ledger: SqliteLedger): void }> = [
    { name: "enqueue", setup: () => undefined, mutate: (ledger) => { ledger.enqueueWake(wake("w"), "supervisor"); } },
    { name: "lease", setup: (ledger) => { ledger.enqueueWake(wake("w"), "supervisor"); }, mutate: (ledger) => { ledger.claimNextWake("2026-08-18T00:00:00.000Z", "2026-08-18T00:00:10.000Z"); } },
    { name: "running", setup: (ledger) => { ledger.enqueueWake(wake("w"), "supervisor"); ledger.claimNextWake("2026-08-18T00:00:00.000Z", "2026-08-18T00:00:10.000Z"); }, mutate: (ledger) => { ledger.markWakeRunning("w", "2026-08-18T00:00:01.000Z"); } },
    { name: "done", setup: (ledger) => { ledger.enqueueWake(wake("w"), "supervisor"); ledger.claimNextWake("2026-08-18T00:00:00.000Z", "2026-08-18T00:00:10.000Z"); ledger.markWakeRunning("w", "2026-08-18T00:00:01.000Z"); }, mutate: (ledger) => { ledger.finishWake("w", "done", "2026-08-18T00:00:02.000Z"); } },
    { name: "expired lease", setup: (ledger) => { ledger.enqueueWake(wake("w"), "supervisor"); ledger.claimNextWake("2026-08-18T00:00:00.000Z", "2026-08-18T00:00:10.000Z"); }, mutate: (ledger) => { ledger.recoverExpiredWakes("2026-08-18T00:00:11.000Z"); } },
    { name: "expired running", setup: (ledger) => { ledger.enqueueWake(wake("w"), "supervisor"); ledger.claimNextWake("2026-08-18T00:00:00.000Z", "2026-08-18T00:00:10.000Z"); ledger.markWakeRunning("w", "2026-08-18T00:00:01.000Z"); }, mutate: (ledger) => { ledger.recoverExpiredWakes("2026-08-18T00:00:11.000Z"); } },
  ];
  for (const item of cases) {
    let armed = false;
    const ledger = new SqliteLedger(":memory:", { faultInjector: () => { if (armed) throw new Error(`kill at ${item.name}`); } });
    item.setup(ledger);
    const beforeEvents = ledger.events();
    const beforeWakes = ledger.wakes();
    armed = true;
    assert.throws(() => item.mutate(ledger), /kill at/);
    assert.deepEqual(ledger.events(), beforeEvents, item.name);
    assert.deepEqual(ledger.wakes(), beforeWakes, item.name);
    ledger.close();
  }
});

test("every action mutation rolls back both event and projection when killed between them", () => {
  let requestArmed = false;
  const requestLedger = new SqliteLedger(":memory:", { faultInjector: () => { if (requestArmed) throw new Error("kill at requested"); } });
  const requestEvidence = requestLedger.appendEvent({ ts: "2026-08-18T00:00:00.000Z", agent: "a", kind: "observed", data: {}, wakeId: null });
  requestArmed = true;
  assert.throws(() => requestLedger.requestAction({ id: "a", agent: "a", kind: "mock.write", payload: {}, reason: "evidence", evidence: [requestEvidence.seq], gated: false, status: "requested", reconciledAt: null, externalRef: null, auditAdvice: null, adviceAcked: false }), /kill at requested/);
  assert.equal(requestLedger.actions().length, 0);
  assert.equal(requestLedger.events().length, 1);
  requestLedger.close();

  const finalStates = ["approved", "dispatching", "unknown", "confirmed", "failed"] as const;
  for (const target of finalStates) {
    let armed = false;
    const ledger = new SqliteLedger(":memory:", { faultInjector: () => { if (armed) throw new Error(`kill at ${target}`); } });
    const evidence = ledger.appendEvent({ ts: "2026-08-18T00:00:00.000Z", agent: "a", kind: "observed", data: {}, wakeId: null });
    ledger.requestAction({ id: "a", agent: "a", kind: "mock.write", payload: {}, reason: "evidence", evidence: [evidence.seq], gated: false, status: "requested", reconciledAt: null, externalRef: null, auditAdvice: null, adviceAcked: false });
    if (target !== "approved") ledger.transitionAction("a", "approved");
    if (target === "unknown" || target === "confirmed" || target === "failed") ledger.transitionAction("a", "dispatching");
    const beforeEvents = ledger.events();
    const beforeActions = ledger.actions();
    armed = true;
    const mutate = () => target === "unknown"
      ? ledger.recoverDispatchingActions()
      : ledger.transitionAction("a", target);
    assert.throws(mutate, /kill at/);
    assert.deepEqual(ledger.events(), beforeEvents, target);
    assert.deepEqual(ledger.actions(), beforeActions, target);
    ledger.close();
  }
});

test("wake dedupe, per-agent concurrency and lease recovery are mechanical", () => {
  const ledger = new SqliteLedger();
  assert.equal(ledger.enqueueWake(wake("w1"), "supervisor").created, true);
  assert.equal(ledger.enqueueWake({ ...wake("duplicate"), triggerRef: "trigger:w1" }, "supervisor").created, false);
  ledger.enqueueWake(wake("w2"), "supervisor");
  const first = ledger.claimNextWake("2026-08-18T00:00:00.000Z", "2026-08-18T00:00:10.000Z");
  assert.equal(first?.id, "w1");
  assert.equal(ledger.claimNextWake("2026-08-18T00:00:00.000Z", "2026-08-18T00:00:10.000Z"), null);
  const recovered = ledger.recoverExpiredWakes("2026-08-18T00:00:11.000Z");
  assert.equal(recovered.requeued[0]?.id, "w1");
  assert.equal(ledger.claimNextWake("2026-08-18T00:00:11.000Z", "2026-08-18T00:00:20.000Z")?.id, "w1");
  ledger.markWakeRunning("w1", "2026-08-18T00:00:11.000Z");
  const crashed = ledger.recoverExpiredWakes("2026-08-18T00:00:21.000Z");
  assert.equal(crashed.abnormal[0]?.status, "abnormal");
  assert.equal(ledger.claimNextWake("2026-08-18T00:00:21.000Z", "2026-08-18T00:00:30.000Z")?.id, "w2");
  ledger.close();
});

test("dispatching crash becomes unknown and reconciliation time cannot be forged", () => {
  const ledger = new SqliteLedger();
  const evidence = ledger.appendEvent({ ts: "2026-08-18T00:00:00.000Z", agent: "a", kind: "observed", data: {}, wakeId: null });
  const action: ActionSnapshot = {
    id: "action-1", agent: "a", kind: "mock.write", payload: {}, reason: "evidence supports it",
    evidence: [evidence.seq], gated: false, status: "requested", reconciledAt: null, externalRef: null,
    auditAdvice: null, adviceAcked: false,
  };
  ledger.requestAction(action);
  ledger.transitionAction(action.id, "approved");
  ledger.transitionAction(action.id, "dispatching");
  assert.equal(ledger.recoverDispatchingActions()[0]?.status, "unknown");
  assert.throws(() => ledger.transitionAction(action.id, "confirmed"), /reconciliation/);
  const reconciled = ledger.transitionAction(action.id, "confirmed", { reconciledAt: "2026-08-18T00:01:00.000Z" });
  assert.equal(reconciled.reconciledAt, "2026-08-18T00:01:00.000Z");
  ledger.close();
});
