import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  capabilityFor,
  type ActionSnapshot,
  type Clock,
  type Connector,
  type GoalSnapshot,
  type JsonValue,
  type Ledger,
  type RunLimits,
  type Runner,
  type ScheduleSnapshot,
  type WakeSnapshot,
} from "@goah/ledger-contract";

export interface WorkspaceResult {
  status: "merged" | "merge_blocked";
  commitSha: string;
}

export interface SalvageResult {
  commitSha: string;
  ref: string;
}

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

  constructor(readonly repository: string, readonly baseBranch = "main", worktrees?: string) {
    this.#worktrees = worktrees ?? join(repository, ".goah", "worktrees");
    mkdirSync(this.#worktrees, { recursive: true });
    git(repository, ["rev-parse", "--is-inside-work-tree"]);
  }

  async prepare(wake: WakeSnapshot): Promise<string> {
    const path = this.#path(wake.id);
    if (existsSync(path)) return path;
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
      return { status: "merge_blocked", commitSha: git(path, ["rev-parse", "HEAD"]) };
    }
    const commitSha = git(path, ["rev-parse", "HEAD"]);
    const merge = gitResult(this.repository, ["merge", "--ff-only", branch]);
    if (merge.status !== 0) return { status: "merge_blocked", commitSha };
    git(this.repository, ["worktree", "remove", path]);
    git(this.repository, ["branch", "-d", branch]);
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
    return { commitSha, ref };
  }

  #path(wakeId: string): string { return join(this.#worktrees, safe(wakeId)); }
  #branch(wakeId: string): string { return `goah/wake-${safe(wakeId)}`; }
}

export interface SupervisorOptions {
  leaseMs?: number;
  limits?: RunLimits;
  workspace?: WorkspaceManager;
  allowExternalActions?: boolean;
}

const defaultLimits: RunLimits = {
  maxTokens: 4_000,
  maxWallClockMs: 60_000,
  handoffReserveTokens: 500,
  handoffReserveWallClockMs: 5_000,
};

export class Supervisor {
  readonly #leaseMs: number;
  readonly #limits: RunLimits;
  readonly #workspace: WorkspaceManager;
  readonly #allowExternalActions: boolean;
  readonly #connectors = new Map<string, Connector>();

  constructor(
    readonly ledger: Ledger,
    readonly runner: Runner,
    readonly clock: Clock,
    options: SupervisorOptions = {},
  ) {
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#limits = options.limits ?? defaultLimits;
    this.#workspace = options.workspace ?? new NoopWorkspaceManager();
    this.#allowExternalActions = options.allowExternalActions ?? false;
  }

  registerConnector(connector: Connector): void {
    this.#connectors.set(connector.manifest.connector, connector);
  }

  createGoal(goal: GoalSnapshot, actor = "human"): void {
    this.ledger.putGoal(goal, actor);
  }

  planWake(agent: string, at: string, reason: string, setBy = agent): WakeSnapshot | null {
    const schedule: ScheduleSnapshot = { id: `schedule:${agent}`, agent, nextWakeAt: at, reason, setBy };
    this.ledger.putSchedule(schedule, setBy);
    return at <= this.#now() ? this.#enqueueSchedule(schedule) : null;
  }

  async recover(): Promise<void> {
    this.ledger.recoverDispatchingActions();
    const recovered = this.ledger.recoverExpiredWakes(this.#now());
    for (const wake of recovered.abnormal) {
      const salvage = await this.#workspace.salvage(wake);
      if (salvage) this.#workspaceEvent("workspace.salvaged", wake, salvage);
    }
  }

  async tick(): Promise<WakeSnapshot | null> {
    for (const schedule of this.ledger.schedules()) {
      if (schedule.nextWakeAt <= this.#now()) this.#enqueueSchedule(schedule);
    }
    const now = this.clock.now();
    const leaseUntil = new Date(now.getTime() + this.#leaseMs).toISOString();
    const wake = this.ledger.claimNextWake(now.toISOString(), leaseUntil);
    if (!wake) return null;

    let running = wake;
    try {
      const workspacePath = await this.#workspace.prepare(wake);
      running = this.ledger.markWakeRunning(wake.id, this.#now());
      const context = this.#loadContext(running);
      this.ledger.markMailReadForAgent(running.agent, this.#now(), running.id);
      const result = await this.runner.run({
        wake: running,
        context,
        ...(workspacePath ? { workspacePath } : {}),
        limits: this.#limits,
        now: () => this.#now(),
        emit: (trace) => this.ledger.appendEvent({ ts: this.#now(), agent: running.agent, kind: `runner.${trace.kind}`, data: trace.data, wakeId: running.id }),
      });

      if (result.outcome === "abnormal") {
        await this.#markAbnormal(running, result.reason);
        return this.#wake(running.id);
      }

      this.ledger.appendEvent({
        ts: this.#now(), agent: running.agent, kind: "handoff.recorded",
        data: result.output.handoff as unknown as JsonValue, wakeId: running.id,
      });
      for (const draft of result.output.mail) {
        this.ledger.putMail({ id: randomUUID(), to: draft.to, from: running.agent, level: draft.level, body: draft.body, readAt: null }, running.agent, running.id);
      }
      if (result.output.nextWakeAt) this.planWake(running.agent, result.output.nextWakeAt, "handoff.next_steps", running.agent);

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
      await this.#markAbnormal(running, error instanceof Error ? error.message : String(error));
      return this.#wake(running.id);
    }
  }

  async submitAction(action: Omit<ActionSnapshot, "gated" | "status" | "reconciledAt" | "externalRef">, connectorName: string): Promise<ActionSnapshot> {
    const connector = this.#connectors.get(connectorName);
    const capability = connector ? capabilityFor(connector.manifest, action.kind) : null;
    const gated = !connector || !capability || capability.risk !== "reversible"
      || (!connector.manifest.dryRun && !this.#allowExternalActions)
      || (capability ? !payloadWithinConstraints(action.payload, capability.constraints) : true);
    const requested: ActionSnapshot = { ...action, gated, status: "requested", reconciledAt: null, externalRef: null };
    this.ledger.requestAction(requested);
    if (gated || !connector) return this.#action(action.id);
    this.ledger.transitionAction(action.id, "approved");
    return this.#dispatch(action.id, connector);
  }

  async reconcileAction(id: string, connectorName: string): Promise<ActionSnapshot> {
    const action = this.#action(id);
    if (action.status !== "unknown") throw new Error("only unknown actions may be reconciled");
    const connector = this.#requiredConnector(connectorName);
    const capability = capabilityFor(connector.manifest, action.kind);
    if (!capability || capability.query === "none") throw new Error("connector cannot reconcile this action");
    const result = await connector.query(action);
    if (result.status === "pending") return action;
    return this.ledger.transitionAction(id, result.status, {
      reconciledAt: this.#now(),
      ...(result.externalRef ? { externalRef: result.externalRef } : {}),
    });
  }

  async retryUnknownAction(id: string, connectorName: string): Promise<ActionSnapshot> {
    const action = this.#action(id);
    if (action.status !== "unknown") throw new Error("only unknown actions may be retried");
    const connector = this.#requiredConnector(connectorName);
    const capability = capabilityFor(connector.manifest, action.kind);
    if (!capability?.nativeIdempotency || !capability.automaticRetry) throw new Error("connector manifest forbids automatic retry");
    return this.#dispatch(id, connector);
  }

  async #dispatch(id: string, connector: Connector): Promise<ActionSnapshot> {
    const dispatching = this.ledger.transitionAction(id, "dispatching");
    const result = await connector.dispatch(dispatching);
    return this.ledger.transitionAction(id, result.status, result.externalRef ? { externalRef: result.externalRef } : {});
  }

  async #markAbnormal(wake: WakeSnapshot, reason: string): Promise<void> {
    const salvage = await this.#workspace.salvage(wake);
    if (salvage) this.#workspaceEvent("workspace.salvaged", wake, salvage);
    this.ledger.appendEvent({ ts: this.#now(), agent: wake.agent, kind: "wake.abnormal_reason", data: { reason }, wakeId: wake.id });
    const current = this.#wake(wake.id);
    if (current.status === "leased" || current.status === "running" || current.status === "queued") {
      this.ledger.finishWake(wake.id, "abnormal", this.#now());
    }
  }

  #enqueueSchedule(schedule: ScheduleSnapshot): WakeSnapshot {
    const wake: WakeSnapshot = {
      id: randomUUID(), agent: schedule.agent, triggerRef: `${schedule.id}@${schedule.nextWakeAt}`,
      status: "queued", leaseUntil: null, attempt: 0, startedAt: null, endedAt: null,
    };
    const result = this.ledger.enqueueWake(wake, "supervisor");
    if (result.created) return wake;
    const existing = this.ledger.wakes().find((item) => item.agent === wake.agent && item.triggerRef === wake.triggerRef);
    if (!existing) throw new Error("deduplicated wake is missing");
    return existing;
  }

  #loadContext(wake: WakeSnapshot): JsonValue {
    const goals = this.ledger.goals().filter((goal) => goal.owner === wake.agent);
    const mail = this.ledger.mailbox().filter((item) => item.to === wake.agent && item.readAt === null);
    const handoff = this.ledger.events().findLast((event) => event.agent === wake.agent && event.kind === "handoff.recorded");
    const recoveryId = wake.triggerRef.startsWith("recovery:") ? wake.triggerRef.slice("recovery:".length) : null;
    const recoveryEvents = recoveryId ? this.ledger.events().filter((event) => event.wakeId === recoveryId) : [];
    return { goals, mail, lastHandoff: handoff?.data ?? null, recoveryEvents } as unknown as JsonValue;
  }

  #workspaceEvent(kind: string, wake: WakeSnapshot, data: object): void {
    this.ledger.appendEvent({ ts: this.#now(), agent: "supervisor", kind, data: data as JsonValue, wakeId: wake.id });
  }

  #requiredConnector(name: string): Connector {
    const connector = this.#connectors.get(name);
    if (!connector) throw new Error(`connector not registered: ${name}`);
    return connector;
  }

  #wake(id: string): WakeSnapshot {
    const wake = this.ledger.wakes().find((item) => item.id === id);
    if (!wake) throw new Error(`wake not found: ${id}`);
    return wake;
  }

  #action(id: string): ActionSnapshot {
    const action = this.ledger.actions().find((item) => item.id === id);
    if (!action) throw new Error(`action not found: ${id}`);
    return action;
  }

  #now(): string { return this.clock.now().toISOString(); }
}

function safe(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, "-"); }

function payloadWithinConstraints(payload: JsonValue, constraints: { allowedAccounts?: string[]; allowedEnvironments?: string[]; maxAmount?: number }): boolean {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return Object.keys(constraints).length === 0;
  if (constraints.allowedAccounts && (typeof payload.account !== "string" || !constraints.allowedAccounts.includes(payload.account))) return false;
  if (constraints.allowedEnvironments && (typeof payload.environment !== "string" || !constraints.allowedEnvironments.includes(payload.environment))) return false;
  if (constraints.maxAmount !== undefined && (typeof payload.amount !== "number" || payload.amount > constraints.maxAmount)) return false;
  return true;
}

function git(cwd: string, args: string[]): string {
  const result = gitResult(cwd, args);
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout.trim();
}

function gitResult(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}
