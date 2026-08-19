import { CONTRACT_VERSION, type EventInput, type EventRecord, type EventStore, type JsonValue } from "./kernel.js";
import type { MetricSample } from "./metrics.js";

export type WakeStatus = "queued" | "leased" | "running" | "done" | "abnormal" | "merge_blocked";
export type ActionStatus = "requested" | "approved" | "dispatching" | "confirmed" | "failed" | "unknown";
export type GoalPhase = "active" | "paused" | "blocked" | "complete";
export interface GoalSnapshot { id: string; parentId: string | null; objective: string; observationMethod: string | null; owner: string; phase: GoalPhase; revision: number }
export interface ScheduleSnapshot { id: string; agent: string; nextWakeAt: string; reason: string; setBy: string }
export interface WakeSnapshot { id: string; agent: string; triggerRef: string; status: WakeStatus; leaseUntil: string | null; attempt: number; startedAt: string | null; endedAt: string | null; enqueuedSeq: number; leaseToken: string | null; runnerPid: number | null }
export type MailLevel = "fyi" | "decision" | "emergency";
export interface MailSnapshot { id: string; to: string; from: string; level: MailLevel; body: JsonValue; readAt: string | null }
export interface DelegationRequest {
  id: string;
  parentGoalId: string;
  childGoal: { id: string; objective: string; observationMethod: string; owner: string };
  brief: JsonValue;
  reason: string;
  evidence: number[];
}
export interface DelegationResult { delegationId: string; goal: GoalSnapshot; mail: MailSnapshot; wake: WakeSnapshot }
export interface ReassignmentRequest {
  id: string;
  goalId: string;
  newOwner: string;
  brief: JsonValue;
  reason: string;
  evidence: number[];
}
export interface ReassignmentResult { reassignmentId: string; goal: GoalSnapshot; mail: MailSnapshot[]; wake: WakeSnapshot }
export interface GoalCompletionRequest { goalId: string; revision: number; reason: string; evidence: number[] }
export type TeamMemberStatus = "running" | "queued" | "scheduled" | "waiting" | "blocked" | "idle_unplanned" | "retired";
export interface TeamMemberView {
  agent: string;
  goalIds: string[];
  status: TeamMemberStatus;
  lastHandoffSeq: number | null;
  lastWakeStatus: WakeStatus | null;
  nextWakeAt: string | null;
}
export interface AuditAdvice { by: string; at: string; body: JsonValue; evidence: number[] }
export interface ActionSnapshot { id: string; agent: string; kind: string; connector: string; payload: JsonValue; reason: string; evidence: number[]; gated: boolean; status: ActionStatus; reconciledAt: string | null; externalRef: string | null; auditAdvice: AuditAdvice | null; adviceAcked: boolean }
export interface Handoff { observations: string[]; results: string[]; nextSteps: string[]; blocker?: string; material?: boolean }
export interface MailDraft { to: string; level: MailLevel; body: JsonValue }
export interface WakeOutput { handoff: Handoff; mail: MailDraft[]; nextWakeAt: string | null }
export interface RunnerTraceEvent { type: string; data: JsonValue }

export type AgentRole = "child" | "ceo" | "verifier" | "audit";
export type AgentCapability = "ledger.search" | "mail.send" | "schedule.set" | "action.submit" | "audit.ack" | "audit.write" | "goal.put"
  | "team.list" | "goal.delegate" | "goal.reassign" | "goal.revise" | "goal.pause" | "goal.resume" | "goal.complete" | "human.request";
export interface AgentProfile { agent: string; role: AgentRole; capabilities?: AgentCapability[]; systemPrompt?: string }
export interface RunRequest { wake: WakeSnapshot; context: JsonValue; now(): string; emit(event: RunnerTraceEvent): void; rpc?(method: AgentCapability, params: JsonValue): Promise<JsonValue> }
export type RunnerResult = { outcome: "handoff"; output: WakeOutput } | { outcome: "abnormal"; reason: string };
export interface RunnerHandle { pid: number | null; begin(): void; result: Promise<RunnerResult>; terminate(): Promise<void> }
export interface Runner { readonly isolation: "process"; prepare(request: RunRequest): RunnerHandle; terminateProcess(pid: number): Promise<void> }

export interface ConnectorCapability { kind: string; nativeIdempotency: boolean; query: "by_idempotency_key" | "by_external_ref" | "none"; automaticRetry: boolean; risk: "reversible" | "gated" | "irreversible" }
export interface ConnectorManifest { contractVersion: typeof CONTRACT_VERSION; connector: string; dryRun: boolean; capabilities: ConnectorCapability[] }
export interface ConnectorDispatchResult { status: "confirmed" | "failed"; externalRef?: string }
export interface ConnectorQueryResult { status: "confirmed" | "failed" | "pending"; externalRef?: string }
export interface ConnectorProcessSpec { manifest: ConnectorManifest; command: string; args: string[]; env?: Record<string, string>; timeoutMs?: number }
export interface HandoffCommit { agent: string; wakeId: string; ts: string; output: WakeOutput; outgoingMail: MailSnapshot[]; schedule: ScheduleSnapshot | null }

/** Standard execution modules composed on top of the generic event store. */
export interface Ledger extends EventStore {
  putGoal(goal: GoalSnapshot, actor: string, wakeId?: string): EventRecord;
  commitDelegation(request: DelegationRequest, actor: string, wakeId?: string): DelegationResult;
  commitReassignment(request: ReassignmentRequest, actor: string, wakeId?: string): ReassignmentResult;
  completeGoal(request: GoalCompletionRequest, actor: string, wakeId?: string): GoalSnapshot;
  putSchedule(schedule: ScheduleSnapshot, actor: string, wakeId?: string): EventRecord;
  enqueueWake(wake: WakeSnapshot, actor: string): { event: EventRecord; created: boolean };
  claimNextWake(now: string, leaseUntil: string, leaseToken: string): WakeSnapshot | null;
  markWakeRunning(id: string, now: string, leaseToken: string): WakeSnapshot;
  attachWakeProcess(id: string, leaseToken: string, pid: number, now: string): WakeSnapshot;
  renewWakeLease(id: string, leaseToken: string, leaseUntil: string, now: string): WakeSnapshot;
  finishWake(id: string, status: "done" | "abnormal" | "merge_blocked", now: string): WakeSnapshot;
  expiredWakes(now: string): WakeSnapshot[];
  recoverExpiredWake(id: string, now: string): WakeSnapshot;
  appendRunnerEvent(input: EventInput, leaseToken: string): EventRecord;
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
  lastEvent(actor: string, type: string): EventRecord | null;
  eventsForWake(wakeId: string): EventRecord[];
  wake(id: string): WakeSnapshot | null;
  wakeByTrigger(agent: string, triggerRef: string): WakeSnapshot | null;
  queuedWakeForAgent(agent: string): WakeSnapshot | null;
  action(id: string): ActionSnapshot | null;
  goalsForOwner(owner: string): GoalSnapshot[];
  goal(id: string): GoalSnapshot | null;
  triggeringMail(): MailSnapshot[];
  searchEvents(query: string, limit?: number): EventRecord[];
  metricSamples(goalId: string): MetricSample[];
  goals(): GoalSnapshot[];
  schedules(): ScheduleSnapshot[];
  wakes(): WakeSnapshot[];
  actions(): ActionSnapshot[];
  mailbox(): MailSnapshot[];
  rebuildProjections(): void;
  close(): void;
}

const wakeTransitions: Record<WakeStatus, readonly WakeStatus[]> = { queued: ["leased", "abnormal"], leased: ["queued", "running", "abnormal"], running: ["done", "abnormal", "merge_blocked"], done: [], abnormal: [], merge_blocked: [] };
const actionTransitions: Record<ActionStatus, readonly ActionStatus[]> = { requested: ["approved", "failed"], approved: ["dispatching", "failed"], dispatching: ["confirmed", "failed", "unknown"], unknown: ["dispatching", "confirmed", "failed"], confirmed: [], failed: [] };
const goalTransitions: Record<GoalPhase, readonly GoalPhase[]> = { active: ["paused", "blocked", "complete"], paused: ["active", "complete"], blocked: ["active", "complete"], complete: [] };
export function assertWakeTransition(from: WakeStatus, to: WakeStatus): void { if (!wakeTransitions[from].includes(to)) throw new Error(`invalid wake transition: ${from} -> ${to}`); }
export function assertActionTransition(from: ActionStatus, to: ActionStatus): void { if (!actionTransitions[from].includes(to)) throw new Error(`invalid action transition: ${from} -> ${to}`); }
export function assertGoalTransition(from: GoalPhase, to: GoalPhase): void { if (from !== to && !goalTransitions[from].includes(to)) throw new Error(`invalid goal transition: ${from} -> ${to}`); }
export function assertHandoff(value: Handoff): void { if (!Array.isArray(value.observations) || !Array.isArray(value.results) || !Array.isArray(value.nextSteps)) throw new Error("invalid handoff: observations, results and nextSteps are required arrays"); }
export function assertActionRequest(value: ActionSnapshot): void { if (!value.reason.trim()) throw new Error("action reason is required"); if (value.evidence.length === 0) throw new Error("action evidence is required"); if (value.status !== "requested") throw new Error("new action must be requested"); if (!value.connector.trim()) throw new Error("action connector is required"); if (value.reconciledAt !== null) throw new Error("requested action cannot be reconciled"); }
export function assertGoalSnapshot(value: GoalSnapshot): void {
  if (!value.objective.trim() || !value.owner.trim()) throw new Error("goal objective and owner are required");
  if (value.observationMethod !== null && !value.observationMethod.trim()) throw new Error("goal observation method cannot be blank");
  if (value.parentId !== null && value.observationMethod === null) throw new Error("child goal observation method is required");
  if (!["active", "paused", "blocked", "complete"].includes(value.phase)) throw new Error(`invalid goal phase: ${value.phase}`);
}
export function capabilityFor(manifest: ConnectorManifest, kind: string): ConnectorCapability | null { return manifest.capabilities.find((capability) => capability.kind === kind) ?? null; }
