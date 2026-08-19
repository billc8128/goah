import { DatabaseSync } from "node:sqlite";
import {
  assertActionRequest,
  assertActionTransition,
  assertGoalSnapshot,
  assertGoalTransition,
  type ActionSnapshot,
  type ActionStatus,
  type AuditAdvice,
  type Clock,
  controlStream,
  type EventInput,
  type EventRecord,
  goalStream,
  type GoalSnapshot,
  type HandoffCommit,
  type JsonValue,
  type Ledger,
  type MailSnapshot,
  type MetricSample,
  type ScheduleSnapshot,
  type WakeSnapshot,
  wakeStream,
} from "goah-ledger-contract";

type FaultPoint = "after_event_before_projection";
type FaultInjector = (point: FaultPoint) => void;
type Row = Record<string, unknown>;
type ProjectionName = "goals" | "schedule" | "wakes" | "mailbox" | "actions";

export const SQLITE_SCHEMA_VERSION = 7;

const createGoals = `CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES goals(id),
  objective TEXT NOT NULL,
  owner TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('active','paused','blocked','complete')),
  revision INTEGER NOT NULL CHECK(revision >= 0)
) STRICT;`;

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
CREATE INDEX IF NOT EXISTS events_actor_type_seq ON events(actor, type, seq DESC);
CREATE INDEX IF NOT EXISTS events_stream_seq ON events(stream_id, stream_seq);
CREATE INDEX IF NOT EXISTS events_coalesced_trigger ON events(json_extract(data,'$.triggerRef'), stream_id) WHERE type='wake.trigger_coalesced';
CREATE INDEX IF NOT EXISTS actions_agent_status ON actions(agent, status);
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(actor, type, data, content='events', content_rowid='seq');

CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_fts_insert AFTER INSERT ON events
BEGIN INSERT INTO events_fts(rowid,actor,type,data) VALUES (new.seq,new.actor,new.type,new.data); END;

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

CREATE TRIGGER IF NOT EXISTS goals_valid_transition BEFORE UPDATE OF phase ON goals
WHEN OLD.phase <> NEW.phase AND NOT (
  (OLD.phase = 'active' AND NEW.phase IN ('paused','blocked','complete')) OR
  (OLD.phase = 'paused' AND NEW.phase IN ('active','complete')) OR
  (OLD.phase = 'blocked' AND NEW.phase IN ('active','complete'))
)
BEGIN SELECT RAISE(ABORT, 'invalid goal transition'); END;
`;

const schema = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id TEXT NOT NULL,
  stream_seq INTEGER NOT NULL CHECK(stream_seq > 0),
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  ignorable INTEGER CHECK(ignorable IS NULL OR ignorable = 1),
  UNIQUE(stream_id, stream_seq)
) STRICT;
${createGoals}
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
    } else if (version < SQLITE_SCHEMA_VERSION) {
      this.#migrateLegacy();
    } else {
      this.db.exec(schema);
    }
  }

  close(): void { this.db.close(); }
  appendEvent(input: EventInput): EventRecord { return this.#transaction(() => this.#insertEvent(input)); }
  appendEvents(inputs: EventInput[]): EventRecord[] { return this.#transaction(() => inputs.map((input) => this.#insertEvent(input))); }
  readStream(streamId: string, fromStreamSeq = 1): EventRecord[] {
    return (this.db.prepare("SELECT * FROM events WHERE stream_id=? AND stream_seq>=? ORDER BY stream_seq").all(streamId, fromStreamSeq) as Row[]).map(mapEvent);
  }

  putGoal(goal: GoalSnapshot, actor: string, wakeId?: string): EventRecord {
    assertGoalSnapshot(goal);
    const current = this.#getGoal(goal.id);
    if (current) {
      if (goal.revision !== current.revision + 1) throw new Error("goal revision CAS failed");
      if (goal.parentId !== current.parentId) throw new Error("goal reparenting is not supported");
      assertGoalTransition(current.phase, goal.phase);
      this.#assertGoalAuthority(current.parentId, actor);
    } else {
      if (goal.revision !== 0) throw new Error("new goal revision must be 0");
      this.#assertGoalAuthority(goal.parentId, actor);
    }
    return this.#project("goals", goal, actor, "goal.put", wakeId, undefined, goalStream(goal.id));
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
      const row = this.db.prepare("SELECT * FROM events WHERE type='wake.enqueued' AND json_extract(data, '$.snapshot.id')=? ORDER BY seq DESC LIMIT 1").get(duplicate.id) as Row | undefined;
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

  renewWakeLease(id: string, leaseToken: string, leaseUntil: string, now: string): WakeSnapshot {
    const current = this.#requiredWake(id);
    this.#assertLease(current, leaseToken);
    if (current.status !== "leased" && current.status !== "running") throw new Error("only an active wake lease may be renewed");
    if (leaseUntil <= now) throw new Error("renewed lease must expire in the future");
    const next: WakeSnapshot = { ...current, leaseUntil };
    this.#project("wakes", next, "supervisor", "wake.lease_renewed", id, now);
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

  appendRunnerEvent(input: EventInput, leaseToken: string): EventRecord {
    return this.#transaction(() => {
      if (!input.streamId.startsWith("wake:")) throw new Error("runner event requires a wake stream");
      const wake = this.#requiredWake(input.streamId.slice("wake:".length));
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
      const event = this.#insertEvent({ streamId: wakeStream(commit.wakeId), ts: commit.ts, actor: commit.agent, type: "handoff.recorded", data: commit.output.handoff as unknown as JsonValue });
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
  lastEvent(actor: string, type: string): EventRecord | null { const row = this.db.prepare("SELECT * FROM events WHERE actor=? AND type=? ORDER BY seq DESC LIMIT 1").get(actor, type) as Row | undefined; return row ? mapEvent(row) : null; }
  eventsForWake(wakeId: string): EventRecord[] { return this.readStream(wakeStream(wakeId)); }
  wake(id: string): WakeSnapshot | null { const row = this.db.prepare("SELECT * FROM wakes WHERE id=?").get(id) as Row | undefined; return row ? mapWake(row) : null; }
  wakeByTrigger(agent: string, triggerRef: string): WakeSnapshot | null {
    const direct = this.db.prepare("SELECT * FROM wakes WHERE agent=? AND trigger_ref=?").get(agent, triggerRef) as Row | undefined;
    if (direct) return mapWake(direct);
    const coalesced = this.db.prepare(`SELECT w.* FROM events e JOIN wakes w ON e.stream_id='wake:'||w.id
      WHERE e.type='wake.trigger_coalesced' AND json_extract(e.data,'$.triggerRef')=? AND w.agent=? LIMIT 1`).get(triggerRef, agent) as Row | undefined;
    return coalesced ? mapWake(coalesced) : null;
  }
  queuedWakeForAgent(agent: string): WakeSnapshot | null { const row = this.db.prepare("SELECT * FROM wakes WHERE agent=? AND status='queued' ORDER BY enqueued_seq LIMIT 1").get(agent) as Row | undefined; return row ? mapWake(row) : null; }
  action(id: string): ActionSnapshot | null { const row = this.db.prepare("SELECT * FROM actions WHERE id=?").get(id) as Row | undefined; return row ? mapAction(row) : null; }
  goalsForOwner(owner: string): GoalSnapshot[] { return (this.db.prepare("SELECT * FROM goals WHERE owner=? ORDER BY id").all(owner) as Row[]).map(mapGoal); }
  goal(id: string): GoalSnapshot | null { return this.#getGoal(id); }
  triggeringMail(): MailSnapshot[] { return (this.db.prepare("SELECT * FROM mailbox WHERE read_at IS NULL AND level IN ('decision','emergency') ORDER BY rowid").all() as Row[]).map(mapMail); }
  eventsSince(seq: number, types?: string[]): EventRecord[] {
    const events = (this.db.prepare("SELECT * FROM events WHERE seq>? ORDER BY seq").all(seq) as Row[]).map(mapEvent);
    return types?.length ? events.filter((event) => types.includes(event.type)) : events;
  }
  searchEvents(query: string, limit = 50): EventRecord[] {
    return (this.db.prepare("SELECT e.* FROM events_fts f JOIN events e ON e.seq=f.rowid WHERE events_fts MATCH ? ORDER BY rank LIMIT ?").all(query, limit) as Row[]).map(mapEvent);
  }
  metricSamples(goalId: string): MetricSample[] {
    return (this.db.prepare("SELECT data FROM events WHERE type='metric.sampled' AND json_extract(data,'$.goalId')=? ORDER BY seq").all(goalId) as Array<{ data: string }>).map((row) => JSON.parse(row.data) as MetricSample);
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
      this.#insertEvent({ streamId: controlStream("actions"), ts: this.#now(), actor: approver, type: `action.${status}_decision`, data: { actionId: id, reason, evidence } });
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
  #project(projection: ProjectionName, snapshot: unknown, actor: string, type: string, wakeId?: string, ts?: string, streamId?: string): EventRecord {
    return this.#transaction(() => this.#recordProjection(projection, snapshot, actor, type, wakeId, ts, undefined, streamId));
  }

  #recordProjection(projection: ProjectionName, snapshot: unknown, actor: string, type: string, wakeId?: string, ts?: string, expectedSeq?: number, streamId?: string): EventRecord {
    const event = this.#insertEvent({ streamId: streamId ?? (wakeId ? wakeStream(wakeId) : controlStream(projection)), ts: ts ?? this.#now(), actor, type, data: { projection, snapshot } as unknown as JsonValue }, expectedSeq);
    this.#faultInjector?.("after_event_before_projection");
    this.#applyProjection(projection, snapshot, event.seq);
    return event;
  }

  #insertEvent(input: EventInput, expectedSeq?: number): EventRecord {
    if (!input.streamId.trim() || !input.actor.trim() || !input.type.trim()) throw new Error("event streamId, actor and type are required");
    const streamSeq = Number((this.db.prepare("SELECT COALESCE(MAX(stream_seq),0)+1 AS next FROM events WHERE stream_id=?").get(input.streamId) as { next: number }).next);
    const result = expectedSeq === undefined
      ? this.db.prepare("INSERT INTO events(stream_id,stream_seq,ts,actor,type,data,ignorable) VALUES (?,?,?,?,?,json(?),?)").run(input.streamId, streamSeq, input.ts, input.actor, input.type, JSON.stringify(input.data), input.ignorable === true ? 1 : null)
      : this.db.prepare("INSERT INTO events(seq,stream_id,stream_seq,ts,actor,type,data,ignorable) VALUES (?,?,?,?,?,?,json(?),?)").run(expectedSeq, input.streamId, streamSeq, input.ts, input.actor, input.type, JSON.stringify(input.data), input.ignorable === true ? 1 : null);
    return { ...input, seq: Number(result.lastInsertRowid), streamSeq };
  }

  #nextEventSeq(): number {
    const row = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='events'").get() as { seq: number } | undefined;
    return Number(row?.seq ?? 0) + 1;
  }

  #applyProjection(projection: ProjectionName, raw: unknown, sourceSeq: number): void {
    if (projection === "goals") {
      const v = raw as GoalSnapshot;
      this.db.prepare(`INSERT INTO goals VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,objective=excluded.objective,owner=excluded.owner,phase=excluded.phase,revision=excluded.revision`).run(v.id,v.parentId,v.objective,v.owner,v.phase,v.revision);
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

  #migrateLegacy(): void {
    this.#transaction(() => {
      this.db.exec(`PRAGMA defer_foreign_keys=ON;
        DROP TRIGGER IF EXISTS events_no_update; DROP TRIGGER IF EXISTS events_no_delete; DROP TRIGGER IF EXISTS events_fts_insert;
        DROP TRIGGER IF EXISTS wakes_valid_transition; DROP TRIGGER IF EXISTS actions_valid_transition; DROP TRIGGER IF EXISTS goals_valid_transition;
        DROP INDEX IF EXISTS events_agent_kind_seq; DROP INDEX IF EXISTS events_wake_seq; DROP INDEX IF EXISTS events_coalesced_trigger;
        DROP INDEX IF EXISTS events_actor_type_seq; DROP INDEX IF EXISTS events_stream_seq;
        DROP INDEX IF EXISTS wakes_one_active_agent; DROP INDEX IF EXISTS wakes_queue_order; DROP INDEX IF EXISTS schedule_due; DROP INDEX IF EXISTS actions_agent_status;
        DROP TABLE IF EXISTS events_fts;

        ALTER TABLE goals RENAME TO goals_legacy; ${createGoals}
        INSERT INTO goals(id,parent_id,objective,owner,phase,revision) SELECT id,parent_id,objective,owner,phase,revision FROM goals_legacy;
        DROP TABLE goals_legacy;`);

      const wakeColumns = new Set((this.db.prepare("PRAGMA table_info(wakes)").all() as Array<{ name: string }>).map((row) => row.name));
      if (!wakeColumns.has("enqueued_seq")) {
        this.db.exec(`ALTER TABLE wakes RENAME TO wakes_legacy; ${createWakes}
          INSERT INTO wakes SELECT id,agent,trigger_ref,status,lease_until,attempt,started_at,ended_at,rowid,
            CASE WHEN status IN ('leased','running') THEN 'legacy:'||id||':'||attempt ELSE NULL END,NULL FROM wakes_legacy;
          DROP TABLE wakes_legacy;`);
      }

      const actionColumns = new Set((this.db.prepare("PRAGMA table_info(actions)").all() as Array<{ name: string }>).map((row) => row.name));
      if (!actionColumns.has("connector")) {
        this.db.exec(`ALTER TABLE actions RENAME TO actions_legacy; ${createActions}
          INSERT INTO actions SELECT id,agent,kind,'legacy',payload,reason,evidence,gated,status,reconciled_at,external_ref,audit_advice,advice_acked FROM actions_legacy;
          DROP TABLE actions_legacy;`);
      }

      const eventColumns = new Set((this.db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>).map((row) => row.name));
      if (!eventColumns.has("stream_id")) {
        this.db.exec(`ALTER TABLE events RENAME TO events_legacy;
          CREATE TABLE events (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            stream_id TEXT NOT NULL,
            stream_seq INTEGER NOT NULL CHECK(stream_seq > 0),
            ts TEXT NOT NULL,
            actor TEXT NOT NULL,
            type TEXT NOT NULL,
            data TEXT NOT NULL CHECK(json_valid(data)),
            ignorable INTEGER CHECK(ignorable IS NULL OR ignorable = 1),
            UNIQUE(stream_id, stream_seq)
          ) STRICT;
          INSERT INTO events(seq,stream_id,stream_seq,ts,actor,type,data,ignorable)
          SELECT seq,stream_id,ROW_NUMBER() OVER (PARTITION BY stream_id ORDER BY seq),ts,agent,kind,data,NULL FROM (
            SELECT seq,ts,agent,kind,data,CASE WHEN wake_id IS NULL THEN 'control:'||agent ELSE 'wake:'||wake_id END AS stream_id FROM events_legacy
          );
          DROP TABLE events_legacy;`);
      } else if (!eventColumns.has("ignorable")) {
        this.db.exec("ALTER TABLE events ADD COLUMN ignorable INTEGER CHECK(ignorable IS NULL OR ignorable = 1)");
      }
      this.db.exec(`${indexesAndTriggers} INSERT INTO events_fts(events_fts) VALUES('rebuild'); PRAGMA user_version=${SQLITE_SCHEMA_VERSION};`);
    });
  }

  #transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  #now(): string { return this.#clock.now().toISOString(); }
}

function mapEvent(r: Row): EventRecord { return { seq: Number(r.seq), streamId: String(r.stream_id), streamSeq: Number(r.stream_seq), ts: String(r.ts), actor: String(r.actor), type: String(r.type), data: JSON.parse(String(r.data)) as JsonValue, ...(Number(r.ignorable) === 1 ? { ignorable: true as const } : {}) }; }
function mapGoal(r: Row): GoalSnapshot { return { id: String(r.id), parentId: r.parent_id === null ? null : String(r.parent_id), objective: String(r.objective), owner: String(r.owner), phase: String(r.phase) as GoalSnapshot["phase"], revision: Number(r.revision) }; }
function mapSchedule(r: Row): ScheduleSnapshot { return {id:String(r.id),agent:String(r.agent),nextWakeAt:String(r.next_wake_at),reason:String(r.reason),setBy:String(r.set_by)}; }
function mapWake(r: Row): WakeSnapshot { return {id:String(r.id),agent:String(r.agent),triggerRef:String(r.trigger_ref),status:String(r.status) as WakeSnapshot["status"],leaseUntil:r.lease_until===null?null:String(r.lease_until),attempt:Number(r.attempt),startedAt:r.started_at===null?null:String(r.started_at),endedAt:r.ended_at===null?null:String(r.ended_at),enqueuedSeq:Number(r.enqueued_seq),leaseToken:r.lease_token===null?null:String(r.lease_token),runnerPid:r.runner_pid===null?null:Number(r.runner_pid)}; }
function mapMail(r: Row): MailSnapshot { return {id:String(r.id),to:String(r.to_agent),from:String(r.from_agent),level:String(r.level) as MailSnapshot["level"],body:JSON.parse(String(r.body)),readAt:r.read_at===null?null:String(r.read_at)}; }
function mapAction(r: Row): ActionSnapshot { return {id:String(r.id),agent:String(r.agent),kind:String(r.kind),connector:String(r.connector),payload:JSON.parse(String(r.payload)),reason:String(r.reason),evidence:JSON.parse(String(r.evidence)),gated:Boolean(r.gated),status:String(r.status) as ActionStatus,reconciledAt:r.reconciled_at===null?null:String(r.reconciled_at),externalRef:r.external_ref===null?null:String(r.external_ref),auditAdvice:r.audit_advice===null?null:JSON.parse(String(r.audit_advice)),adviceAcked:Boolean(r.advice_acked)}; }
