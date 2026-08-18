import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  capabilityFor,
  type ActionSnapshot,
  type AuditAdvice,
  type Clock,
  type ConnectorDispatchResult,
  type ConnectorProcessSpec,
  type ConnectorQueryResult,
  type GoalSnapshot,
  type JsonValue,
  type Ledger,
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
  constructor(readonly repository: string, readonly baseBranch = "main", worktrees?: string, readonly maxRetainedWorktrees = 32) {
    this.#worktrees = worktrees ?? join(repository, ".goah", "worktrees");
    mkdirSync(this.#worktrees, { recursive: true });
    git(repository, ["rev-parse", "--is-inside-work-tree"]);
  }

  async prepare(wake: WakeSnapshot): Promise<string> {
    const path = this.#path(wake.id);
    if (existsSync(path)) return path;
    if (readdirSync(this.#worktrees).length >= this.maxRetainedWorktrees) throw new Error("worktree retention quota exceeded");
    git(this.repository, ["worktree", "add", "-b", this.#branch(wake.id), path, this.baseBranch]);
    return path;
  }

  async merge(wake: WakeSnapshot): Promise<WorkspaceResult> {
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
}

const defaultLimits: RunLimits = { maxTokens: 4_000, maxWallClockMs: 60_000, handoffReserveTokens: 500, handoffReserveWallClockMs: 5_000 };

export class Supervisor {
  readonly #leaseMs: number;
  readonly #limits: RunLimits;
  readonly #workspace: WorkspaceManager;
  readonly #allowExternalActions: boolean;
  readonly #approvers: Set<string>;
  readonly #auditWriters: Set<string>;
  readonly #connectors = new Map<string, ConnectorProcessSpec>();

  constructor(readonly ledger: Ledger, readonly runner: Runner, readonly clock: Clock, options: SupervisorOptions = {}) {
    this.#limits = options.limits ?? defaultLimits;
    this.#leaseMs = Math.max(options.leaseMs ?? 30_000, this.#limits.maxWallClockMs + 60_000);
    this.#workspace = options.workspace ?? new NoopWorkspaceManager();
    this.#allowExternalActions = options.allowExternalActions ?? false;
    this.#approvers = new Set(options.approvers ?? ["human", "ceo"]);
    this.#auditWriters = new Set(options.auditWriters ?? ["verifier", "audit"]);
  }

  registerConnector(connector: ConnectorProcessSpec): void { this.#connectors.set(connector.manifest.connector, connector); }
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

  async submitAction(action: Omit<ActionSnapshot, "connector" | "gated" | "status" | "reconciledAt" | "externalRef">, connectorName: string): Promise<ActionSnapshot> {
    const connector = this.#connectors.get(connectorName);
    const capability = connector ? capabilityFor(connector.manifest, action.kind) : null;
    const gated = !connector || !capability || capability.risk !== "reversible"
      || (!connector.manifest.dryRun && !this.#allowExternalActions)
      || (capability ? !payloadWithinConstraints(action.payload, capability.constraints) : true);
    const requested: ActionSnapshot = { ...action, connector: connectorName, gated, status: "requested", reconciledAt: null, externalRef: null };
    this.ledger.requestAction(requested, action.agent);
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
    if (!this.#auditWriters.has(advice.by)) throw new Error("actor is not authorized to write audit advice");
    return this.ledger.putAuditAdvice(id, advice, wakeId);
  }

  ackAuditAdvice(id: string, agent: string): ActionSnapshot { return this.ledger.ackAuditAdvice(id, agent); }

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
    if (["leased", "running", "queued"].includes(current.status)) this.ledger.finishWake(current.id, "abnormal", this.#now());
  }

  #enqueueSchedule(schedule: ScheduleSnapshot): WakeSnapshot {
    const wake: WakeSnapshot = { id: randomUUID(), agent: schedule.agent, triggerRef: `${schedule.id}@${schedule.nextWakeAt}`, status: "queued", leaseUntil: null, attempt: 0, startedAt: null, endedAt: null, enqueuedSeq: 0, leaseToken: null, runnerPid: null };
    const result = this.ledger.enqueueWake(wake, "supervisor");
    if (result.created) return this.#wake(wake.id);
    const existing = this.ledger.wakeByTrigger(wake.agent, wake.triggerRef);
    if (!existing) throw new Error("deduplicated wake is missing");
    return existing;
  }

  #loadContext(wake: WakeSnapshot): JsonValue {
    const goals = this.ledger.goalsForOwner(wake.agent);
    const mail = this.ledger.unreadMail(wake.agent);
    const auditAdvice = this.ledger.unackedAuditAdvice(wake.agent).map((action) => ({ actionId: action.id, advice: action.auditAdvice }));
    const handoff = this.ledger.lastEvent(wake.agent, "handoff.recorded");
    const recoveryId = wake.triggerRef.startsWith("recovery:") ? wake.triggerRef.slice("recovery:".length) : null;
    const recoveryEvents = recoveryId ? this.ledger.eventsForWake(recoveryId) : [];
    return { goals, mail, auditAdvice, lastHandoff: handoff?.data ?? null, recoveryEvents } as unknown as JsonValue;
  }

  #workspaceEvent(kind: string, wake: WakeSnapshot, data: object): void { this.ledger.appendEvent({ ts: this.#now(), agent: "supervisor", kind, data: data as JsonValue, wakeId: wake.id }); }
  #requiredConnector(name: string): ConnectorProcessSpec { const value = this.#connectors.get(name); if (!value) throw new Error(`connector not registered: ${name}`); return value; }
  #wake(id: string): WakeSnapshot { const value = this.ledger.wake(id); if (!value) throw new Error(`wake not found: ${id}`); return value; }
  #action(id: string): ActionSnapshot { const value = this.ledger.action(id); if (!value) throw new Error(`action not found: ${id}`); return value; }
  #now(): string { return this.clock.now().toISOString(); }
}

async function runConnector<T>(spec: ConnectorProcessSpec, operation: "dispatch" | "query", action: ActionSnapshot): Promise<T> {
  const child = spawn(spec.command, spec.args, { detached: process.platform !== "win32", env: minimalEnvironment(spec.env), stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdin.end(`${JSON.stringify({ operation, action })}\n`);
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
