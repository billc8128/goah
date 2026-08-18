import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CONTRACT_VERSION, type AgentProfile, type ConnectorManifest, type MetricProcessSpec } from "@goah/ledger-contract";
import { SqliteLedger } from "@goah/ledger-sqlite";
import { piWorkerPath, ProcessRunner } from "@goah/runner-pi";
import { GitWorkspaceManager, renderDashboard, runSupervisorDaemon, Supervisor } from "@goah/supervisor";

export interface GoahConfig {
  version: 1;
  workspace: string;
  stateDir: string;
  runner: { command: string; args: string[]; env?: Record<string, string>; inheritEnv?: string[] };
  profiles?: AgentProfile[];
  approvers?: string[];
  auditWriters?: string[];
  heartbeatPolicies?: Array<{ agent: string; maxSilentMs: number; escalateTo: string; since?: string }>;
  retryPolicy?: { maxAttempts: number; baseDelayMs: number };
  connectors?: Array<{ manifest: ConnectorManifest; command: string; args: string[]; env?: Record<string, string>; timeoutMs?: number }>;
  metrics?: Array<{ goalId: string; intervalMs: number; process: MetricProcessSpec }>;
}

export function loadConfig(path = "goah.config.json"): GoahConfig {
  const absolute = resolve(path);
  const config = JSON.parse(readFileSync(absolute, "utf8")) as GoahConfig;
  if (config.version !== 1) throw new Error(`unsupported goah config version: ${String(config.version)}`);
  const base = dirname(absolute);
  config.workspace = absolutePath(base, config.workspace);
  config.stateDir = absolutePath(base, config.stateDir);
  config.runner.command = resolveCommand(config.runner.command);
  config.runner.args = config.runner.args.map((arg) => arg === "$GOAH_PI_WORKER" ? piWorkerPath() : arg);
  config.runner.env = resolveEnv(config.runner.env);
  for (const connector of config.connectors ?? []) { connector.command = resolveCommand(connector.command); connector.env = resolveEnv(connector.env); }
  for (const metric of config.metrics ?? []) { metric.process.command = resolveCommand(metric.process.command); metric.process.env = resolveEnv(metric.process.env); }
  return config;
}

export function createRuntime(config: GoahConfig): { ledger: SqliteLedger; supervisor: Supervisor } {
  mkdirSync(config.stateDir, { recursive: true });
  const ledger = new SqliteLedger(join(config.stateDir, "ledger.sqlite"));
  const runner = new ProcessRunner(config.runner);
  const supervisor = new Supervisor(ledger, runner, new class { now(): Date { return new Date(); } }(), {
    workspace: new GitWorkspaceManager(config.workspace),
    ...(config.profiles ? { profiles: config.profiles } : {}),
    ...(config.approvers ? { approvers: config.approvers } : {}),
    ...(config.auditWriters ? { auditWriters: config.auditWriters } : {}),
    ...(config.heartbeatPolicies ? { heartbeatPolicies: config.heartbeatPolicies } : {}),
    ...(config.retryPolicy ? { retryPolicy: config.retryPolicy } : {}),
  });
  for (const connector of config.connectors ?? []) supervisor.registerConnector(connector);
  for (const metric of config.metrics ?? []) supervisor.registerMetricCollector(metric.goalId, metric.process, metric.intervalMs);
  return { ledger, supervisor };
}

export function defaultConfig(directory: string): GoahConfig {
  return {
    version: 1,
    workspace: ".",
    stateDir: ".goah",
    runner: { command: process.execPath, args: ["$GOAH_PI_WORKER"], env: { GOAH_PI_PROVIDER: "anthropic", GOAH_PI_MODEL: "claude-sonnet-4-6", ANTHROPIC_API_KEY: "env:ANTHROPIC_API_KEY" } },
    profiles: [{ agent: "worker", role: "child" }],
    approvers: ["human", "ceo"],
    auditWriters: ["verifier", "audit"],
    retryPolicy: { maxAttempts: 2, baseDelayMs: 5_000 },
  };
}

export class SupervisorLock {
  readonly path: string;
  #owned = false;
  constructor(stateDir: string) { this.path = join(stateDir, "supervisor.lock"); }
  acquire(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    if (existsSync(this.path)) {
      const pid = Number(readFileSync(this.path, "utf8"));
      if (Number.isInteger(pid) && alive(pid)) throw new Error(`supervisor already running with pid ${pid}`);
      rmSync(this.path);
    }
    const fd = openSync(this.path, "wx");
    writeFileSync(fd, String(process.pid)); closeSync(fd); this.#owned = true;
  }
  release(): void { if (this.#owned) { rmSync(this.path, { force: true }); this.#owned = false; } }
}

export function writeDefaultConfig(path = "goah.config.json"): void {
  const absolute = resolve(path);
  if (existsSync(absolute)) throw new Error(`${absolute} already exists`);
  writeFileSync(absolute, `${JSON.stringify(defaultConfig(dirname(absolute)), null, 2)}\n`);
}

function resolveEnv(env: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => {
    if (!value.startsWith("env:")) return [key, value];
    const name = value.slice(4); const resolved = process.env[name];
    if (resolved === undefined) throw new Error(`required environment variable is missing: ${name}`);
    return [key, resolved];
  }));
}
function resolveCommand(command: string): string { return command === "$NODE" ? process.execPath : command; }
function absolutePath(base: string, value: string): string { return isAbsolute(value) ? value : resolve(base, value); }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
export { CONTRACT_VERSION };
