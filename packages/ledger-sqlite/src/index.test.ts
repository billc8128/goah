import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ActionSnapshot, Clock, GoalSnapshot, WakeSnapshot } from "goah-ledger-contract";
import { SqliteLedger } from "./index.js";

const metric = { source: "test", window: "1h", direction: "at_least" as const, target: 1, freshnessMs: 60_000, onMissing: "abnormal" as const, onStale: "wake_owner" as const };
class FixedClock implements Clock { constructor(readonly value = "2030-01-01T00:00:00.000Z") {} now(): Date { return new Date(this.value); } }
function wake(id: string, agent = "agent-1"): WakeSnapshot { return { id, agent, triggerRef: `trigger:${id}`, status: "queued", leaseUntil: null, attempt: 0, startedAt: null, endedAt: null, enqueuedSeq: 0, leaseToken: null, runnerPid: null }; }
function action(id: string, evidence: number[]): ActionSnapshot { return { id, agent: "a", kind: "mock.write", connector: "mock", payload: {}, reason: "evidence supports it", evidence, gated: false, status: "requested", reconciledAt: null, externalRef: null, auditAdvice: null, adviceAcked: false }; }

test("event and projection roll back together at the injected transaction boundary", () => {
  const ledger = new SqliteLedger(":memory:", { faultInjector: () => { throw new Error("kill -9"); }, clock: new FixedClock() });
  assert.throws(() => ledger.putSchedule({ id: "s1", agent: "a", nextWakeAt: "2030-01-01T00:00:00.000Z", reason: "test", setBy: "a" }, "a"), /kill -9/);
  assert.deepEqual(ledger.events(), []);
  assert.deepEqual(ledger.schedules(), []);
  ledger.close();
});

test("schema has events plus five projections and replay reproduces all of them", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  const tables = (ledger.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('actions','events','goals','mailbox','schedule','wakes') ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name);
  assert.deepEqual(tables, ["actions", "events", "goals", "mailbox", "schedule", "wakes"]);
  const root: GoalSnapshot = { id: "root", parentId: null, objective: "keep tests green", metric, target: 1, owner: "agent-1", phase: "active", revision: 0 };
  ledger.putGoal(root, "human");
  ledger.putSchedule({ id: "s1", agent: "agent-1", nextWakeAt: "2030-01-01T00:00:00.000Z", reason: "start", setBy: "agent-1" }, "agent-1");
  ledger.enqueueWake(wake("w1"), "supervisor");
  ledger.putMail({ id: "m1", to: "agent-1", from: "human", level: "decision", body: {}, readAt: null }, "human");
  const evidence = ledger.appendEvent({ ts: "2030-01-01T00:00:00.000Z", agent: "a", kind: "observed", data: {}, wakeId: null });
  ledger.requestAction(action("a1", [evidence.seq]), "a");
  const before = JSON.stringify({ goals: ledger.goals(), schedules: ledger.schedules(), wakes: ledger.wakes(), mailbox: ledger.mailbox(), actions: ledger.actions() });
  ledger.rebuildProjections();
  assert.equal(JSON.stringify({ goals: ledger.goals(), schedules: ledger.schedules(), wakes: ledger.wakes(), mailbox: ledger.mailbox(), actions: ledger.actions() }), before);
  assert.throws(() => ledger.db.prepare("DELETE FROM events").run(), /append-only/);
  ledger.close();
});

test("wake queue is FIFO, deduplicated, fenced and safely recovered", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  ledger.enqueueWake(wake("zzz", "a"), "supervisor");
  ledger.enqueueWake(wake("aaa", "b"), "supervisor");
  assert.equal(ledger.enqueueWake({ ...wake("duplicate", "a"), triggerRef: "trigger:zzz" }, "supervisor").created, false);
  ledger.appendEvent({ ts: "2030-01-01T00:00:00.000Z", agent: "supervisor", kind: "wake.trigger_coalesced", data: { wakeId: "zzz", triggerRef: "trigger:alias" }, wakeId: "zzz" });
  assert.equal(ledger.wakeByTrigger("a", "trigger:alias")?.id, "zzz");
  assert.equal(ledger.enqueueWake({ ...wake("alias", "a"), triggerRef: "trigger:alias" }, "supervisor").created, false);
  const first = ledger.claimNextWake("2030-01-01T00:00:00.000Z", "2030-01-01T00:00:10.000Z", "lease-1");
  assert.equal(first?.id, "zzz");
  ledger.markWakeRunning("zzz", "2030-01-01T00:00:01.000Z", "lease-1");
  assert.throws(() => ledger.appendRunnerEvent({ ts: "2030-01-01T00:00:02.000Z", agent: "a", kind: "trace", data: {}, wakeId: "zzz" }, "stale"), /stale/);
  const expired = ledger.expiredWakes("2030-01-01T00:00:11.000Z");
  assert.equal(expired[0]?.id, "zzz");
  assert.equal(ledger.recoverExpiredWake("zzz", "2030-01-01T00:00:11.000Z").status, "abnormal");
  assert.equal(ledger.claimNextWake("2030-01-01T00:00:11.000Z", "2030-01-01T00:00:20.000Z", "lease-2")?.id, "aaa");
  ledger.close();
});

test("actions require real evidence and support approval plus audit delivery", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  assert.throws(() => ledger.requestAction(action("bad", [999_999]), "a"), /does not exist/);
  const evidence = ledger.appendEvent({ ts: "2030-01-01T00:00:00.000Z", agent: "a", kind: "observed", data: {}, wakeId: null });
  ledger.requestAction(action("a1", [evidence.seq]), "a");
  assert.throws(() => ledger.requestAction(action("spoof", [evidence.seq]), "other"), /actor/);
  assert.equal(ledger.approveAction("a1", "human", "approved", [evidence.seq]).status, "approved");
  ledger.transitionAction("a1", "dispatching");
  assert.equal(ledger.recoverDispatchingActions()[0]?.status, "unknown");
  assert.throws(() => ledger.transitionAction("a1", "confirmed"), /reconciliation/);
  ledger.transitionAction("a1", "confirmed", { reconciledAt: "2030-01-01T00:01:00.000Z" });
  ledger.putAuditAdvice("a1", { by: "verifier", body: { issue: "check" }, evidence: [evidence.seq] });
  assert.equal(ledger.unackedAuditAdvice("a").length, 1);
  ledger.ackAuditAdvice("a1", "a");
  assert.equal(ledger.unackedAuditAdvice("a").length, 0);
  ledger.close();
});

test("mail is acknowledged only by an atomic successful handoff", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  ledger.enqueueWake(wake("w"), "supervisor");
  ledger.claimNextWake("2030-01-01T00:00:00.000Z", "2030-01-01T00:01:00.000Z", "lease");
  ledger.markWakeRunning("w", "2030-01-01T00:00:01.000Z", "lease");
  ledger.putMail({ id: "m", to: "agent-1", from: "human", level: "emergency", body: {}, readAt: null }, "human");
  assert.equal(ledger.unreadMail("agent-1").length, 1);
  ledger.commitHandoff({ agent: "agent-1", wakeId: "w", ts: "2030-01-01T00:00:02.000Z", output: { handoff: { observations: [], results: [], nextSteps: [] }, mail: [], nextWakeAt: null }, outgoingMail: [], schedule: null });
  assert.equal(ledger.unreadMail("agent-1").length, 0);
  ledger.close();
});

test("handoff event and mail acknowledgement roll back together", () => {
  let armed = false;
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock(), faultInjector: () => { if (armed) throw new Error("kill during handoff"); } });
  ledger.enqueueWake(wake("w"), "supervisor");
  ledger.claimNextWake("2030-01-01T00:00:00.000Z", "2030-01-01T00:01:00.000Z", "lease");
  ledger.markWakeRunning("w", "2030-01-01T00:00:01.000Z", "lease");
  ledger.putMail({ id: "m", to: "agent-1", from: "human", level: "emergency", body: {}, readAt: null }, "human");
  const before = JSON.stringify(ledger.events());
  armed = true;
  assert.throws(() => ledger.commitHandoff({ agent: "agent-1", wakeId: "w", ts: "2030-01-01T00:00:02.000Z", output: { handoff: { observations: [], results: [], nextSteps: [] }, mail: [], nextWakeAt: null }, outgoingMail: [], schedule: null }), /kill during handoff/);
  assert.equal(JSON.stringify(ledger.events()), before);
  assert.equal(ledger.unreadMail("agent-1").length, 1);
  ledger.close();
});

test("injected clock is authoritative and newer schemas are rejected", () => {
  const clock = new FixedClock("2020-01-01T00:00:00.000Z");
  const ledger = new SqliteLedger(":memory:", { clock });
  assert.equal(ledger.putSchedule({ id: "s", agent: "a", nextWakeAt: clock.value, reason: "r", setBy: "a" }, "a").ts, clock.value);
  assert.equal((ledger.db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout, 5_000);
  ledger.close();

  const path = join(mkdtempSync(join(tmpdir(), "goah-schema-")), "ledger.sqlite");
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA user_version=99");
  raw.close();
  assert.throws(() => new SqliteLedger(path), /newer than supported/);
});

test("schema v1 is migrated without rewriting event history", () => {
  const path = join(mkdtempSync(join(tmpdir(), "goah-v1-")), "ledger.sqlite");
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,ts TEXT,agent TEXT,kind TEXT,data TEXT,wake_id TEXT);
    CREATE TABLE goals(id TEXT PRIMARY KEY,parent_id TEXT,objective TEXT,metric TEXT,target TEXT,owner TEXT,budget TEXT,phase TEXT,revision INTEGER);
    CREATE TABLE schedule(id TEXT PRIMARY KEY,agent TEXT,next_wake_at TEXT,reason TEXT,set_by TEXT);
    CREATE TABLE mailbox(id TEXT PRIMARY KEY,to_agent TEXT,from_agent TEXT,level TEXT,body TEXT,read_at TEXT);
    CREATE TABLE wakes(id TEXT PRIMARY KEY,agent TEXT,trigger_ref TEXT,status TEXT,lease_until TEXT,attempt INTEGER,started_at TEXT,ended_at TEXT);
    CREATE TABLE actions(id TEXT PRIMARY KEY,agent TEXT,kind TEXT,payload TEXT,reason TEXT,evidence TEXT,gated INTEGER,status TEXT,reconciled_at TEXT,external_ref TEXT,audit_advice TEXT,advice_acked INTEGER);
    INSERT INTO events(ts,agent,kind,data,wake_id) VALUES('2029-01-01T00:00:00.000Z','supervisor','wake.enqueued','{"projection":"wakes","snapshot":{"id":"w","agent":"a","triggerRef":"t","status":"queued","leaseUntil":null,"attempt":0,"startedAt":null,"endedAt":null}}','w');
    INSERT INTO events(ts,agent,kind,data,wake_id) VALUES('2029-01-01T00:00:01.000Z','supervisor','wake.leased','{"projection":"wakes","snapshot":{"id":"w","agent":"a","triggerRef":"t","status":"leased","leaseUntil":"2029-01-01T00:01:00.000Z","attempt":1,"startedAt":null,"endedAt":null}}','w');
    INSERT INTO wakes VALUES('w','a','t','leased','2029-01-01T00:01:00.000Z',1,NULL,NULL);
    INSERT INTO actions VALUES('a','a','mock','{}','r','[1]',0,'requested',NULL,NULL,NULL,0);
    PRAGMA user_version=1;
  `);
  raw.close();
  const ledger = new SqliteLedger(path, { clock: new FixedClock() });
  assert.equal(ledger.wake("w")?.enqueuedSeq, 1);
  assert.match(ledger.wake("w")?.leaseToken ?? "", /^legacy:/);
  assert.equal(ledger.action("a")?.connector, "legacy");
  assert.equal((ledger.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 5);
  assert.equal(ledger.events().length, 2);
  ledger.rebuildProjections();
  assert.equal(ledger.wake("w")?.enqueuedSeq, 1);
  assert.equal(ledger.wake("w")?.status, "leased");
  ledger.close();
});

test("schema v2 migration builds the FTS index from existing events", () => {
  const path = join(mkdtempSync(join(tmpdir(), "goah-v2-")), "ledger.sqlite");
  const ledger = new SqliteLedger(path, { clock: new FixedClock() });
  ledger.appendEvent({ ts: "2030-01-01T00:00:00.000Z", agent: "a", kind: "fact", data: { text: "migrationsearchterm" }, wakeId: null });
  ledger.close();
  const raw = new DatabaseSync(path);
  raw.exec("DROP TRIGGER events_fts_insert; DROP TABLE events_fts; PRAGMA user_version=2");
  raw.close();
  const migrated = new SqliteLedger(path, { clock: new FixedClock() });
  assert.equal(migrated.searchEvents("migrationsearchterm").length, 1);
  assert.equal((migrated.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 5);
  migrated.close();
});

test("schema v3 migration indexes coalesced wake triggers", () => {
  const path = join(mkdtempSync(join(tmpdir(), "goah-v3-")), "ledger.sqlite");
  const ledger = new SqliteLedger(path, { clock: new FixedClock() });
  ledger.enqueueWake(wake("w", "a"), "supervisor");
  ledger.appendEvent({ ts: "2030-01-01T00:00:00.000Z", agent: "supervisor", kind: "wake.trigger_coalesced", data: { wakeId: "w", triggerRef: "metric:g:missing:none" }, wakeId: "w" });
  ledger.close();
  const raw = new DatabaseSync(path);
  raw.exec("DROP INDEX events_coalesced_trigger; PRAGMA user_version=3");
  raw.close();
  const migrated = new SqliteLedger(path, { clock: new FixedClock() });
  assert.equal(migrated.wakeByTrigger("a", "metric:g:missing:none")?.id, "w");
  assert.equal((migrated.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 5);
  migrated.close();
});

test("schema v4 migration removes the legacy goal budget column", () => {
  const path = join(mkdtempSync(join(tmpdir(), "goah-v4-")), "ledger.sqlite");
  new SqliteLedger(path, { clock: new FixedClock() }).close();
  const raw = new DatabaseSync(path);
  raw.exec(`ALTER TABLE goals RENAME TO goals_v5;
    CREATE TABLE goals(id TEXT PRIMARY KEY,parent_id TEXT,objective TEXT,metric TEXT,target TEXT,owner TEXT,budget TEXT,phase TEXT,revision INTEGER);
    INSERT INTO goals VALUES('legacy',NULL,'legacy','${JSON.stringify(metric).replaceAll("'", "''")}','1','a','{"currency":"USD","limit":10,"window":"goal"}','active',0);
    DROP TABLE goals_v5; PRAGMA user_version=4;`);
  raw.close();
  const migrated = new SqliteLedger(path, { clock: new FixedClock() });
  assert.equal(migrated.goal("legacy")?.objective, "legacy");
  assert.equal("budget" in migrated.goal("legacy")!, false);
  const columns = (migrated.db.prepare("PRAGMA table_info(goals)").all() as Array<{ name: string }>).map((row) => row.name);
  assert.equal(columns.includes("budget"), false);
  assert.equal((migrated.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 5);
  migrated.close();
});

test("goal parent cannot be changed during an update", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  ledger.putGoal({ id: "p1", parentId: null, objective: "p1", metric, target: 1, owner: "owner", phase: "active", revision: 0 }, "human");
  ledger.putGoal({ id: "p2", parentId: null, objective: "p2", metric, target: 1, owner: "other", phase: "active", revision: 0 }, "human");
  ledger.putGoal({ id: "child", parentId: "p1", objective: "c", metric, target: 1, owner: "child", phase: "active", revision: 0 }, "owner");
  assert.throws(() => ledger.putGoal({ id: "child", parentId: "p2", objective: "c", metric, target: 1, owner: "child", phase: "active", revision: 1 }, "owner"), /reparenting/);
  ledger.close();
});

test("FTS searches event facts and actions keep payload policy external", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  ledger.putGoal({ id: "root", parentId: null, objective: "generic policy", metric, target: 1, owner: "a", phase: "active", revision: 0 }, "human");
  const evidence = ledger.appendEvent({ ts: "2030-01-01T00:00:00.000Z", agent: "a", kind: "observation", data: { note: "uniquenebulafact" }, wakeId: null });
  assert.equal(ledger.searchEvents("uniquenebulafact").map((event) => event.seq).includes(evidence.seq), true);
  ledger.requestAction({ ...action("generic", [evidence.seq]), payload: { domainSpecificPolicy: { quota: 60 } } }, "a");
  assert.equal(ledger.approveAction("generic", "human", "policy is handled outside the ledger", [evidence.seq]).status, "approved");
  ledger.close();
});

test("fault injection rolls back every wake mutation point", () => {
  const cases: Array<{ name: string; setup(l: SqliteLedger): void; mutate(l: SqliteLedger): void }> = [
    { name: "enqueue", setup: () => undefined, mutate: (l) => { l.enqueueWake(wake("w"), "supervisor"); } },
    { name: "lease", setup: (l) => { l.enqueueWake(wake("w"), "supervisor"); }, mutate: (l) => { l.claimNextWake("2030-01-01T00:00:00.000Z", "2030-01-01T00:00:10.000Z", "lease"); } },
    { name: "running", setup: leased, mutate: (l) => { l.markWakeRunning("w", "2030-01-01T00:00:01.000Z", "lease"); } },
    { name: "pid", setup: running, mutate: (l) => { l.attachWakeProcess("w", "lease", 123, "2030-01-01T00:00:02.000Z"); } },
    { name: "done", setup: running, mutate: (l) => { l.finishWake("w", "done", "2030-01-01T00:00:02.000Z"); } },
    { name: "abnormal", setup: running, mutate: (l) => { l.finishWake("w", "abnormal", "2030-01-01T00:00:02.000Z"); } },
    { name: "merge blocked", setup: running, mutate: (l) => { l.finishWake("w", "merge_blocked", "2030-01-01T00:00:02.000Z"); } },
    { name: "leased abnormal", setup: leased, mutate: (l) => { l.finishWake("w", "abnormal", "2030-01-01T00:00:02.000Z"); } },
    { name: "expired leased", setup: leased, mutate: (l) => { l.recoverExpiredWake("w", "2030-01-01T00:00:11.000Z"); } },
    { name: "expired running", setup: running, mutate: (l) => { l.recoverExpiredWake("w", "2030-01-01T00:00:11.000Z"); } },
  ];
  for (const item of cases) {
    let armed = false;
    const ledger = new SqliteLedger(":memory:", { clock: new FixedClock(), faultInjector: () => { if (armed) throw new Error(`kill at ${item.name}`); } });
    item.setup(ledger);
    const before = JSON.stringify({ events: ledger.events(), wakes: ledger.wakes() });
    armed = true;
    assert.throws(() => item.mutate(ledger), /kill at/);
    assert.equal(JSON.stringify({ events: ledger.events(), wakes: ledger.wakes() }), before, item.name);
    ledger.close();
  }
});

test("fault injection rolls back every action, audit, and approval transition", () => {
  const targets = ["request", "approve", "reject", "dispatch", "dispatchFailed", "confirm", "unknown", "retry", "reconcileConfirmed", "reconcileFailed", "audit", "ack"] as const;
  for (const target of targets) {
    let armed = false;
    const ledger = new SqliteLedger(":memory:", { clock: new FixedClock(), faultInjector: () => { if (armed) throw new Error(`kill at ${target}`); } });
    const evidence = ledger.appendEvent({ ts: "2030-01-01T00:00:00.000Z", agent: "a", kind: "observed", data: {}, wakeId: null });
    if (target !== "request") ledger.requestAction(action("a", [evidence.seq]), "a");
    if (["dispatch", "dispatchFailed", "confirm", "unknown", "retry", "reconcileConfirmed", "reconcileFailed"].includes(target)) ledger.approveAction("a", "human", "ok", [evidence.seq]);
    if (["dispatchFailed", "confirm", "unknown", "retry", "reconcileConfirmed", "reconcileFailed"].includes(target)) ledger.transitionAction("a", "dispatching");
    if (["retry", "reconcileConfirmed", "reconcileFailed"].includes(target)) ledger.recoverDispatchingActions();
    if (target === "ack") ledger.putAuditAdvice("a", { by: "verifier", body: {}, evidence: [evidence.seq] });
    const before = JSON.stringify({ events: ledger.events(), actions: ledger.actions() });
    armed = true;
    const mutate = () => {
      if (target === "request") return ledger.requestAction(action("a", [evidence.seq]), "a");
      if (target === "approve") return ledger.approveAction("a", "human", "ok", [evidence.seq]);
      if (target === "reject") return ledger.rejectAction("a", "human", "no", [evidence.seq]);
      if (target === "dispatch") return ledger.transitionAction("a", "dispatching");
      if (target === "dispatchFailed") return ledger.transitionAction("a", "failed");
      if (target === "confirm") return ledger.transitionAction("a", "confirmed");
      if (target === "unknown") return ledger.recoverDispatchingActions();
      if (target === "retry") return ledger.transitionAction("a", "dispatching");
      if (target === "reconcileConfirmed") return ledger.transitionAction("a", "confirmed", { reconciledAt: "2030-01-01T00:01:00.000Z" });
      if (target === "reconcileFailed") return ledger.transitionAction("a", "failed", { reconciledAt: "2030-01-01T00:01:00.000Z" });
      if (target === "audit") return ledger.putAuditAdvice("a", { by: "verifier", body: {}, evidence: [evidence.seq] });
      return ledger.ackAuditAdvice("a", "a");
    };
    assert.throws(mutate, /kill at/);
    assert.equal(JSON.stringify({ events: ledger.events(), actions: ledger.actions() }), before, target);
    ledger.close();
  }
});

function leased(ledger: SqliteLedger): void {
  ledger.enqueueWake(wake("w"), "supervisor");
  ledger.claimNextWake("2030-01-01T00:00:00.000Z", "2030-01-01T00:00:10.000Z", "lease");
}
function running(ledger: SqliteLedger): void {
  leased(ledger);
  ledger.markWakeRunning("w", "2030-01-01T00:00:01.000Z", "lease");
}
