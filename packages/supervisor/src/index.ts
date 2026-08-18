import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  capabilityFor,
  evaluateMetric,
  type ActionSnapshot,
  type AgentCapability,
  type AgentProfile,
  type AgentRole,
  type AuditAdvice,
  type Clock,
  type ConnectorDispatchResult,
  type ConnectorProcessSpec,
  type ConnectorQueryResult,
  type GoalSnapshot,
  type JsonValue,
  type Ledger,
  type MetricEvaluation,
  type MetricProcessSpec,
  type MetricSample,
  type RunLimits,
  type Runner,
  type RunnerHandle,
  type ScheduleSnapshot,
  type WakeSnapshot,
} from "@goah/ledger-contract";

export interface WorkspaceResult { status: "merged" | "merge_blocked"; commitSha: string; ref?: string }
export interface SalvageResult { commitSha: string; ref: string }
export interface WorkspaceManager {
  prepare(wake: WakeSnapshot): Promise<string | undefined>;
  merge(wake: WakeSnapshot): Promise<WorkspaceResult | undefined>;
  salvage(wake: WakeSnapshot): Promise<SalvageResult | undefined>;
}
export class NoopWorkspaceManager implements WorkspaceManager {
  async prepare(): Promise<undefined> { return undefined; }
  async merge(): Promise<undefined> { return undefined; }
  async salvage(): Promise<undefined> { return undefined; }
}

export class GitWorkspaceManager implements WorkspaceManager {
  readonly #worktrees: string;
  #mergeTail: Promise<void> = Promise.resolve();
  constructor(readonly repository: string, readonly baseBranch = "main", worktrees?: string, readonly maxRetainedWorktrees = 32) {
    this.#worktrees = worktrees ?? join(repository, ".goah", "worktrees");
    mkdirSync(this.#worktrees, { recursive: true });
    git(repository, ["rev-parse", "--is-inside-work-tree"]);
    const excludeValue = git(repository, ["rev-parse", "--git-path", "info/exclude"]);
    const exclude = isAbsolute(excludeValue) ? excludeValue : join(repository, excludeValue);
    if (!readFileSync(exclude, "utf8").split("\n").includes(".goah/")) appendFileSync(exclude, "\n.goah/\n");
  }

  async prepare(wake: WakeSnapshot): Promise<string> {
    const path = this.#path(wake.id);
    if (existsSync(path)) return path;
    if (readdirSync(this.#worktrees).length >= this.maxRetainedWorktrees) throw new Error("worktree retention quota exceeded");
    git(this.repository, ["worktree", "add", "-b", this.#branch(wake.id), path, this.baseBranch]);
    return path;
  }

  async merge(wake: WakeSnapshot): Promise<WorkspaceResult> {
    const previous = this.#mergeTail;
    let release!: () => void;
    this.#mergeTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return this.#merge(wake); }
    finally { release(); }
  }

  #merge(wake: WakeSnapshot): WorkspaceResult {
    const path = this.#path(wake.id);
    const branch = this.#branch(wake.id);
    git(path, ["add", "-A"]);
    git(path, ["commit", "--allow-empty", "-m", `wake:${wake.id}`]);
    const rebase = gitResult(path, ["rebase", this.baseBranch]);
    if (rebase.status !== 0) {
      gitResult(path, ["rebase", "--abort"]);
      const commitSha = git(path, ["rev-parse", "HEAD"]);
      const ref = `refs/goah/merge-blocked/${safe(wake.id)}`;
      git(this.repository, ["update-ref", ref, commitSha]);
      this.#remove(path, branch);
      return { status: "merge_blocked", commitSha, ref };
    }
    const commitSha = git(path, ["rev-parse", "HEAD"]);
    if (gitResult(this.repository, ["merge", "--ff-only", branch]).status !== 0) {
      const ref = `refs/goah/merge-blocked/${safe(wake.id)}`;
      git(this.repository, ["update-ref", ref, commitSha]);
      this.#remove(path, branch);
      return { status: "merge_blocked", commitSha, ref };
    }
    this.#remove(path, branch);
    return { status: "merged", commitSha };
  }

  async salvage(wake: WakeSnapshot): Promise<SalvageResult | undefined> {
    const path = this.#path(wake.id);
    if (!existsSync(path)) return undefined;
    gitResult(path, ["rebase", "--abort"]);
    git(path, ["add", "-A"]);
    git(path, ["commit", "--allow-empty", "-m", `salvage:${wake.id}`]);
    const commitSha = git(path, ["rev-parse", "HEAD"]);
    const ref = `refs/goah/salvage/${safe(wake.id)}`;
    git(this.repository, ["update-ref", ref, commitSha]);
    this.#remove(path, this.#branch(wake.id));
    return { commitSha, ref };
  }

  #remove(path: string, branch: string): void {
    git(this.repository, ["worktree", "remove", "--force", path]);
    gitResult(this.repository, ["branch", "-D", branch]);
  }
  #path(wakeId: string): string { return join(this.#worktrees, safe(wakeId)); }
  #branch(wakeId: string): string { return `goah/wake-${safe(wakeId)}`; }
}

export interface SupervisorOptions {
  leaseMs?: number;
  limits?: RunLimits;
  workspace?: WorkspaceManager;
  allowExternalActions?: boolean;
  approvers?: string[];
  auditWriters?: string[];
  heartbeatPolicies?: Array<{ agent: string; maxSilentMs: number; escalateTo: string; since?: string }>;
  retryPolicy?: { maxAttempts: number; baseDelayMs: number };
  profiles?: AgentProfile[];
}

interface MetricCollectorRegistration { goalId: string; spec: MetricProcessSpec; intervalMs: number; nextAt: number }

const defaultLimits: RunLimits = { maxTokens: 4_000, maxWallClockMs: 60_000, handoffReserveTokens: 500, handoffReserveWallClockMs: 5_000 };

export class Supervisor {
  readonly #leaseMs: number;
  readonly #limits: RunLimits;
  readonly #workspace: WorkspaceManager;
  readonly #allowExternalActions: boolean;
  readonly #approvers: Set<string>;
  readonly #auditWriters: Set<string>;
  readonly #connectors = new Map<string, ConnectorProcessSpec>();
  readonly #metricCollectors = new Map<string, MetricCollectorRegistration>();
  readonly #heartbeatPolicies: NonNullable<SupervisorOptions["heartbeatPolicies"]>;
  readonly #retryPolicy: NonNullable<SupervisorOptions["retryPolicy"]>;
  readonly #profiles: Map<string, AgentProfile>;

  constructor(readonly ledger: Ledger, readonly runner: Runner, readonly clock: Clock, options: SupervisorOptions = {}) {
    this.#limits = options.limits ?? defaultLimits;
    this.#leaseMs = Math.max(options.leaseMs ?? 30_000, this.#limits.maxWallClockMs + 60_000);
    this.#workspace = options.workspace ?? new NoopWorkspaceManager();
    this.#allowExternalActions = options.allowExternalActions ?? false;
    this.#approvers = new Set(options.approvers ?? ["human", "ceo"]);
    this.#auditWriters = new Set(options.auditWriters ?? ["verifier", "audit"]);
    this.#heartbeatPolicies = options.heartbeatPolicies ?? [];
    this.#retryPolicy = options.retryPolicy ?? { maxAttempts: 0, baseDelayMs: 1_000 };
    this.#profiles = new Map((options.profiles ?? []).map((profile) => [profile.agent, profile]));
  }

  registerConnector(connector: ConnectorProcessSpec): void { this.#connectors.set(connector.manifest.connector, connector); }
  registerMetricCollector(goalId: string, spec: MetricProcessSpec, intervalMs = 60_000): void {
    this.#metricCollectors.set(goalId, { goalId, spec, intervalMs, nextAt: 0 });
  }
  createGoal(goal: GoalSnapshot, actor = "human"): void { this.ledger.putGoal(goal, actor); }

  planWake(agent: string, at: string, reason: string, setBy = agent): WakeSnapshot | null {
    const schedule: ScheduleSnapshot = { id: `schedule:${agent}`, agent, nextWakeAt: at, reason, setBy };
    this.ledger.putSchedule(schedule, setBy);
    return at <= this.#now() ? this.#enqueueSchedule(schedule) : null;
  }

  async recover(): Promise<void> {
    this.ledger.recoverDispatchingActions();
    for (const expired of this.ledger.expiredWakes(this.#now())) {
      if (expired.status === "running" && expired.runnerPid) await this.runner.terminateProcess(expired.runnerPid);
      const wake = this.ledger.recoverExpiredWake(expired.id, this.#now());
      if (wake.status === "abnormal") {
        const salvage = await this.#workspace.salvage(wake);
        if (salvage) this.#workspaceEvent("workspace.salvaged", wake, salvage);
      }
    }
  }

  async tick(): Promise<WakeSnapshot | null> {
    for (const schedule of this.ledger.dueSchedules(this.#now())) this.#enqueueSchedule(schedule);
    await this.#collectMetrics();
    this.#scheduleMetricAndHeartbeatAlerts();
    for (const mail of this.ledger.triggeringMail()) this.#enqueueTrigger(mail.to, `mail:${mail.id}`);
    const now = this.clock.now();
    const leaseToken = randomUUID();
    const wake = this.ledger.claimNextWake(now.toISOString(), new Date(now.getTime() + this.#leaseMs).toISOString(), leaseToken);
    if (!wake) return null;
    let running = wake;
    let handle: RunnerHandle | null = null;
    try {
      const workspacePath = await this.#workspace.prepare(wake);
      running = this.ledger.markWakeRunning(wake.id, this.#now(), leaseToken);
      const context = this.#loadContext(running);
      handle = this.runner.prepare({
        wake: running,
        context,
        ...(workspacePath ? { workspacePath } : {}),
        limits: this.#limits,
        now: () => this.#now(),
        emit: (trace) => this.ledger.appendRunnerEvent({ ts: this.#now(), agent: running.agent, kind: `runner.${trace.kind}`, data: trace.data, wakeId: running.id }, leaseToken),
        rpc: (method, params) => this.#agentRpc(running, leaseToken, method, params),
      });
      if (handle.pid) running = this.ledger.attachWakeProcess(running.id, leaseToken, handle.pid, this.#now());
      handle.begin();
      const result = await handle.result;
      await handle.terminate();
      if (result.outcome === "abnormal") {
        await this.#markAbnormal(running, result.reason);
        return this.#wake(running.id);
      }

      const outgoingMail = result.output.mail.map((draft) => ({ id: randomUUID(), to: draft.to, from: running.agent, level: draft.level, body: draft.body, readAt: null }));
      const schedule = result.output.nextWakeAt
        ? { id: `schedule:${running.agent}`, agent: running.agent, nextWakeAt: result.output.nextWakeAt, reason: "handoff.next_steps", setBy: running.agent }
        : null;
      this.ledger.commitHandoff({ agent: running.agent, wakeId: running.id, ts: this.#now(), output: result.output, outgoingMail, schedule });

      const workspace = await this.#workspace.merge(running);
      if (workspace?.status === "merge_blocked") {
        this.#workspaceEvent("workspace.merge_blocked", running, workspace);
        this.ledger.finishWake(running.id, "merge_blocked", this.#now());
      } else {
        if (workspace) this.#workspaceEvent("workspace.merged", running, workspace);
        this.ledger.finishWake(running.id, "done", this.#now());
      }
      return this.#wake(running.id);
    } catch (error) {
      if (handle) await handle.terminate();
      await this.#markAbnormal(running, error instanceof Error ? error.message : String(error));
      return this.#wake(running.id);
    }
  }

  async runAvailable(concurrency = 4): Promise<WakeSnapshot[]> {
    const completed: WakeSnapshot[] = [];
    while (true) {
      const batch = await Promise.all(Array.from({ length: concurrency }, () => this.tick()));
      const wakes = batch.filter((wake): wake is WakeSnapshot => wake !== null);
      completed.push(...wakes);
      if (wakes.length === 0) return completed;
    }
  }

  async submitAction(action: Omit<ActionSnapshot, "connector" | "gated" | "status" | "reconciledAt" | "externalRef">, connectorName: string, wakeId?: string): Promise<ActionSnapshot> {
    const connector = this.#connectors.get(connectorName);
    const capability = connector ? capabilityFor(connector.manifest, action.kind) : null;
    const gated = !connector || !capability || capability.risk !== "reversible"
      || (!connector.manifest.dryRun && !this.#allowExternalActions)
      || (capability ? !payloadWithinConstraints(action.payload, capability.constraints) : true);
    const requested: ActionSnapshot = { ...action, connector: connectorName, gated, status: "requested", reconciledAt: null, externalRef: null };
    this.ledger.requestAction(requested, action.agent, wakeId);
    if (gated || !connector) return this.#action(action.id);
    this.ledger.approveAction(action.id, "supervisor", "declared reversible dry-run capability", action.evidence);
    return this.#dispatch(action.id);
  }

  async approveAction(id: string, approver: string, reason: string, evidence: number[]): Promise<ActionSnapshot> {
    if (!this.#approvers.has(approver)) throw new Error("actor is not authorized to approve actions");
    this.ledger.approveAction(id, approver, reason, evidence);
    return this.#dispatch(id);
  }

  rejectAction(id: string, approver: string, reason: string, evidence: number[]): ActionSnapshot {
    if (!this.#approvers.has(approver)) throw new Error("actor is not authorized to reject actions");
    return this.ledger.rejectAction(id, approver, reason, evidence);
  }

  putAuditAdvice(id: string, advice: Omit<AuditAdvice, "at">, wakeId?: string): ActionSnapshot {
    const role = this.#profiles.get(advice.by)?.role;
    if (!this.#auditWriters.has(advice.by) && role !== "verifier" && role !== "audit") throw new Error("actor is not authorized to write audit advice");
    return this.ledger.putAuditAdvice(id, advice, wakeId);
  }

  ackAuditAdvice(id: string, agent: string): ActionSnapshot { return this.ledger.ackAuditAdvice(id, agent); }

  recordMetric(sample: MetricSample): MetricEvaluation {
    const goal = this.ledger.goal(sample.goalId);
    if (!goal) throw new Error(`metric goal not found: ${sample.goalId}`);
    if (goal.metric.source !== sample.source) throw new Error("metric source does not match goal contract");
    this.ledger.appendEvent({ ts: this.#now(), agent: "supervisor", kind: "metric.sampled", data: sample as unknown as JsonValue, wakeId: null });
    const evaluation = evaluateMetric(goal.metric, this.ledger.metricSamples(goal.id), this.#now());
    this.ledger.appendEvent({ ts: this.#now(), agent: "supervisor", kind: "metric.evaluated", data: evaluation as unknown as JsonValue, wakeId: null });
    if (evaluation.shouldWakeOwner) this.#enqueueTrigger(goal.owner, `metric:${goal.id}:${sample.observedAt}`);
    return evaluation;
  }

  async reconcileAction(id: string): Promise<ActionSnapshot> {
    const action = this.#action(id);
    if (action.status !== "unknown") throw new Error("only unknown actions may be reconciled");
    const connector = this.#requiredConnector(action.connector);
    const capability = capabilityFor(connector.manifest, action.kind);
    if (!capability || capability.query === "none") throw new Error("connector cannot reconcile this action");
    const result = await runConnector<ConnectorQueryResult>(connector, "query", action);
    if (result.status === "pending") return action;
    return this.ledger.transitionAction(id, result.status, { reconciledAt: this.#now(), ...(result.externalRef ? { externalRef: result.externalRef } : {}) });
  }

  async retryUnknownAction(id: string): Promise<ActionSnapshot> {
    const action = this.#action(id);
    if (action.status !== "unknown") throw new Error("only unknown actions may be retried");
    const connector = this.#requiredConnector(action.connector);
    const capability = capabilityFor(connector.manifest, action.kind);
    if (!capability?.nativeIdempotency || !capability.automaticRetry) throw new Error("connector manifest forbids automatic retry");
    return this.#dispatch(id);
  }

  async #dispatch(id: string): Promise<ActionSnapshot> {
    const current = this.#action(id);
    const connector = this.#requiredConnector(current.connector);
    const dispatching = this.ledger.transitionAction(id, "dispatching");
    const result = await runConnector<ConnectorDispatchResult>(connector, "dispatch", dispatching);
    return this.ledger.transitionAction(id, result.status, result.externalRef ? { externalRef: result.externalRef } : {});
  }

  async #markAbnormal(wake: WakeSnapshot, reason: string): Promise<void> {
    const current = this.#wake(wake.id);
    if (current.runnerPid) await this.runner.terminateProcess(current.runnerPid);
    const salvage = await this.#workspace.salvage(current);
    if (salvage) this.#workspaceEvent("workspace.salvaged", current, salvage);
    this.ledger.appendEvent({ ts: this.#now(), agent: current.agent, kind: "wake.abnormal_reason", data: { reason }, wakeId: current.id });
    if (["leased", "running", "queued"].includes(current.status)) {
      this.ledger.finishWake(current.id, "abnormal", this.#now());
      if (current.attempt < this.#retryPolicy.maxAttempts) {
        const delay = this.#retryPolicy.baseDelayMs * 2 ** Math.max(0, current.attempt - 1);
        const schedule: ScheduleSnapshot = { id: `retry:${current.id}`, agent: current.agent, nextWakeAt: new Date(this.clock.now().getTime() + delay).toISOString(), reason: `recovery:${current.id}`, setBy: "supervisor" };
        this.ledger.putSchedule(schedule, "supervisor", current.id);
      }
    }
  }

  #enqueueSchedule(schedule: ScheduleSnapshot): WakeSnapshot {
    return this.#enqueueTrigger(schedule.agent, `${schedule.id}@${schedule.nextWakeAt}`);
  }

  #enqueueTrigger(agent: string, triggerRef: string): WakeSnapshot {
    const exact = this.ledger.wakeByTrigger(agent, triggerRef);
    if (exact) return exact;
    const queued = this.ledger.queuedWakeForAgent(agent);
    if (queued) {
      this.ledger.appendEvent({ ts: this.#now(), agent: "supervisor", kind: "wake.trigger_coalesced", data: { wakeId: queued.id, triggerRef }, wakeId: queued.id });
      return queued;
    }
    const wake: WakeSnapshot = { id: randomUUID(), agent, triggerRef, status: "queued", leaseUntil: null, attempt: 0, startedAt: null, endedAt: null, enqueuedSeq: 0, leaseToken: null, runnerPid: null };
    const result = this.ledger.enqueueWake(wake, "supervisor");
    if (result.created) return this.#wake(wake.id);
    const existing = this.ledger.wakeByTrigger(agent, triggerRef);
    if (!existing) throw new Error("deduplicated wake is missing");
    return existing;
  }

  #loadContext(wake: WakeSnapshot): JsonValue {
    const role = this.#profiles.get(wake.agent)?.role ?? "child";
    const goals = role === "ceo" ? this.ledger.goals() : this.ledger.goalsForOwner(wake.agent);
    const mail = this.ledger.unreadMail(wake.agent);
    const auditAdvice = this.ledger.unackedAuditAdvice(wake.agent).map((action) => ({ actionId: action.id, advice: action.auditAdvice }));
    const handoff = this.ledger.lastEvent(wake.agent, "handoff.recorded");
    const recoveryId = wake.triggerRef.startsWith("recovery:")
      ? wake.triggerRef.slice("recovery:".length)
      : wake.triggerRef.startsWith("retry:") ? wake.triggerRef.slice("retry:".length).split("@")[0] : null;
    const recoveryEvents = recoveryId ? this.ledger.eventsForWake(recoveryId) : [];
    const teamHandoffs = role === "ceo"
      ? [...this.ledger.eventsSince(0, ["handoff.recorded"])].reverse().filter((event, index, all) => all.findIndex((candidate) => candidate.agent === event.agent) === index).map((event) => ({ agent: event.agent, handoff: event.data }))
      : [];
    return { role, goals, mail, auditAdvice, lastHandoff: handoff?.data ?? null, teamHandoffs, recoveryEvents } as unknown as JsonValue;
  }

  #workspaceEvent(kind: string, wake: WakeSnapshot, data: object): void { this.ledger.appendEvent({ ts: this.#now(), agent: "supervisor", kind, data: data as JsonValue, wakeId: wake.id }); }
  #requiredConnector(name: string): ConnectorProcessSpec { const value = this.#connectors.get(name); if (!value) throw new Error(`connector not registered: ${name}`); return value; }
  #wake(id: string): WakeSnapshot { const value = this.ledger.wake(id); if (!value) throw new Error(`wake not found: ${id}`); return value; }
  #action(id: string): ActionSnapshot { const value = this.ledger.action(id); if (!value) throw new Error(`action not found: ${id}`); return value; }
  #now(): string { return this.clock.now().toISOString(); }

  async #agentRpc(wake: WakeSnapshot, leaseToken: string, method: AgentCapability, params: JsonValue): Promise<JsonValue> {
    const current = this.ledger.wake(wake.id);
    if (!current || current.status !== "running" || current.leaseToken !== leaseToken || !current.leaseUntil || current.leaseUntil < this.#now()) throw new Error("stale runner RPC rejected");
    const profile = this.#profiles.get(wake.agent) ?? { agent: wake.agent, role: "child" as const };
    const allowed = new Set(profile.capabilities ?? defaultCapabilities(profile.role));
    if (!allowed.has(method)) throw new Error(`${profile.role} agent is not allowed to call ${method}`);
    this.ledger.appendRunnerEvent({ ts: this.#now(), agent: wake.agent, kind: `rpc.${method}`, data: params, wakeId: wake.id }, leaseToken);
    const input = asRecord(params);
    if (method === "ledger.search") return this.ledger.searchEvents(String(input.query), Number(input.limit ?? 20)) as unknown as JsonValue;
    if (method === "budget.read") return (this.ledger.budgetExposure(wake.agent, this.#now()) ?? null) as unknown as JsonValue;
    if (method === "mail.send") {
      const mail = { id: randomUUID(), to: String(input.to), from: wake.agent, level: String(input.level) as "fyi" | "decision" | "emergency", body: (input.body ?? null) as JsonValue, readAt: null };
      this.ledger.putMail(mail, wake.agent, wake.id); return mail as unknown as JsonValue;
    }
    if (method === "schedule.set") return (this.planWake(wake.agent, String(input.at), String(input.reason), wake.agent) ?? { scheduled: true }) as unknown as JsonValue;
    if (method === "audit.ack") return this.ackAuditAdvice(String(input.actionId), wake.agent) as unknown as JsonValue;
    if (method === "audit.write") return this.putAuditAdvice(String(input.actionId), { by: wake.agent, body: (input.body ?? null) as JsonValue, evidence: numberArray(input.evidence) }, wake.id) as unknown as JsonValue;
    if (method === "goal.put") { this.ledger.putGoal(input.goal as unknown as GoalSnapshot, wake.agent, wake.id); return input.goal as JsonValue; }
    const action = await this.submitAction({
      id: String(input.id), agent: wake.agent, kind: String(input.kind), payload: (input.payload ?? null) as JsonValue, reason: String(input.reason), evidence: numberArray(input.evidence), auditAdvice: null, adviceAcked: false,
    }, String(input.connector), wake.id);
    return action as unknown as JsonValue;
  }

  async #collectMetrics(): Promise<void> {
    const now = this.clock.now().getTime();
    for (const registration of this.#metricCollectors.values()) {
      if (registration.nextAt > now) continue;
      registration.nextAt = now + registration.intervalMs;
      const sample = await runJsonProcess<MetricSample>(registration.spec, { goalId: registration.goalId });
      this.recordMetric({ ...sample, goalId: registration.goalId });
    }
  }

  #scheduleMetricAndHeartbeatAlerts(): void {
    for (const goal of this.ledger.goals()) {
      const samples = this.ledger.metricSamples(goal.id);
      const evaluation = evaluateMetric(goal.metric, samples, this.#now());
      if (evaluation.shouldWakeOwner) this.#enqueueTrigger(goal.owner, `metric:${goal.id}:${evaluation.status}:${samples.at(-1)?.observedAt ?? "none"}`);
    }
    for (const policy of this.#heartbeatPolicies) {
      const last = this.ledger.lastEvent(policy.agent, "handoff.recorded");
      const baseline = last?.ts ?? policy.since ?? this.#now();
      if (this.clock.now().getTime() - Date.parse(baseline) <= policy.maxSilentMs) continue;
      const trigger = `heartbeat:${policy.agent}:${last?.seq ?? 0}`;
      if (this.ledger.wakeByTrigger(policy.escalateTo, trigger)) continue;
      this.ledger.appendEvent({ ts: this.#now(), agent: "supervisor", kind: "watchdog.heartbeat_violation", data: { agent: policy.agent, lastHandoffAt: last?.ts ?? null, escalateTo: policy.escalateTo }, wakeId: null });
      this.#enqueueTrigger(policy.escalateTo, trigger);
    }
  }
}

export async function runSupervisorDaemon(supervisor: Supervisor, options: { pollMs?: number; concurrency?: number; signal?: AbortSignal; onError?: (error: unknown) => void } = {}): Promise<void> {
  const pollMs = options.pollMs ?? 1_000;
  await supervisor.recover();
  while (!options.signal?.aborted) {
    try { await supervisor.runAvailable(options.concurrency ?? 4); }
    catch (error) { options.onError?.(error); }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollMs);
      options.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}

export function renderDashboard(ledger: Ledger): string {
  const rows = (values: unknown[]) => values.map((value) => `<tr><td><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>goah status</title><style>body{font:14px ui-monospace;margin:32px;background:#101418;color:#dce3e4}section{margin:32px 0}pre{white-space:pre-wrap;border:1px solid #334;padding:12px}</style></head><body><h1>goah</h1><p>seq ${ledger.events().at(-1)?.seq ?? 0}</p><section><h2>Goals</h2><table>${rows(ledger.goals())}</table></section><section><h2>Wakes</h2><table>${rows(ledger.wakes())}</table></section><section><h2>Actions</h2><table>${rows(ledger.actions())}</table></section><section><h2>Mailbox</h2><table>${rows(ledger.mailbox())}</table></section></body></html>`;
}

async function runConnector<T>(spec: ConnectorProcessSpec, operation: "dispatch" | "query", action: ActionSnapshot): Promise<T> {
  return runJsonProcess<T>(spec, { operation, action });
}

async function runJsonProcess<T>(spec: MetricProcessSpec | ConnectorProcessSpec, input: unknown): Promise<T> {
  const child = spawn(spec.command, spec.args, { detached: process.platform !== "win32", env: minimalEnvironment(spec.env), stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdin.end(`${JSON.stringify(input)}\n`);
  const timeoutMs = spec.timeoutMs ?? 30_000;
  let timer: NodeJS.Timeout | undefined;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  timer = setTimeout(() => { void terminateChild(child, 500); }, timeoutMs);
  const result = await exit;
  clearTimeout(timer);
  if (result.code !== 0) throw new Error(stderr.trim() || `connector exited (${result.code ?? result.signal})`);
  return JSON.parse(stdout.trim()) as T;
}

async function terminateChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  signalPid(child.pid, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  if (child.exitCode === null && child.signalCode === null) signalPid(child.pid, "SIGKILL");
}
function signalPid(pid: number, signal: NodeJS.Signals): void { try { process.kill(process.platform === "win32" ? pid : -pid, signal); } catch {} }
function safe(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, "-"); }
function git(cwd: string, args: string[]): string { const result = gitResult(cwd, args); if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`); return result.stdout.trim(); }
function gitResult(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } { const result = spawnSync("git", args, { cwd, encoding: "utf8" }); return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }; }
function payloadWithinConstraints(payload: JsonValue, constraints: { allowedAccounts?: string[]; allowedEnvironments?: string[]; maxAmount?: number }): boolean {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return Object.keys(constraints).length === 0;
  if (constraints.allowedAccounts && (typeof payload.account !== "string" || !constraints.allowedAccounts.includes(payload.account))) return false;
  if (constraints.allowedEnvironments && (typeof payload.environment !== "string" || !constraints.allowedEnvironments.includes(payload.environment))) return false;
  if (constraints.maxAmount !== undefined && (typeof payload.amount !== "number" || payload.amount > constraints.maxAmount)) return false;
  return true;
}
function minimalEnvironment(explicit: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT"]) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, ...explicit };
}
function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function asRecord(value: JsonValue): Record<string, JsonValue> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("RPC params must be an object"); return value; }
function numberArray(value: JsonValue | undefined): number[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "number")) throw new Error("RPC evidence must be a number array"); return value as number[]; }
function defaultCapabilities(role: AgentRole): AgentCapability[] {
  if (role === "ceo") return ["ledger.search", "budget.read", "mail.send", "schedule.set", "action.submit", "audit.ack", "goal.put"];
  if (role === "verifier") return ["ledger.search", "mail.send", "audit.write"];
  if (role === "audit") return ["ledger.search", "mail.send", "audit.write"];
  return ["ledger.search", "budget.read", "mail.send", "schedule.set", "action.submit", "audit.ack"];
}

export * from "./verification.js";
