export const CONTRACT_VERSION = "0.2.0" as const;
export const CONTRACT_STABILITY = "experimental" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type WakeStatus =
  | "queued"
  | "leased"
  | "running"
  | "done"
  | "abnormal"
  | "merge_blocked";

export type ActionStatus =
  | "requested"
  | "approved"
  | "dispatching"
  | "confirmed"
  | "failed"
  | "unknown";

export type ProjectionName = "goals" | "schedule" | "wakes" | "mailbox" | "actions";

export interface EventRecord {
  seq: number;
  ts: string;
  agent: string;
  kind: string;
  data: JsonValue;
  wakeId: string | null;
}

export interface MetricContract {
  source: string;
  window: string;
  direction: "increase" | "decrease" | "at_least" | "at_most";
  target: number;
  freshnessMs: number;
  onMissing: "abnormal" | "wake_owner";
  onStale: "abnormal" | "wake_owner";
  sustainForMs?: number;
  guardrails?: Array<{ metric: string; direction: "at_least" | "at_most"; target: number }>;
}

export interface MetricSample {
  goalId: string;
  source: string;
  observedAt: string;
  value: number | null;
  guardrails?: Record<string, number>;
}

export interface MetricEvaluation {
  goalId: string;
  status: "met" | "missed" | "missing" | "stale" | "guardrail_breached";
  shouldWakeOwner: boolean;
  evaluatedAt: string;
  value: number | null;
}

export interface BudgetContract {
  currency: string;
  limit: number;
  window: "goal" | "day" | "month";
}

export interface GoalSnapshot {
  id: string;
  parentId: string | null;
  objective: string;
  metric: MetricContract;
  target: JsonValue;
  owner: string;
  budget: BudgetContract | null;
  phase: string;
  revision: number;
}

export interface ScheduleSnapshot {
  id: string;
  agent: string;
  nextWakeAt: string;
  reason: string;
  setBy: string;
}

export interface WakeSnapshot {
  id: string;
  agent: string;
  triggerRef: string;
  status: WakeStatus;
  leaseUntil: string | null;
  attempt: number;
  startedAt: string | null;
  endedAt: string | null;
  enqueuedSeq: number;
  leaseToken: string | null;
  runnerPid: number | null;
}

export type MailLevel = "fyi" | "decision" | "emergency";
export interface MailSnapshot {
  id: string;
  to: string;
  from: string;
  level: MailLevel;
  body: JsonValue;
  readAt: string | null;
}

export interface ActionSnapshot {
  id: string;
  agent: string;
  kind: string;
  connector: string;
  payload: JsonValue;
  reason: string;
  evidence: number[];
  gated: boolean;
  status: ActionStatus;
  reconciledAt: string | null;
  externalRef: string | null;
  auditAdvice: AuditAdvice | null;
  adviceAcked: boolean;
}

export interface AuditAdvice {
  by: string;
  at: string;
  body: JsonValue;
  evidence: number[];
}

export interface Handoff {
  observations: string[];
  results: string[];
  nextSteps: string[];
  blocker?: string;
}

export interface MailDraft {
  to: string;
  level: MailLevel;
  body: JsonValue;
}

export interface WakeOutput {
  handoff: Handoff;
  mail: MailDraft[];
  nextWakeAt: string | null;
}

export interface RunLimits {
  maxTotalTokens: number;
  maxWallClockMs: number;
  handoffReserveTokens: number;
  handoffReserveWallClockMs: number;
}

export interface RunnerTraceEvent {
  kind: string;
  data: JsonValue;
}

export type AgentRole = "child" | "ceo" | "verifier" | "audit";
export type AgentCapability =
  | "ledger.search"
  | "budget.read"
  | "mail.send"
  | "schedule.set"
  | "action.submit"
  | "audit.ack"
  | "audit.write"
  | "goal.put";

export interface AgentProfile {
  agent: string;
  role: AgentRole;
  capabilities?: AgentCapability[];
  systemPrompt?: string;
}

export interface RunRequest {
  wake: WakeSnapshot;
  context: JsonValue;
  limits: RunLimits;
  now(): string;
  emit(event: RunnerTraceEvent): void;
  rpc?(method: AgentCapability, params: JsonValue): Promise<JsonValue>;
}

export type RunnerResult =
  | { outcome: "handoff"; output: WakeOutput; tokensUsed: number }
  | { outcome: "abnormal"; reason: string; tokensUsed: number };

export interface RunnerHandle {
  pid: number | null;
  begin(): void;
  result: Promise<RunnerResult>;
  terminate(): Promise<void>;
}

export interface Runner {
  readonly isolation: "process";
  prepare(request: RunRequest): RunnerHandle;
  terminateProcess(pid: number): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface ConnectorCapability {
  kind: string;
  nativeIdempotency: boolean;
  query: "by_idempotency_key" | "by_external_ref" | "none";
  automaticRetry: boolean;
  risk: "reversible" | "money" | "irreversible";
  constraints: {
    allowedAccounts?: string[];
    allowedEnvironments?: string[];
    maxAmount?: number;
  };
}

export interface ConnectorManifest {
  contractVersion: typeof CONTRACT_VERSION;
  connector: string;
  dryRun: boolean;
  capabilities: ConnectorCapability[];
}

export interface ConnectorDispatchResult {
  status: "confirmed" | "failed";
  externalRef?: string;
}

export interface ConnectorQueryResult {
  status: "confirmed" | "failed" | "pending";
  externalRef?: string;
}

export interface ConnectorProcessSpec {
  manifest: ConnectorManifest;
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface MetricProcessSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface BudgetExposure {
  currency: string;
  limit: number;
  reserved: number;
  actual: number;
  available: number;
}

export interface HandoffCommit {
  agent: string;
  wakeId: string;
  ts: string;
  output: WakeOutput;
  outgoingMail: MailSnapshot[];
  schedule: ScheduleSnapshot | null;
}

export interface Ledger {
  appendEvent(input: Omit<EventRecord, "seq">): EventRecord;
  putGoal(goal: GoalSnapshot, actor: string, wakeId?: string): EventRecord;
  putSchedule(schedule: ScheduleSnapshot, actor: string, wakeId?: string): EventRecord;
  enqueueWake(wake: WakeSnapshot, actor: string): { event: EventRecord; created: boolean };
  claimNextWake(now: string, leaseUntil: string, leaseToken: string): WakeSnapshot | null;
  markWakeRunning(id: string, now: string, leaseToken: string): WakeSnapshot;
  attachWakeProcess(id: string, leaseToken: string, pid: number, now: string): WakeSnapshot;
  finishWake(id: string, status: "done" | "abnormal" | "merge_blocked", now: string): WakeSnapshot;
  expiredWakes(now: string): WakeSnapshot[];
  recoverExpiredWake(id: string, now: string): WakeSnapshot;
  appendRunnerEvent(input: Omit<EventRecord, "seq">, leaseToken: string): EventRecord;
  requestAction(action: ActionSnapshot, actor: string, wakeId?: string): EventRecord;
  approveAction(id: string, approver: string, reason: string, evidence: number[]): ActionSnapshot;
  rejectAction(id: string, approver: string, reason: string, evidence: number[]): ActionSnapshot;
  transitionAction(id: string, status: ActionStatus, patch?: Partial<Pick<ActionSnapshot, "externalRef" | "reconciledAt">>): ActionSnapshot;
  recoverDispatchingActions(): ActionSnapshot[];
  putAuditAdvice(id: string, advice: Omit<AuditAdvice, "at">, wakeId?: string): ActionSnapshot;
  ackAuditAdvice(id: string, agent: string): ActionSnapshot;
  putMail(mail: MailSnapshot, actor: string, wakeId?: string): EventRecord;
  commitHandoff(commit: HandoffCommit): EventRecord;
  dueSchedules(now: string): ScheduleSnapshot[];
  unreadMail(agent: string): MailSnapshot[];
  unackedAuditAdvice(agent: string): ActionSnapshot[];
  lastEvent(agent: string, kind: string): EventRecord | null;
  eventsForWake(wakeId: string): EventRecord[];
  wake(id: string): WakeSnapshot | null;
  wakeByTrigger(agent: string, triggerRef: string): WakeSnapshot | null;
  queuedWakeForAgent(agent: string): WakeSnapshot | null;
  action(id: string): ActionSnapshot | null;
  goalsForOwner(owner: string): GoalSnapshot[];
  goal(id: string): GoalSnapshot | null;
  triggeringMail(): MailSnapshot[];
  eventsSince(seq: number, kinds?: string[]): EventRecord[];
  searchEvents(query: string, limit?: number): EventRecord[];
  budgetExposure(agent: string, at: string): BudgetExposure | null;
  metricSamples(goalId: string): MetricSample[];
  events(): EventRecord[];
  goals(): GoalSnapshot[];
  schedules(): ScheduleSnapshot[];
  wakes(): WakeSnapshot[];
  actions(): ActionSnapshot[];
  mailbox(): MailSnapshot[];
  rebuildProjections(): void;
  close(): void;
}

const wakeTransitions: Record<WakeStatus, readonly WakeStatus[]> = {
  queued: ["leased", "abnormal"],
  leased: ["queued", "running", "abnormal"],
  running: ["done", "abnormal", "merge_blocked"],
  done: [],
  abnormal: [],
  merge_blocked: [],
};

const actionTransitions: Record<ActionStatus, readonly ActionStatus[]> = {
  requested: ["approved", "failed"],
  approved: ["dispatching", "failed"],
  dispatching: ["confirmed", "failed", "unknown"],
  unknown: ["dispatching", "confirmed", "failed"],
  confirmed: [],
  failed: [],
};

export function assertWakeTransition(from: WakeStatus, to: WakeStatus): void {
  if (!wakeTransitions[from].includes(to)) throw new Error(`invalid wake transition: ${from} -> ${to}`);
}

export function assertActionTransition(from: ActionStatus, to: ActionStatus): void {
  if (!actionTransitions[from].includes(to)) throw new Error(`invalid action transition: ${from} -> ${to}`);
}

export function assertHandoff(value: Handoff): void {
  if (!Array.isArray(value.observations) || !Array.isArray(value.results) || !Array.isArray(value.nextSteps)) {
    throw new Error("invalid handoff: observations, results and nextSteps are required arrays");
  }
}

export function assertRunLimits(value: RunLimits): void {
  if (value.maxTotalTokens <= 0 || value.maxWallClockMs <= 0 || value.handoffReserveTokens <= 0 || value.handoffReserveWallClockMs <= 0) {
    throw new Error("run limits must be positive");
  }
  if (value.handoffReserveTokens >= value.maxTotalTokens) {
    throw new Error("handoff reserve must be smaller than maxTotalTokens");
  }
  if (value.handoffReserveWallClockMs >= value.maxWallClockMs) {
    throw new Error("handoff wall-clock reserve must be smaller than maxWallClockMs");
  }
}

export function assertActionRequest(value: ActionSnapshot): void {
  if (!value.reason.trim()) throw new Error("action reason is required");
  if (value.evidence.length === 0) throw new Error("action evidence is required");
  if (value.status !== "requested") throw new Error("new action must be requested");
  if (!value.connector.trim()) throw new Error("action connector is required");
  if (value.reconciledAt !== null) throw new Error("requested action cannot be reconciled");
}

export function assertGoalSnapshot(value: GoalSnapshot): void {
  if (!value.objective.trim() || !value.owner.trim()) throw new Error("goal objective and owner are required");
  if (!value.metric.source.trim() || !value.metric.window.trim() || value.metric.freshnessMs <= 0) {
    throw new Error("goal metric source, window and positive freshnessMs are required");
  }
  if (!Number.isFinite(value.metric.target)) throw new Error("goal metric target must be finite");
}

export function capabilityFor(manifest: ConnectorManifest, kind: string): ConnectorCapability | null {
  return manifest.capabilities.find((capability) => capability.kind === kind) ?? null;
}

export function evaluateMetric(metric: MetricContract, samples: MetricSample[], now: string): MetricEvaluation {
  const latest = samples.filter((sample) => sample.source === metric.source).sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
  if (!latest || latest.value === null) {
    return { goalId: latest?.goalId ?? "unknown", status: "missing", shouldWakeOwner: metric.onMissing === "wake_owner", evaluatedAt: now, value: null };
  }
  if (Date.parse(now) - Date.parse(latest.observedAt) > metric.freshnessMs) {
    return { goalId: latest.goalId, status: "stale", shouldWakeOwner: metric.onStale === "wake_owner", evaluatedAt: now, value: latest.value };
  }
  const guardrailBreached = (metric.guardrails ?? []).some((guardrail) => {
    const value = latest.guardrails?.[guardrail.metric];
    return value === undefined || (guardrail.direction === "at_least" ? value < guardrail.target : value > guardrail.target);
  });
  if (guardrailBreached) return { goalId: latest.goalId, status: "guardrail_breached", shouldWakeOwner: true, evaluatedAt: now, value: latest.value };
  const meets = (value: number) => metric.direction === "increase" || metric.direction === "at_least" ? value >= metric.target : value <= metric.target;
  let met = meets(latest.value);
  if (met && metric.sustainForMs) {
    const cutoff = Date.parse(now) - metric.sustainForMs;
    const ordered = samples.filter((sample) => sample.source === metric.source && sample.value !== null && Date.parse(sample.observedAt) <= Date.parse(now)).sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    const baseline = ordered.findLast((sample) => Date.parse(sample.observedAt) <= cutoff);
    const sustained = ordered.filter((sample) => Date.parse(sample.observedAt) >= cutoff);
    met = Boolean(baseline && meets(baseline.value!) && sustained.every((sample) => meets(sample.value!)));
  }
  return { goalId: latest.goalId, status: met ? "met" : "missed", shouldWakeOwner: !met, evaluatedAt: now, value: latest.value };
}
