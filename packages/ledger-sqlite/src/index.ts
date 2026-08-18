import { DatabaseSync } from "node:sqlite";
import {
  assertActionRequest,
  assertActionTransition,
  assertGoalSnapshot,
  assertWakeTransition,
  type ActionSnapshot,
  type ActionStatus,
  type EventRecord,
  type GoalSnapshot,
  type JsonValue,
  type Ledger,
  type MailSnapshot,
  type ProjectionName,
  type ScheduleSnapshot,
  type WakeSnapshot,
} from "@goah/ledger-contract";

type FaultPoint = "after_event_before_projection";
type FaultInjector = (point: FaultPoint) => void;
type Row = Record<string, unknown>;

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA user_version = 1;

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

CREATE TABLE IF NOT EXISTS wakes (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  trigger_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','leased','running','done','abnormal','merge_blocked')),
  lease_until TEXT,
  attempt INTEGER NOT NULL CHECK(attempt >= 0),
  started_at TEXT,
  ended_at TEXT,
  UNIQUE(agent, trigger_ref),
  CHECK((status IN ('leased','running') AND lease_until IS NOT NULL) OR status NOT IN ('leased','running')),
  CHECK((status IN ('done','abnormal','merge_blocked') AND ended_at IS NOT NULL) OR status NOT IN ('done','abnormal','merge_blocked'))
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS wakes_one_active_agent
ON wakes(agent) WHERE status IN ('leased','running');

CREATE TABLE IF NOT EXISTS mailbox (
  id TEXT PRIMARY KEY,
  to_agent TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('fyi','decision','emergency')),
  body TEXT NOT NULL CHECK(json_valid(body)),
  read_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
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
) STRICT;

CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TRIGGER IF NOT EXISTS wakes_valid_transition BEFORE UPDATE OF status ON wakes
WHEN NOT (
  (OLD.status = 'queued' AND NEW.status IN ('leased','abnormal')) OR
  (OLD.status = 'leased' AND NEW.status IN ('queued','running','abnormal')) OR
  (OLD.status = 'running' AND NEW.status IN ('queued','done','abnormal','merge_blocked'))
)
BEGIN SELECT RAISE(ABORT, 'invalid wake transition'); END;

CREATE TRIGGER IF NOT EXISTS actions_valid_transition BEFORE UPDATE OF status ON actions
WHEN NOT (
  (OLD.status = 'requested' AND NEW.status IN ('approved','failed')) OR
  (OLD.status = 'approved' AND NEW.status IN ('dispatching','failed')) OR
  (OLD.status = 'dispatching' AND NEW.status IN ('confirmed','failed','unknown')) OR
  (OLD.status = 'unknown' AND NEW.status IN ('dispatching','confirmed','failed'))
)
BEGIN SELECT RAISE(ABORT, 'invalid action transition'); END;
`;

export interface SqliteLedgerOptions {
  faultInjector?: FaultInjector;
}

export class SqliteLedger implements Ledger {
  readonly db: DatabaseSync;
  readonly #faultInjector: FaultInjector | undefined;

  constructor(path = ":memory:", options: SqliteLedgerOptions = {}) {
    this.db = new DatabaseSync(path);
    this.db.exec(schema);
    this.#faultInjector = options.faultInjector;
  }

  close(): void {
    this.db.close();
  }

  appendEvent(input: Omit<EventRecord, "seq">): EventRecord {
    return this.#transaction(() => this.#insertEvent(input));
  }

  putGoal(goal: GoalSnapshot, actor: string, wakeId?: string): EventRecord {
    assertGoalSnapshot(goal);
    const current = this.#getGoal(goal.id);
    if (current) {
      if (goal.revision !== current.revision + 1) throw new Error("goal revision CAS failed");
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

  enqueueWake(wake: WakeSnapshot, actor: string): { event: EventRecord; created: boolean } {
    if (actor !== "supervisor") throw new Error("only supervisor may enqueue wakes");
    if (wake.status !== "queued" || wake.attempt !== 0 || wake.leaseUntil || wake.startedAt || wake.endedAt) {
      throw new Error("new wake must be pristine and queued");
    }
    const duplicate = this.db.prepare("SELECT * FROM wakes WHERE agent = ? AND trigger_ref = ?").get(wake.agent, wake.triggerRef) as Row | undefined;
    if (duplicate) {
      const existing = mapWake(duplicate);
      const event = this.events().findLast((item) => item.kind === "wake.enqueued" && (item.data as { snapshot?: { id?: string } }).snapshot?.id === existing.id);
      if (!event) throw new Error("wake projection has no source event");
      return { event, created: false };
    }
    return { event: this.#project("wakes", wake, actor, "wake.enqueued"), created: true };
  }

  claimNextWake(now: string, leaseUntil: string): WakeSnapshot | null {
    return this.#transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM wakes w
        WHERE status = 'queued'
          AND NOT EXISTS (
            SELECT 1 FROM wakes active
            WHERE active.agent = w.agent AND active.status IN ('leased','running')
          )
        ORDER BY id LIMIT 1
      `).get() as Row | undefined;
      if (!row) return null;
      const current = mapWake(row);
      const next: WakeSnapshot = { ...current, status: "leased", leaseUntil, attempt: current.attempt + 1 };
      this.#recordProjection("wakes", next, "supervisor", "wake.leased", next.id, now);
      return next;
    });
  }

  markWakeRunning(id: string, now: string): WakeSnapshot {
    const current = this.#requiredWake(id);
    const next: WakeSnapshot = { ...current, status: "running", startedAt: now };
    this.#project("wakes", next, "supervisor", "wake.running", id, now);
    return next;
  }

  finishWake(id: string, status: "done" | "abnormal" | "merge_blocked", now: string): WakeSnapshot {
    const current = this.#requiredWake(id);
    const next: WakeSnapshot = { ...current, status, leaseUntil: null, endedAt: now };
    this.#project("wakes", next, "supervisor", `wake.${status}`, id, now);
    return next;
  }

  recoverExpiredWakes(now: string): { requeued: WakeSnapshot[]; abnormal: WakeSnapshot[] } {
    const rows = this.db.prepare("SELECT * FROM wakes WHERE status IN ('leased','running') AND lease_until <= ? ORDER BY id").all(now) as Row[];
    const result = { requeued: [] as WakeSnapshot[], abnormal: [] as WakeSnapshot[] };
    for (const row of rows) {
      const current = mapWake(row);
      const running = current.status === "running";
      const next: WakeSnapshot = {
        ...current,
        status: running ? "abnormal" : "queued",
        leaseUntil: null,
        endedAt: running ? now : null,
      };
      this.#project("wakes", next, "supervisor", running ? "wake.expired_abnormal" : "wake.lease_expired", current.id, now);
      (running ? result.abnormal : result.requeued).push(next);
    }
    return result;
  }

  requestAction(action: ActionSnapshot, wakeId?: string): EventRecord {
    assertActionRequest(action);
    return this.#project("actions", action, action.agent, "action.requested", wakeId);
  }

  transitionAction(
    id: string,
    status: ActionStatus,
    patch: Partial<Pick<ActionSnapshot, "externalRef" | "reconciledAt">> = {},
  ): ActionSnapshot {
    const current = this.#requiredAction(id);
    assertActionTransition(current.status, status);
    if (current.status === "unknown" && (status === "confirmed" || status === "failed") && !patch.reconciledAt) {
      throw new Error("unknown action requires a reconciliation timestamp");
    }
    if (patch.reconciledAt && current.status !== "unknown") throw new Error("reconciledAt is only written after unknown is queried");
    if (patch.reconciledAt && status !== "confirmed" && status !== "failed") throw new Error("reconciliation must resolve to a final state");
    const next: ActionSnapshot = { ...current, ...patch, status };
    this.#project("actions", next, "supervisor", `action.${status}`);
    return next;
  }

  recoverDispatchingActions(): ActionSnapshot[] {
    const rows = this.db.prepare("SELECT id FROM actions WHERE status = 'dispatching' ORDER BY id").all() as Array<{ id: string }>;
    return rows.map(({ id }) => this.transitionAction(id, "unknown"));
  }

  putMail(mail: MailSnapshot, actor: string, wakeId?: string): EventRecord {
    if (mail.from !== actor && actor !== "supervisor") throw new Error("mail sender does not match actor");
    return this.#project("mailbox", mail, actor, "mail.put", wakeId);
  }

  markMailReadForAgent(agent: string, readAt: string, wakeId: string): MailSnapshot[] {
    const unread = this.mailbox().filter((mail) => mail.to === agent && mail.readAt === null);
    return this.#transaction(() => unread.map((mail) => {
      const next = { ...mail, readAt };
      this.#recordProjection("mailbox", next, "supervisor", "mail.read", wakeId, readAt);
      return next;
    }));
  }

  events(): EventRecord[] {
    return (this.db.prepare("SELECT * FROM events ORDER BY seq").all() as Row[]).map(mapEvent);
  }

  goals(): GoalSnapshot[] {
    return (this.db.prepare("SELECT * FROM goals ORDER BY id").all() as Row[]).map(mapGoal);
  }

  schedules(): ScheduleSnapshot[] {
    return (this.db.prepare("SELECT * FROM schedule ORDER BY id").all() as Row[]).map(mapSchedule);
  }

  wakes(): WakeSnapshot[] {
    return (this.db.prepare("SELECT * FROM wakes ORDER BY id").all() as Row[]).map(mapWake);
  }

  actions(): ActionSnapshot[] {
    return (this.db.prepare("SELECT * FROM actions ORDER BY id").all() as Row[]).map(mapAction);
  }

  mailbox(): MailSnapshot[] {
    return (this.db.prepare("SELECT * FROM mailbox ORDER BY id").all() as Row[]).map(mapMail);
  }

  rebuildProjections(): void {
    const source = this.events();
    this.#transaction(() => {
      this.db.exec("DELETE FROM actions; DELETE FROM mailbox; DELETE FROM wakes; DELETE FROM schedule; DELETE FROM goals;");
      for (const event of source) {
        const data = event.data as { projection?: ProjectionName; snapshot?: unknown };
        if (data.projection && data.snapshot) this.#applyProjection(data.projection, data.snapshot);
      }
    });
  }

  #assertGoalAuthority(parentId: string | null, actor: string): void {
    if (parentId === null) {
      if (actor !== "human") throw new Error("only human may modify a root goal");
      return;
    }
    const parent = this.#getGoal(parentId);
    if (!parent) throw new Error("parent goal does not exist");
    if (parent.owner !== actor) throw new Error("only the parent goal owner may modify a child goal");
  }

  #assertBudgetAllocation(goal: GoalSnapshot): void {
    if (!goal.budget || !goal.parentId) return;
    const parent = this.#getGoal(goal.parentId);
    if (!parent?.budget) throw new Error("budgeted child requires a budgeted parent");
    if (parent.budget.currency !== goal.budget.currency || parent.budget.window !== goal.budget.window) {
      throw new Error("child budget currency and window must match parent");
    }
    const siblingTotal = this.goals()
      .filter((item) => item.parentId === goal.parentId && item.id !== goal.id)
      .reduce((sum, item) => sum + (item.budget?.limit ?? 0), 0);
    if (siblingTotal + goal.budget.limit > parent.budget.limit) throw new Error("child budgets exceed parent budget");
  }

  #getGoal(id: string): GoalSnapshot | null {
    const row = this.db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as Row | undefined;
    return row ? mapGoal(row) : null;
  }

  #requiredWake(id: string): WakeSnapshot {
    const row = this.db.prepare("SELECT * FROM wakes WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new Error(`wake not found: ${id}`);
    return mapWake(row);
  }

  #requiredAction(id: string): ActionSnapshot {
    const row = this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new Error(`action not found: ${id}`);
    return mapAction(row);
  }

  #project(projection: ProjectionName, snapshot: unknown, agent: string, kind: string, wakeId?: string, ts?: string): EventRecord {
    return this.#transaction(() => this.#recordProjection(projection, snapshot, agent, kind, wakeId, ts));
  }

  #recordProjection(projection: ProjectionName, snapshot: unknown, agent: string, kind: string, wakeId?: string, ts?: string): EventRecord {
    const event = this.#insertEvent({
      ts: ts ?? new Date().toISOString(),
      agent,
      kind,
      data: { projection, snapshot } as unknown as JsonValue,
      wakeId: wakeId ?? null,
    });
    this.#faultInjector?.("after_event_before_projection");
    this.#applyProjection(projection, snapshot);
    return event;
  }

  #insertEvent(input: Omit<EventRecord, "seq">): EventRecord {
    const result = this.db.prepare("INSERT INTO events(ts, agent, kind, data, wake_id) VALUES (?, ?, ?, json(?), ?)")
      .run(input.ts, input.agent, input.kind, JSON.stringify(input.data), input.wakeId);
    return { ...input, seq: Number(result.lastInsertRowid) };
  }

  #applyProjection(projection: ProjectionName, raw: unknown): void {
    if (projection === "goals") {
      const value = raw as GoalSnapshot;
      this.db.prepare(`INSERT INTO goals VALUES (?, ?, ?, json(?), json(?), ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id, objective=excluded.objective, metric=excluded.metric,
        target=excluded.target, owner=excluded.owner, budget=excluded.budget, phase=excluded.phase, revision=excluded.revision`)
        .run(value.id, value.parentId, value.objective, JSON.stringify(value.metric), JSON.stringify(value.target), value.owner,
          value.budget ? JSON.stringify(value.budget) : null, value.phase, value.revision);
      return;
    }
    if (projection === "schedule") {
      const value = raw as ScheduleSnapshot;
      this.db.prepare(`INSERT INTO schedule VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET agent=excluded.agent, next_wake_at=excluded.next_wake_at, reason=excluded.reason, set_by=excluded.set_by`)
        .run(value.id, value.agent, value.nextWakeAt, value.reason, value.setBy);
      return;
    }
    if (projection === "wakes") {
      const value = raw as WakeSnapshot;
      this.db.prepare(`INSERT INTO wakes VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET agent=excluded.agent, trigger_ref=excluded.trigger_ref, status=excluded.status,
        lease_until=excluded.lease_until, attempt=excluded.attempt, started_at=excluded.started_at, ended_at=excluded.ended_at`)
        .run(value.id, value.agent, value.triggerRef, value.status, value.leaseUntil, value.attempt, value.startedAt, value.endedAt);
      return;
    }
    if (projection === "mailbox") {
      const value = raw as MailSnapshot;
      this.db.prepare(`INSERT INTO mailbox VALUES (?, ?, ?, ?, json(?), ?)
        ON CONFLICT(id) DO UPDATE SET to_agent=excluded.to_agent, from_agent=excluded.from_agent, level=excluded.level,
        body=excluded.body, read_at=excluded.read_at`)
        .run(value.id, value.to, value.from, value.level, JSON.stringify(value.body), value.readAt);
      return;
    }
    const value = raw as ActionSnapshot;
    this.db.prepare(`INSERT INTO actions VALUES (?, ?, ?, json(?), ?, json(?), ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET agent=excluded.agent, kind=excluded.kind, payload=excluded.payload, reason=excluded.reason,
      evidence=excluded.evidence, gated=excluded.gated, status=excluded.status, reconciled_at=excluded.reconciled_at,
      external_ref=excluded.external_ref, audit_advice=excluded.audit_advice, advice_acked=excluded.advice_acked`)
      .run(value.id, value.agent, value.kind, JSON.stringify(value.payload), value.reason, JSON.stringify(value.evidence),
        value.gated ? 1 : 0, value.status, value.reconciledAt, value.externalRef,
        value.auditAdvice === null ? null : JSON.stringify(value.auditAdvice), value.adviceAcked ? 1 : 0);
  }

  #transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function mapEvent(row: Row): EventRecord {
  return { seq: Number(row.seq), ts: String(row.ts), agent: String(row.agent), kind: String(row.kind), data: JSON.parse(String(row.data)) as JsonValue, wakeId: row.wake_id === null ? null : String(row.wake_id) };
}
function mapGoal(row: Row): GoalSnapshot {
  return { id: String(row.id), parentId: row.parent_id === null ? null : String(row.parent_id), objective: String(row.objective), metric: JSON.parse(String(row.metric)), target: JSON.parse(String(row.target)), owner: String(row.owner), budget: row.budget === null ? null : JSON.parse(String(row.budget)), phase: String(row.phase), revision: Number(row.revision) } as GoalSnapshot;
}
function mapSchedule(row: Row): ScheduleSnapshot {
  return { id: String(row.id), agent: String(row.agent), nextWakeAt: String(row.next_wake_at), reason: String(row.reason), setBy: String(row.set_by) };
}
function mapWake(row: Row): WakeSnapshot {
  return { id: String(row.id), agent: String(row.agent), triggerRef: String(row.trigger_ref), status: String(row.status) as WakeSnapshot["status"], leaseUntil: row.lease_until === null ? null : String(row.lease_until), attempt: Number(row.attempt), startedAt: row.started_at === null ? null : String(row.started_at), endedAt: row.ended_at === null ? null : String(row.ended_at) };
}
function mapMail(row: Row): MailSnapshot {
  return { id: String(row.id), to: String(row.to_agent), from: String(row.from_agent), level: String(row.level) as MailSnapshot["level"], body: JSON.parse(String(row.body)), readAt: row.read_at === null ? null : String(row.read_at) };
}
function mapAction(row: Row): ActionSnapshot {
  return { id: String(row.id), agent: String(row.agent), kind: String(row.kind), payload: JSON.parse(String(row.payload)), reason: String(row.reason), evidence: JSON.parse(String(row.evidence)), gated: Boolean(row.gated), status: String(row.status) as ActionStatus, reconciledAt: row.reconciled_at === null ? null : String(row.reconciled_at), externalRef: row.external_ref === null ? null : String(row.external_ref), auditAdvice: row.audit_advice === null ? null : JSON.parse(String(row.audit_advice)), adviceAcked: Boolean(row.advice_acked) };
}
