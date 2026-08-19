import { accessSync, constants, existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CONTRACT_VERSION, assertRunLimits, evaluateMetric, type AgentProfile, type ConnectorManifest, type MetricProcessSpec, type RunLimits } from "@goah/ledger-contract";
import { SQLITE_SCHEMA_VERSION, SqliteLedger } from "@goah/ledger-sqlite";
import { createPiModel, piWorkerPath, ProcessRunner } from "@goah/runner-pi";
import { GitWorkspaceManager, renderDashboard, runSupervisorDaemon, Supervisor } from "@goah/supervisor";

export interface GoahConfig {
  version: 1;
  workspace: string;
  stateDir: string;
  runner: { command: string; args: string[]; env?: Record<string, string>; inheritEnv?: string[] };
  limits?: RunLimits;
  profiles?: AgentProfile[];
  approvers?: string[];
  auditWriters?: string[];
  heartbeatPolicies?: Array<{ agent: string; maxSilentMs: number; escalateTo: string; since?: string }>;
  retryPolicy?: { maxAttempts: number; baseDelayMs: number };
  verifyMetricsAfterWake?: boolean;
  connectors?: Array<{ manifest: ConnectorManifest; command: string; args: string[]; env?: Record<string, string>; timeoutMs?: number }>;
  metrics?: Array<{ goalId: string; intervalMs: number; process: MetricProcessSpec }>;
}

export type PiProvider = "anthropic" | "openai" | "ark-coding" | "faux";
export interface InitOptions {
  provider?: PiProvider;
  model?: string;
  apiKeyEnv?: string;
  agent?: string;
  contextWindowTokens?: number;
  maxOutputTokensPerTurn?: number;
  baseUrl?: string;
}
export interface DoctorCheck { name: string; ok: boolean; detail: string }

export function loadConfig(path = "goah.config.json", options: { resolveSecrets?: boolean } = {}): GoahConfig {
  const absolute = resolve(path);
  const config = JSON.parse(readFileSync(absolute, "utf8")) as GoahConfig;
  if (config.version !== 1) throw new Error(`unsupported goah config version: ${String(config.version)}`);
  const base = dirname(absolute);
  config.workspace = absolutePath(base, config.workspace);
  config.stateDir = absolutePath(base, config.stateDir);
  config.runner.command = resolveCommand(config.runner.command);
  config.runner.args = config.runner.args.map((arg) => arg === "$GOAH_PI_WORKER" ? piWorkerPath() : arg);
  if (options.resolveSecrets !== false) config.runner.env = resolveEnv(config.runner.env);
  for (const connector of config.connectors ?? []) { connector.command = resolveCommand(connector.command); if (options.resolveSecrets !== false) connector.env = resolveEnv(connector.env); }
  for (const metric of config.metrics ?? []) { metric.process.command = resolveCommand(metric.process.command); if (options.resolveSecrets !== false) metric.process.env = resolveEnv(metric.process.env); }
  return config;
}

export function createRuntime(config: GoahConfig): { ledger: SqliteLedger; supervisor: Supervisor } {
  if (config.limits) assertRunLimits(config.limits);
  mkdirSync(config.stateDir, { recursive: true });
  const ledger = new SqliteLedger(join(config.stateDir, "ledger.sqlite"));
  const runner = new ProcessRunner(config.runner);
  const supervisor = new Supervisor(ledger, runner, new class { now(): Date { return new Date(); } }(), {
    workspace: new GitWorkspaceManager(config.workspace),
    ...(config.limits ? { limits: config.limits } : {}),
    ...(config.profiles ? { profiles: config.profiles } : {}),
    ...(config.approvers ? { approvers: config.approvers } : {}),
    ...(config.auditWriters ? { auditWriters: config.auditWriters } : {}),
    ...(config.heartbeatPolicies ? { heartbeatPolicies: config.heartbeatPolicies } : {}),
    ...(config.retryPolicy ? { retryPolicy: config.retryPolicy } : {}),
    ...(config.verifyMetricsAfterWake !== undefined ? { verifyMetricsAfterWake: config.verifyMetricsAfterWake } : {}),
  });
  for (const connector of config.connectors ?? []) supervisor.registerConnector(connector);
  for (const metric of config.metrics ?? []) supervisor.registerMetricCollector(metric.goalId, metric.process, metric.intervalMs);
  return { ledger, supervisor };
}

export function defaultConfig(_directory: string, options: InitOptions = {}): GoahConfig {
  const provider = options.provider ?? "anthropic";
  const model = options.model ?? defaultModel(provider);
  const runnerEnv = providerEnvironment(provider, model, options);
  return {
    version: 1,
    workspace: ".",
    stateDir: ".goah",
    runner: { command: process.execPath, args: ["$GOAH_PI_WORKER"], env: runnerEnv },
    limits: { maxTotalTokens: 2_000_000, maxWallClockMs: 3_600_000, handoffReserveTokens: 96_000, handoffReserveWallClockMs: 120_000 },
    profiles: [{ agent: options.agent ?? "worker", role: "child" }],
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

export function writeDefaultConfig(path = "goah.config.json", options: InitOptions = {}): void {
  const absolute = resolve(path);
  if (existsSync(absolute)) throw new Error(`${absolute} already exists`);
  writeFileSync(absolute, `${JSON.stringify(defaultConfig(dirname(absolute), options), null, 2)}\n`);
}

export function diagnoseConfig(config: GoahConfig): { ok: boolean; checks: DoctorCheck[] } {
  const checks: DoctorCheck[] = [];
  const check = (name: string, fn: () => string): void => {
    try { checks.push({ name, ok: true, detail: fn() }); }
    catch (error) { checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) }); }
  };
  check("node", () => {
    if (Number(process.versions.node.split(".")[0]) < 24) throw new Error(`Node ${process.versions.node} is unsupported; require >=24`);
    return process.versions.node;
  });
  check("workspace", () => {
    const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: config.workspace, encoding: "utf8" });
    if (result.status !== 0 || result.stdout.trim() !== "true") throw new Error(result.stderr.trim() || "workspace is not a Git repository");
    return config.workspace;
  });
  check("state", () => {
    const existing = nearestExisting(config.stateDir);
    accessSync(existing, constants.W_OK);
    const database = join(config.stateDir, "ledger.sqlite");
    if (!existsSync(database)) return `${config.stateDir} (will create)`;
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (version > SQLITE_SCHEMA_VERSION) throw new Error(`ledger schema ${version} is newer than supported schema ${SQLITE_SCHEMA_VERSION}`);
      return `${database} (schema ${version}${version < SQLITE_SCHEMA_VERSION ? `, migrates to ${SQLITE_SCHEMA_VERSION}` : ""})`;
    }
    finally { db.close(); }
  });
  check("limits", () => { assertRunLimits(config.limits ?? defaultConfig(config.workspace).limits!); return JSON.stringify(config.limits); });
  check("runner", () => {
    accessSync(config.runner.command, constants.X_OK);
    const workerArg = config.runner.args[0];
    if (workerArg && isAbsolute(workerArg)) accessSync(workerArg, constants.R_OK);
    const env = resolveEnv(config.runner.env);
    const provider = requiredEnv(env, "GOAH_PI_PROVIDER");
    const modelId = requiredEnv(env, "GOAH_PI_MODEL");
    const model = createPiModel(provider, modelId, env).model;
    const key = provider === "anthropic" ? "ANTHROPIC_API_KEY" : provider === "openai" ? "OPENAI_API_KEY" : provider === "ark-coding" ? "ARK_API_KEY" : null;
    if (key && !env[key]) throw new Error(`${key} is missing`);
    return `${provider}/${modelId} context=${model.contextWindow} output=${model.maxTokens}`;
  });
  return { ok: checks.every((item) => item.ok), checks };
}

export function statusSnapshot(ledger: SqliteLedger, now = new Date().toISOString()): object {
  const events = ledger.events();
  const wakes = ledger.wakes().map((wake) => {
    const wakeEvents = events.filter((event) => event.wakeId === wake.id);
    const abnormal = [...wakeEvents].reverse().find((event) => event.kind === "wake.abnormal_reason");
    const tokensUsed = wakeEvents.reduce((total, event) => total + assistantTokens(event.data), 0);
    return { ...wake, tokensUsed, abnormalReason: abnormal ? field(abnormal.data, "reason") : null };
  });
  const goals = ledger.goals().map((goal) => ({ ...goal, evaluation: evaluateMetric(goal.metric, ledger.metricSamples(goal.id), now) }));
  const handoffs = events.filter((event) => event.kind === "handoff.recorded").slice(-20).map((event) => ({ seq: event.seq, ts: event.ts, agent: event.agent, wakeId: event.wakeId, handoff: event.data }));
  const modelCapabilities = [...events].reverse().find((event) => event.kind === "runner.model.capabilities")?.data ?? null;
  return { seq: events.at(-1)?.seq ?? 0, goals, wakes, actions: ledger.actions(), modelCapabilities, recentHandoffs: handoffs };
}

function resolveEnv(env: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => {
    if (!value.startsWith("env:")) return [key, value];
    const name = value.slice(4); const resolved = process.env[name];
    if (resolved === undefined) throw new Error(`required environment variable is missing: ${name}`);
    return [key, resolved];
  }));
}
function defaultModel(provider: PiProvider): string {
  if (provider === "anthropic") return "claude-sonnet-4-6";
  if (provider === "faux") return "faux-goah";
  throw new Error(`--model is required for provider ${provider}`);
}
function providerEnvironment(provider: PiProvider, model: string, options: InitOptions): Record<string, string> {
  const env: Record<string, string> = { GOAH_PI_PROVIDER: provider, GOAH_PI_MODEL: model };
  if (provider === "faux") {
    env.GOAH_PI_FAUX_HANDOFF = JSON.stringify({ observations: ["faux runner completed"], results: [], nextSteps: [] });
    return env;
  }
  const destination = provider === "anthropic" ? "ANTHROPIC_API_KEY" : provider === "openai" ? "OPENAI_API_KEY" : "ARK_API_KEY";
  env[destination] = `env:${options.apiKeyEnv ?? destination}`;
  if (options.baseUrl) env.GOAH_PI_BASE_URL = options.baseUrl;
  if (provider === "ark-coding") {
    if (!Number.isInteger(options.contextWindowTokens) || !Number.isInteger(options.maxOutputTokensPerTurn)) throw new Error("ark-coding requires --context-window-tokens and --max-output-tokens");
    env.GOAH_PI_MODEL_CAPABILITIES = JSON.stringify({ contextWindowTokens: options.contextWindowTokens, maxOutputTokensPerTurn: options.maxOutputTokensPerTurn });
  }
  return env;
}
function requiredEnv(env: Record<string, string>, name: string): string { const value = env[name]; if (!value) throw new Error(`${name} is missing`); return value; }
function nearestExisting(path: string): string { let current = resolve(path); while (!existsSync(current)) { const parent = dirname(current); if (parent === current) break; current = parent; } return current; }
function field(value: unknown, key: string): unknown { return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined; }
function assistantTokens(value: unknown): number {
  const message = field(value, "message");
  if (field(message, "role") !== "assistant") return 0;
  const usage = field(message, "usage");
  const total = field(usage, "totalTokens");
  return typeof total === "number" ? total : 0;
}
function resolveCommand(command: string): string { return command === "$NODE" ? process.execPath : command; }
function absolutePath(base: string, value: string): string { return isAbsolute(value) ? value : resolve(base, value); }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
export { CONTRACT_VERSION };
