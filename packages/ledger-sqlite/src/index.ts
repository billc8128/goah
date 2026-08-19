import { DatabaseSync } from "node:sqlite";
import {
  assertActionRequest,
  assertActionTransition,
  assertGoalSnapshot,
  type ActionSnapshot,
  type ActionStatus,
  type AuditAdvice,
  type BudgetExposure,
  type Clock,
  type EventRecord,
  type GoalSnapshot,
  type HandoffCommit,
  type JsonValue,
  type Ledger,
  type MailSnapshot,
  type MetricSample,
  type ProjectionName,
  type ScheduleSnapshot,
  type WakeSnapshot,
} from "@goah/ledger-contract";

type FaultPoint = "after_event_before_projection";
type FaultInjector = (point: FaultPoint) => void;
type Row = Record<string, unknown>;

export const SQLITE_SCHEMA_VERSION = 4;

const createWakes = `CREATE TABLE IF NOT EXISTS wakes (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  trigger_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','leased','running','done','abnormal','merge_blocked')),
  lease_until TEXT,
  attempt INTEGER NOT NULL CHECK(attempt >= 0),
  started_at TEXT,
  ended_at TEXT,
  enqueued_seq INTEGER NOT NULL CHECK(enqueued_seq > 0),
  lease_token TEXT,
  runner_pid INTEGER,
  UNIQUE(agent, trigger_ref),
  CHECK((status IN ('leased','running') AND lease_until IS NOT NULL AND lease_token IS NOT NULL) OR status NOT IN ('leased','running')),
  CHECK((status IN ('done','abnormal','merge_blocked') AND ended_at IS NOT NULL) OR status NOT IN ('done','abnormal','merge_blocked'))
) STRICT;`;

const createActions = `CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  connector TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  evidence TEXT NOT NULL CHECK(json_valid(evidence) AND json_array_length(evidence) > 0),
  gated INTEGER NOT NULL CHECK(gated IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('requested','approved','dispatching','confirmed','failed','unknown')),
  reconciled_at TEXT,
  external_ref TEXT,
  audit_advice TEXT CHECK(audit_advice IS NULL OR json_valid(audit_advice)),
  advice_acked INTEGER NOT NULL CHECK(advice_acked IN (0,1)),
  CHECK(reconciled_at IS NULL OR status IN ('confirmed','failed'))
) STRICT;`;

const indexesAndTriggers = `
CREATE UNIQUE INDEX IF NOT EXISTS wakes_one_active_agent ON wakes(agent) WHERE status IN ('leased','running');
CREATE INDEX IF NOT EXISTS wakes_queue_order ON wakes(status, enqueued_seq);
CREATE INDEX IF NOT EXISTS schedule_due ON schedule(next_wake_at);
CREATE INDEX IF NOT EXISTS events_agent_kind_seq ON events(agent, kind, seq DESC);
CREATE INDEX IF NOT EXISTS events_wake_seq ON events(wake_id, seq);
CREATE INDEX IF NOT EXISTS events_coalesced_trigger ON events(json_extract(data,'$.triggerRef'), wake_id) WHERE kind='wake.trigger_coalesced';
CREATE INDEX IF NOT EXISTS actions_agent_status ON actions(agent, status);
CREATE UNIQUE INDEX IF NOT EXISTS goals_one_active_budget_owner ON goals(owner) WHERE budget IS NOT NULL AND phase='active';
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(agent, kind, data, content='events', content_rowid='seq');

CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_fts_insert AFTER INSERT ON events
BEGIN INSERT INTO events_fts(rowid,agent,kind,data) VALUES (new.seq,new.agent,new.kind,new.data); END;

CREATE TRIGGER IF NOT EXISTS wakes_valid_transition BEFORE UPDATE OF status ON wakes
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = 'queued' AND NEW.status IN ('leased','abnormal')) OR
  (OLD.status = 'leased' AND NEW.status IN ('queued','running','abnormal')) OR
  (OLD.status = 'running' AND NEW.status IN ('done','abnormal','merge_blocked'))
)
BEGIN SELECT RAISE(ABORT, 'invalid wake transition'); END;

CREATE TRIGGER IF NOT EXISTS actions_valid_transition BEFORE UPDATE OF status ON actions
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = 'requested' AND NEW.status IN ('approved','failed')) OR
  (OLD.status = 'approved' AND NEW.status IN ('dispatching','failed')) OR
  (OLD.status = 'dispatching' AND NEW.status IN ('confirmed','failed','unknown')) OR
  (OLD.status = 'unknown' AND NEW.status IN ('dispatching','confirmed','failed'))
)
BEGIN SELECT RAISE(ABORT, 'invalid action transition'); END;
`;

const schema = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  wake_id TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES goals(id),
  objective TEXT NOT NULL,
  metric TEXT NOT NULL CHECK(json_valid(metric)),
  target TEXT NOT NULL CHECK(json_valid(target)),
  owner TEXT NOT NULL,
  budget TEXT CHECK(budget IS NULL OR json_valid(budget)),
  phase TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 0)
) STRICT;
CREATE TABLE IF NOT EXISTS schedule (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  next_wake_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  set_by TEXT NOT NULL
) STRICT;
${createWakes}
CREATE TABLE IF NOT EXISTS mailbox (
  id TEXT PRIMARY KEY,
  to_agent TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('fyi','decision','emergency')),
  body TEXT NOT NULL CHECK(json_valid(body)),
  read_at TEXT
) STRICT;
${createActions}
${indexesAndTriggers}`;

class SystemClock implements Clock { now(): Date { return new Date(); } }

export interface SqliteLedgerOptions {
  faultInjector?: FaultInjector;
  clock?: Clock;
  busyTimeoutMs?: number;
}

export class SqliteLedger implements Ledger {
  readonly db: DatabaseSync;
  readonly #faultInjector: FaultInjector | undefined;
  readonly #clock: Clock;

  constructor(path = ":memory:", options: SqliteLedgerOptions = {}) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5_000};`);
    this.#faultInjector = options.faultInjector;
    this.#clock = options.clock ?? new SystemClock();
    const version = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (version > SQLITE_SCHEMA_VERSION) {
      this.db.close();
      throw new Error(`ledger schema ${version} is newer than supported schema ${SQLITE_SCHEMA_VERSION}`);
    }
    if (version === 0) {
      this.db.exec(schema);
      this.db.exec(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
    } else if (version === 1) {
      this.#migrateV1();
    } else if (version === 2) {
      this.#migrateV2();
    } else if (version === 3) {
      this.#migrateV3();
    } else {
      this.db.exec(schema);
    }
  }

  close(): void { this.db.close(); }
  appendEvent(input: Omit<EventRecord, "seq">): EventRecord { return this.#transaction(() => this.#insertEvent(input)); }

  putGoal(goal: GoalSnapshot, actor: string, wakeId?: string): EventRecord {
    assertGoalSnapshot(goal);
    const current = this.#getGoal(goal.id);
    if (current) {
      if (goal.revision !== current.revision + 1) throw new Error("goal revision CAS failed");
      if (goal.parentId !== current.parentId) throw new Error("goal reparenting is not supported");
      this.#assertGoalAuthority(current.parentId, actor);
    } else {
      if (goal.revision !== 0) throw new Error("new goal revision must be 0");
      this.#assertGoalAuthority(goal.parentId, actor);
    }
    this.#assertBudgetAllocation(goal);
    return this.#project("goals", goal, actor, "goal.put", wakeId);
  }

  putSchedule(value: ScheduleSnapshot, actor: string, wakeId?: string): EventRecord {
    if (actor !== "supervisor" && actor !== value.agent) throw new Error("schedule may only be set by its agent or supervisor");
    return this.#project("schedule", value, actor, "schedule.put", wakeId);
  }

  enqueueWake(input: WakeSnapshot, actor: string): { event: EventRecord; created: boolean } {
    if (actor !== "supervisor") throw new Error("only supervisor may enqueue wakes");
    if (input.status !== "queued" || input.attempt !== 0 || input.leaseUntil || input.startedAt || input.endedAt || input.leaseToken || input.runnerPid) {
      throw new Error("new wake must be pristine and queued");
    }
    const duplicate = this.wakeByTrigger(input.agent, input.triggerRef);
    if (duplicate) {
      const row = this.db.prepare("SELECT * FROM events WHERE kind='wake.enqueued' AND json_extract(data, '$.snapshot.id')=? ORDER BY seq DESC LIMIT 1").get(duplicate.id) as Row | undefined;
      if (!row) throw new Error("wake projection has no source event");
      return { event: mapEvent(row), created: false };
    }
    return this.#transaction(() => {
      const enqueuedSeq = this.#nextEventSeq();
      const wake = { ...input, enqueuedSeq };
      const event = this.#recordProjection("wakes", wake, actor, "wake.enqueued", wake.id, undefined, enqueuedSeq);
      return { event, created: true };
    });
  }

  claimNextWake(now: string, leaseUntil: string, leaseToken: string): WakeSnapshot | null {
    return this.#transaction(() => {
      const row = this.db.prepare(`SELECT * FROM wakes w WHERE status='queued' AND NOT EXISTS (
        SELECT 1 FROM wakes active WHERE active.agent=w.agent AND active.status IN ('leased','running')
      ) ORDER BY enqueued_seq LIMIT 1`).get() as Row | undefined;
      if (!row) return null;
      const current = mapWake(row);
      const next: WakeSnapshot = { ...current, status: "leased", leaseUntil, leaseToken, runnerPid: null, attempt: current.attempt + 1 };
      this.#recordProjection("wakes", next, "supervisor", "wake.leased", next.id, now);
      return next;
    });
  }

  markWakeRunning(id: string, now: string, leaseToken: string): WakeSnapshot {
    const current = this.#requiredWake(id);
    this.#assertLease(current, leaseToken);
    const next: WakeSnapshot = { ...current, status: "running", startedAt: now };
    this.#project("wakes", next, "supervisor", "wake.running", id, now);
    return next;
  }

  attachWakeProcess(id: string, leaseToken: string, pid: number, now: string): WakeSnapshot {
    const current = this.#requiredWake(id);
    this.#assertLease(current, leaseToken);
    if (current.status !== "running") throw new Error("runner pid may only be attached to a running wake");
    const next = { ...current, runnerPid: pid };
    this.#project("wakes", next, "supervisor", "wake.runner_attached", id, now);
    return next;
  }

  finishWake(id: string, status: "done" | "abnormal" | "merge_blocked", now: string): WakeSnapshot {
    const current = this.#requiredWake(id);
    const next: WakeSnapshot = { ...current, status, leaseUntil: null, leaseToken: null, runnerPid: null, endedAt: now };
    this.#project("wakes", next, "supervisor", `wake.${status}`, id, now);
    return next;
  }

  expiredWakes(now: string): WakeSnapshot[] {
    return (this.db.prepare("SELECT * FROM wakes WHERE status IN ('leased','running') AND lease_until <= ? ORDER BY enqueued_seq").all(now) as Row[]).map(mapWake);
  }

  recoverExpiredWake(id: string, now: string): WakeSnapshot {
    const current = this.#requiredWake(id);
    if (current.status !== "leased" && current.status !== "running") throw new Error("wake is not recoverable");
    if (!current.leaseUntil || current.leaseUntil > now) throw new Error("wake lease has not expired");
    const running = current.status === "running";
    const next: WakeSnapshot = { ...current, status: running ? "abnormal" : "queued", leaseUntil: null, leaseToken: null, runnerPid: null, endedAt: running ? now : null };
    this.#project("wakes", next, "supervisor", running ? "wake.expired_abnormal" : "wake.lease_expired", id, now);
    return next;
  }

  appendRunnerEvent(input: Omit<EventRecord, "seq">, leaseToken: string): EventRecord {
    return this.#transaction(() => {
      if (!input.wakeId) throw new Error("runner event requires wakeId");
      const wake = this.#requiredWake(input.wakeId);
      this.#assertLease(wake, leaseToken);
      if (wake.status !== "running" || !wake.leaseUntil || input.ts > wake.leaseUntil) throw new Error("stale runner event rejected");
      return this.#insertEvent(input);
    });
  }

  requestAction(action: ActionSnapshot, actor: string, wakeId?: string): EventRecord {
    assertActionRequest(action);
    if (actor !== action.agent) throw new Error("action actor does not match action agent");
    this.#assertEvidenceExists(action.evidence);
    return this.#project("actions", action, actor, "action.requested", wakeId);
  }

  approveAction(id: string, approver: string, reason: string, evidence: number[]): ActionSnapshot {
    this.#assertBudgetAvailable(this.#requiredAction(id));
    return this.#decideAction(id, "approved", approver, reason, evidence);
  }

  rejectAction(id: string, approver: string, reason: string, evidence: number[]): ActionSnapshot {
    return this.#decideAction(id, "failed", approver, reason, evidence);
  }

  transitionAction(id: string, status: ActionStatus, patch: Partial<Pick<ActionSnapshot, "externalRef" | "reconciledAt">> = {}): ActionSnapshot {
    const current = this.#requiredAction(id);
    assertActionTransition(current.status, status);
    if (current.status === "unknown" && (status === "confirmed" || status === "failed") && !patch.reconciledAt) throw new Error("unknown action requires a reconciliation timestamp");
    if (patch.reconciledAt && current.status !== "unknown") throw new Error("reconciledAt is only written after unknown is queried");
    if (patch.reconciledAt && status !== "confirmed" && status !== "failed") throw new Error("reconciliation must resolve to a final state");
    const next = { ...current, ...patch, status };
    this.#project("actions", next, "supervisor", `action.${status}`);
    return next;
  }

  recoverDispatchingActions(): ActionSnapshot[] {
    const rows = this.db.prepare("SELECT id FROM actions WHERE status='dispatching' ORDER BY id").all() as Array<{ id: string }>;
    return rows.map(({ id }) => this.transitionAction(id, "unknown"));
  }

  putAuditAdvice(id: string, input: Omit<AuditAdvice, "at">, wakeId?: string): ActionSnapshot {
    const advice: AuditAdvice = { ...input, at: this.#now() };
    this.#assertEvidenceExists(advice.evidence);
    const current = this.#requiredAction(id);
    const next = { ...current, auditAdvice: advice, adviceAcked: false };
    this.#project("actions", next, advice.by, "action.audit_advice", wakeId, advice.at);
    return next;
  }

  ackAuditAdvice(id: string, agent: string): ActionSnapshot {
    const current = this.#requiredAction(id);
    if (current.agent !== agent) throw new Error("only the action owner may acknowledge audit advice");
    if (!current.auditAdvice) throw new Error("action has no audit advice");
    const next = { ...current, adviceAcked: true };
    this.#project("actions", next, agent, "action.audit_advice_acked");
    return next;
  }

  putMail(mail: MailSnapshot, actor: string, wakeId?: string): EventRecord {
    if (mail.from !== actor && actor !== "supervisor") throw new Error("mail sender does not match actor");
    return this.#project("mailbox", mail, actor, "mail.put", wakeId);
  }

  commitHandoff(commit: HandoffCommit): EventRecord {
    return this.#transaction(() => {
      const wake = this.#requiredWake(commit.wakeId);
      if (wake.status !== "running" || wake.agent !== commit.agent) throw new Error("handoff does not match a running wake");
      const event = this.#insertEvent({ ts: commit.ts, agent: commit.agent, kind: "handoff.recorded", data: commit.output.handoff as unknown as JsonValue, wakeId: commit.wakeId });
      for (const mail of this.unreadMail(commit.agent)) {
        this.#recordProjection("mailbox", { ...mail, readAt: commit.ts }, "supervisor", "mail.read", commit.wakeId, commit.ts);
      }
      for (const mail of commit.outgoingMail) {
        if (mail.from !== commit.agent) throw new Error("handoff mail sender does not match agent");
        this.#recordProjection("mailbox", mail, commit.agent, "mail.put", commit.wakeId, commit.ts);
      }
      if (commit.schedule) {
        if (commit.schedule.agent !== commit.agent || commit.schedule.setBy !== commit.agent) throw new Error("handoff schedule does not match agent");
        this.#recordProjection("schedule", commit.schedule, commit.agent, "schedule.put", commit.wakeId, commit.ts);
      }
      return event;
    });
  }

  dueSchedules(now: string): ScheduleSnapshot[] { return (this.db.prepare("SELECT * FROM schedule WHERE next_wake_at <= ? ORDER BY next_wake_at,id").all(now) as Row[]).map(mapSchedule); }
  unreadMail(agent: string): MailSnapshot[] { return (this.db.prepare("SELECT * FROM mailbox WHERE to_agent=? AND read_at IS NULL ORDER BY rowid").all(agent) as Row[]).map(mapMail); }
  unackedAuditAdvice(agent: string): ActionSnapshot[] { return (this.db.prepare("SELECT * FROM actions WHERE agent=? AND audit_advice IS NOT NULL AND advice_acked=0 ORDER BY rowid").all(agent) as Row[]).map(mapAction); }
  lastEvent(agent: string, kind: string): EventRecord | null { const row = this.db.prepare("SELECT * FROM events WHERE agent=? AND kind=? ORDER BY seq DESC LIMIT 1").get(agent, kind) as Row | undefined; return row ? mapEvent(row) : null; }
  eventsForWake(wakeId: string): EventRecord[] { return (this.db.prepare("SELECT * FROM events WHERE wake_id=? ORDER BY seq").all(wakeId) as Row[]).map(mapEvent); }
  wake(id: string): WakeSnapshot | null { const row = this.db.prepare("SELECT * FROM wakes WHERE id=?").get(id) as Row | undefined; return row ? mapWake(row) : null; }
  wakeByTrigger(agent: string, triggerRef: string): WakeSnapshot | null {
    const direct = this.db.prepare("SELECT * FROM wakes WHERE agent=? AND trigger_ref=?").get(agent, triggerRef) as Row | undefined;
    if (direct) return mapWake(direct);
    const coalesced = this.db.prepare(`SELECT w.* FROM events e JOIN wakes w ON w.id=e.wake_id
      WHERE e.kind='wake.trigger_coalesced' AND json_extract(e.data,'$.triggerRef')=? AND w.agent=? LIMIT 1`).get(triggerRef, agent) as Row | undefined;
    return coalesced ? mapWake(coalesced) : null;
  }
  queuedWakeForAgent(agent: string): WakeSnapshot | null { const row = this.db.prepare("SELECT * FROM wakes WHERE agent=? AND status='queued' ORDER BY enqueued_seq LIMIT 1").get(agent) as Row | undefined; return row ? mapWake(row) : null; }
  action(id: string): ActionSnapshot | null { const row = this.db.prepare("SELECT * FROM actions WHERE id=?").get(id) as Row | undefined; return row ? mapAction(row) : null; }
  goalsForOwner(owner: string): GoalSnapshot[] { return (this.db.prepare("SELECT * FROM goals WHERE owner=? ORDER BY id").all(owner) as Row[]).map(mapGoal); }
  goal(id: string): GoalSnapshot | null { return this.#getGoal(id); }
  triggeringMail(): MailSnapshot[] { return (this.db.prepare("SELECT * FROM mailbox WHERE read_at IS NULL AND level IN ('decision','emergency') ORDER BY rowid").all() as Row[]).map(mapMail); }
  eventsSince(seq: number, kinds?: string[]): EventRecord[] {
    const events = (this.db.prepare("SELECT * FROM events WHERE seq>? ORDER BY seq").all(seq) as Row[]).map(mapEvent);
    return kinds?.length ? events.filter((event) => kinds.includes(event.kind)) : events;
  }
  searchEvents(query: string, limit = 50): EventRecord[] {
    return (this.db.prepare("SELECT e.* FROM events_fts f JOIN events e ON e.seq=f.rowid WHERE events_fts MATCH ? ORDER BY rank LIMIT ?").all(query, limit) as Row[]).map(mapEvent);
  }
  budgetExposure(agent: string, at: string): BudgetExposure | null {
    const goal = this.goalsForOwner(agent).find((item) => item.phase === "active" && item.budget);
    if (!goal?.budget) return null;
    const start = budgetWindowStart(goal.budget.window, at);
    const rows = this.db.prepare(`SELECT a.*, (SELECT ts FROM events e WHERE e.kind='action.requested' AND json_extract(e.data,'$.snapshot.id')=a.id ORDER BY seq LIMIT 1) requested_at FROM actions a WHERE agent=? AND status IN ('approved','dispatching','unknown','confirmed')`).all(agent) as Row[];
    let reserved = 0;
    let actual = 0;
    for (const row of rows) {
      if (start && String(row.requested_at ?? "") < start) continue;
      const payload = JSON.parse(String(row.payload)) as Record<string, unknown>;
      const amount = typeof payload.amount === "number" ? payload.amount : 0;
      if (amount === 0) continue;
      if (payload.currency !== goal.budget.currency) throw new Error("action currency does not match goal budget");
      if (row.status === "confirmed") actual += amount; else reserved += amount;
    }
    return { currency: goal.budget.currency, limit: goal.budget.limit, reserved, actual, available: goal.budget.limit - reserved - actual };
  }
  metricSamples(goalId: string): MetricSample[] {
    return (this.db.prepare("SELECT data FROM events WHERE kind='metric.sampled' AND json_extract(data,'$.goalId')=? ORDER BY seq").all(goalId) as Array<{ data: string }>).map((row) => JSON.parse(row.data) as MetricSample);
  }
  events(): EventRecord[] { return (this.db.prepare("SELECT * FROM events ORDER BY seq").all() as Row[]).map(mapEvent); }
  goals(): GoalSnapshot[] { return (this.db.prepare("SELECT * FROM goals ORDER BY id").all() as Row[]).map(mapGoal); }
  schedules(): ScheduleSnapshot[] { return (this.db.prepare("SELECT * FROM schedule ORDER BY id").all() as Row[]).map(mapSchedule); }
  wakes(): WakeSnapshot[] { return (this.db.prepare("SELECT * FROM wakes ORDER BY enqueued_seq").all() as Row[]).map(mapWake); }
  actions(): ActionSnapshot[] { return (this.db.prepare("SELECT * FROM actions ORDER BY id").all() as Row[]).map(mapAction); }
  mailbox(): MailSnapshot[] { return (this.db.prepare("SELECT * FROM mailbox ORDER BY rowid").all() as Row[]).map(mapMail); }

  rebuildProjections(): void {
    const source = this.events();
    this.#transaction(() => {
      this.db.exec("DELETE FROM actions; DELETE FROM mailbox; DELETE FROM wakes; DELETE FROM schedule; DELETE FROM goals;");
      for (const event of source) {
        const data = event.data as { projection?: ProjectionName; snapshot?: unknown };
        if (data.projection && data.snapshot) this.#applyProjection(data.projection, data.snapshot, event.seq);
      }
    });
  }

  #decideAction(id: string, status: "approved" | "failed", approver: string, reason: string, evidence: number[]): ActionSnapshot {
    if (!reason.trim()) throw new Error("approval reason is required");
    this.#assertEvidenceExists(evidence);
    return this.#transaction(() => {
      const current = this.#requiredAction(id);
      assertActionTransition(current.status, status);
      this.#insertEvent({ ts: this.#now(), agent: approver, kind: `action.${status}_decision`, data: { actionId: id, reason, evidence }, wakeId: null });
      const next = { ...current, status };
      this.#recordProjection("actions", next, approver, `action.${status}`);
      return next;
    });
  }

  #assertGoalAuthority(parentId: string | null, actor: string): void {
    if (parentId === null) { if (actor !== "human") throw new Error("only human may modify a root goal"); return; }
    const parent = this.#getGoal(parentId);
    if (!parent) throw new Error("parent goal does not exist");
    if (parent.owner !== actor) throw new Error("only the parent goal owner may modify a child goal");
  }

  #assertBudgetAllocation(goal: GoalSnapshot): void {
    if (!goal.budget || !goal.parentId) return;
    const parent = this.#getGoal(goal.parentId);
    if (!parent?.budget) throw new Error("budgeted child requires a budgeted parent");
    if (parent.budget.currency !== goal.budget.currency || parent.budget.window !== goal.budget.window) throw new Error("child budget currency and window must match parent");
    const row = this.db.prepare("SELECT COALESCE(SUM(json_extract(budget,'$.limit')),0) total FROM goals WHERE parent_id=? AND id<>? AND budget IS NOT NULL").get(goal.parentId, goal.id) as { total: number };
    if (Number(row.total) + goal.budget.limit > parent.budget.limit) throw new Error("child budgets exceed parent budget");
  }

  #assertBudgetAvailable(action: ActionSnapshot): void {
    const exposure = this.budgetExposure(action.agent, this.#now());
    if (!exposure) return;
    const payload = action.payload as Record<string, unknown>;
    if (typeof payload.amount !== "number") return;
    if (payload.currency !== exposure.currency) throw new Error("action currency does not match goal budget");
    if (payload.amount > exposure.available) throw new Error("action exceeds available goal budget");
  }

  #assertEvidenceExists(evidence: number[]): void {
    const exists = this.db.prepare("SELECT 1 FROM events WHERE seq=?");
    for (const seq of evidence) if (!Number.isInteger(seq) || seq <= 0 || !exists.get(seq)) throw new Error(`evidence event does not exist: ${seq}`);
  }

  #assertLease(wake: WakeSnapshot, leaseToken: string): void {
    if (wake.leaseToken !== leaseToken) throw new Error("stale wake lease token");
  }

  #getGoal(id: string): GoalSnapshot | null { const row = this.db.prepare("SELECT * FROM goals WHERE id=?").get(id) as Row | undefined; return row ? mapGoal(row) : null; }
  #requiredWake(id: string): WakeSnapshot { const value = this.wake(id); if (!value) throw new Error(`wake not found: ${id}`); return value; }
  #requiredAction(id: string): ActionSnapshot { const value = this.action(id); if (!value) throw new Error(`action not found: ${id}`); return value; }
  #project(projection: ProjectionName, snapshot: unknown, agent: string, kind: string, wakeId?: string, ts?: string): EventRecord { return this.#transaction(() => this.#recordProjection(projection, snapshot, agent, kind, wakeId, ts)); }

  #recordProjection(projection: ProjectionName, snapshot: unknown, agent: string, kind: string, wakeId?: string, ts?: string, expectedSeq?: number): EventRecord {
    const event = this.#insertEvent({ ts: ts ?? this.#now(), agent, kind, data: { projection, snapshot } as unknown as JsonValue, wakeId: wakeId ?? null }, expectedSeq);
    this.#faultInjector?.("after_event_before_projection");
    this.#applyProjection(projection, snapshot, event.seq);
    return event;
  }

  #insertEvent(input: Omit<EventRecord, "seq">, expectedSeq?: number): EventRecord {
    const result = expectedSeq === undefined
      ? this.db.prepare("INSERT INTO events(ts,agent,kind,data,wake_id) VALUES (?,?,?,json(?),?)").run(input.ts, input.agent, input.kind, JSON.stringify(input.data), input.wakeId)
      : this.db.prepare("INSERT INTO events(seq,ts,agent,kind,data,wake_id) VALUES (?,?,?,?,json(?),?)").run(expectedSeq, input.ts, input.agent, input.kind, JSON.stringify(input.data), input.wakeId);
    return { ...input, seq: Number(result.lastInsertRowid) };
  }

  #nextEventSeq(): number {
    const row = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='events'").get() as { seq: number } | undefined;
    return Number(row?.seq ?? 0) + 1;
  }

  #applyProjection(projection: ProjectionName, raw: unknown, sourceSeq: number): void {
    if (projection === "goals") {
      const v = raw as GoalSnapshot;
      this.db.prepare(`INSERT INTO goals VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,objective=excluded.objective,metric=excluded.metric,target=excluded.target,owner=excluded.owner,budget=excluded.budget,phase=excluded.phase,revision=excluded.revision`).run(v.id,v.parentId,v.objective,JSON.stringify(v.metric),JSON.stringify(v.target),v.owner,v.budget?JSON.stringify(v.budget):null,v.phase,v.revision);
    } else if (projection === "schedule") {
      const v = raw as ScheduleSnapshot;
      this.db.prepare(`INSERT INTO schedule VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET agent=excluded.agent,next_wake_at=excluded.next_wake_at,reason=excluded.reason,set_by=excluded.set_by`).run(v.id,v.agent,v.nextWakeAt,v.reason,v.setBy);
    } else if (projection === "wakes") {
      const old = raw as Partial<WakeSnapshot> & Omit<WakeSnapshot,"enqueuedSeq"|"leaseToken"|"runnerPid">;
      const existing = this.wake(old.id);
      const active = old.status === "leased" || old.status === "running";
      const v: WakeSnapshot = {
        ...old,
        enqueuedSeq: old.enqueuedSeq ?? existing?.enqueuedSeq ?? sourceSeq,
        leaseToken: old.leaseToken !== undefined ? old.leaseToken : active ? existing?.leaseToken ?? `legacy:${old.id}:${old.attempt}` : null,
        runnerPid: old.runnerPid !== undefined ? old.runnerPid : existing?.runnerPid ?? null,
      };
      this.db.prepare(`INSERT INTO wakes VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET agent=excluded.agent,trigger_ref=excluded.trigger_ref,status=excluded.status,lease_until=excluded.lease_until,attempt=excluded.attempt,started_at=excluded.started_at,ended_at=excluded.ended_at,enqueued_seq=excluded.enqueued_seq,lease_token=excluded.lease_token,runner_pid=excluded.runner_pid`).run(v.id,v.agent,v.triggerRef,v.status,v.leaseUntil,v.attempt,v.startedAt,v.endedAt,v.enqueuedSeq,v.leaseToken,v.runnerPid);
    } else if (projection === "mailbox") {
      const v = raw as MailSnapshot;
      this.db.prepare(`INSERT INTO mailbox VALUES (?,?,?,?,json(?),?) ON CONFLICT(id) DO UPDATE SET to_agent=excluded.to_agent,from_agent=excluded.from_agent,level=excluded.level,body=excluded.body,read_at=excluded.read_at`).run(v.id,v.to,v.from,v.level,JSON.stringify(v.body),v.readAt);
    } else {
      const old = raw as Partial<ActionSnapshot> & Omit<ActionSnapshot,"connector">;
      const v: ActionSnapshot = { ...old, connector: old.connector ?? "legacy" };
      this.db.prepare(`INSERT INTO actions VALUES (?,?,?,?,json(?),?,json(?),?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET agent=excluded.agent,kind=excluded.kind,connector=excluded.connector,payload=excluded.payload,reason=excluded.reason,evidence=excluded.evidence,gated=excluded.gated,status=excluded.status,reconciled_at=excluded.reconciled_at,external_ref=excluded.external_ref,audit_advice=excluded.audit_advice,advice_acked=excluded.advice_acked`).run(v.id,v.agent,v.kind,v.connector,JSON.stringify(v.payload),v.reason,JSON.stringify(v.evidence),v.gated?1:0,v.status,v.reconciledAt,v.externalRef,v.auditAdvice===null?null:JSON.stringify(v.auditAdvice),v.adviceAcked?1:0);
    }
  }

  #migrateV1(): void {
    this.#transaction(() => {
      this.db.exec(`DROP INDEX IF EXISTS wakes_one_active_agent; DROP TRIGGER IF EXISTS wakes_valid_transition; ALTER TABLE wakes RENAME TO wakes_v1; ${createWakes}
        INSERT INTO wakes SELECT id,agent,trigger_ref,status,lease_until,attempt,started_at,ended_at,
          COALESCE((SELECT MIN(seq) FROM events WHERE kind='wake.enqueued' AND json_extract(data,'$.snapshot.id')=wakes_v1.id),rowid),
          CASE WHEN status IN ('leased','running') THEN 'legacy:'||id||':'||attempt ELSE NULL END,NULL FROM wakes_v1;
        DROP TABLE wakes_v1;
        DROP TRIGGER IF EXISTS actions_valid_transition; ALTER TABLE actions RENAME TO actions_v1; ${createActions}
        INSERT INTO actions SELECT id,agent,kind,'legacy',payload,reason,evidence,gated,status,reconciled_at,external_ref,audit_advice,advice_acked FROM actions_v1;
        DROP TABLE actions_v1; ${indexesAndTriggers} INSERT INTO events_fts(events_fts) VALUES('rebuild'); PRAGMA user_version=${SQLITE_SCHEMA_VERSION};`);
    });
  }

  #migrateV2(): void {
    this.#transaction(() => {
      this.db.exec(`${indexesAndTriggers} INSERT INTO events_fts(events_fts) VALUES('rebuild'); PRAGMA user_version=${SQLITE_SCHEMA_VERSION};`);
    });
  }

  #migrateV3(): void {
    this.#transaction(() => {
      this.db.exec(`CREATE INDEX IF NOT EXISTS events_coalesced_trigger ON events(json_extract(data,'$.triggerRef'), wake_id) WHERE kind='wake.trigger_coalesced'; PRAGMA user_version=${SQLITE_SCHEMA_VERSION};`);
    });
  }

  #transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  #now(): string { return this.#clock.now().toISOString(); }
}

function mapEvent(r: Row): EventRecord { return {seq:Number(r.seq),ts:String(r.ts),agent:String(r.agent),kind:String(r.kind),data:JSON.parse(String(r.data)) as JsonValue,wakeId:r.wake_id===null?null:String(r.wake_id)}; }
function mapGoal(r: Row): GoalSnapshot { return {id:String(r.id),parentId:r.parent_id===null?null:String(r.parent_id),objective:String(r.objective),metric:JSON.parse(String(r.metric)),target:JSON.parse(String(r.target)),owner:String(r.owner),budget:r.budget===null?null:JSON.parse(String(r.budget)),phase:String(r.phase),revision:Number(r.revision)} as GoalSnapshot; }
function mapSchedule(r: Row): ScheduleSnapshot { return {id:String(r.id),agent:String(r.agent),nextWakeAt:String(r.next_wake_at),reason:String(r.reason),setBy:String(r.set_by)}; }
function mapWake(r: Row): WakeSnapshot { return {id:String(r.id),agent:String(r.agent),triggerRef:String(r.trigger_ref),status:String(r.status) as WakeSnapshot["status"],leaseUntil:r.lease_until===null?null:String(r.lease_until),attempt:Number(r.attempt),startedAt:r.started_at===null?null:String(r.started_at),endedAt:r.ended_at===null?null:String(r.ended_at),enqueuedSeq:Number(r.enqueued_seq),leaseToken:r.lease_token===null?null:String(r.lease_token),runnerPid:r.runner_pid===null?null:Number(r.runner_pid)}; }
function mapMail(r: Row): MailSnapshot { return {id:String(r.id),to:String(r.to_agent),from:String(r.from_agent),level:String(r.level) as MailSnapshot["level"],body:JSON.parse(String(r.body)),readAt:r.read_at===null?null:String(r.read_at)}; }
function mapAction(r: Row): ActionSnapshot { return {id:String(r.id),agent:String(r.agent),kind:String(r.kind),connector:String(r.connector),payload:JSON.parse(String(r.payload)),reason:String(r.reason),evidence:JSON.parse(String(r.evidence)),gated:Boolean(r.gated),status:String(r.status) as ActionStatus,reconciledAt:r.reconciled_at===null?null:String(r.reconciled_at),externalRef:r.external_ref===null?null:String(r.external_ref),auditAdvice:r.audit_advice===null?null:JSON.parse(String(r.audit_advice)),adviceAcked:Boolean(r.advice_acked)}; }
function budgetWindowStart(window: "goal" | "day" | "month", at: string): string | null {
  if (window === "goal") return null;
  const date = new Date(at);
  if (window === "day") date.setUTCHours(0, 0, 0, 0);
  else { date.setUTCDate(1); date.setUTCHours(0, 0, 0, 0); }
  return date.toISOString();
}
