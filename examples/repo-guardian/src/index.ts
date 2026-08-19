import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_VERSION } from "goah-ledger-contract";
import { SqliteLedger } from "goah-ledger-sqlite";
import { piWorkerPath, ProcessRunner } from "goah-runner-pi";
import { renderDashboard, runSupervisorDaemon, Supervisor } from "goah-supervisor";
import { fauxRunnerWorkerPath } from "goah-testkit";

const repo = process.env.GOAH_GUARD_REPO ?? process.cwd();
const stateId = createHash("sha256").update(repo).digest("hex").slice(0, 16);
const stateDir = process.env.GOAH_GUARD_STATE ?? join(homedir(), ".goah", "repo-guardian", stateId);
mkdirSync(stateDir, { recursive: true });
const ledger = new SqliteLedger(join(stateDir, "guardian.sqlite"));
const model = process.env.GOAH_PI_MODEL;
const piEnv = model ? {
  GOAH_PI_MODEL: model,
  GOAH_PI_PROVIDER: process.env.GOAH_PI_PROVIDER ?? "anthropic",
  GOAH_PI_ALLOW_BASH: "true",
  ...forwardEnv(["GOAH_PI_BASE_URL", "GOAH_PI_MODEL_CAPABILITIES", "GOAH_PI_COMPACT_AT_TOKENS", "GOAH_PI_RETAIN_CONTEXT_TOKENS", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ARK_API_KEY"]),
} : null;
const runner = new ProcessRunner(model
  ? { command: process.execPath, args: [piWorkerPath()], cwd: repo, env: piEnv! }
  : { command: process.execPath, args: [fauxRunnerWorkerPath()], cwd: repo, env: { GOAH_FAUX_STEPS: JSON.stringify([{ handoff: { handoff: { observations: ["test status collected"], results: [], nextSteps: ["check again"] }, mail: [], nextWakeAt: new Date(Date.now() + 86_400_000).toISOString() } }]) } });
const supervisor = new Supervisor(ledger, runner, new class { now(): Date { return new Date(); } }(), {
  heartbeatPolicies: [{ agent: "guardian", maxSilentMs: 172_800_000, escalateTo: "human" }],
  verifyMetricsAfterWake: Boolean(model),
  retryPolicy: { maxAttempts: 2, baseDelayMs: 5_000 },
  profiles: [{
    agent: "guardian",
    role: "child",
    systemPrompt: "Keep this repository's test metric green. Run the configured tests first. If they fail, diagnose from concrete output, make the smallest safe code change, rerun tests, and commit verified work with Git when appropriate. Manage branches or worktrees yourself when concurrent work could conflict. Never claim a repair without command evidence.",
  }],
});

if (!ledger.goal("repo-health")) supervisor.createGoal({
  id: "repo-health", parentId: null, objective: "Keep the repository tests green", owner: "guardian", phase: "active", revision: 0, target: 1,
  metric: { source: "repo.tests", window: "latest", direction: "at_least", target: 1, freshnessMs: 172_800_000, onMissing: "wake_owner", onStale: "wake_owner" },
});
const workerDir = fileURLToPath(new URL(".", import.meta.url));
supervisor.registerMetricCollector("repo-health", { command: process.execPath, args: [join(workerDir, "metric-worker.js")], env: { GOAH_GUARD_REPO: repo, ...(process.env.GOAH_GUARD_TEST_COMMAND ? { GOAH_GUARD_TEST_COMMAND: process.env.GOAH_GUARD_TEST_COMMAND } : {}) }, timeoutMs: 310_000 }, 86_400_000);
supervisor.registerConnector({
  manifest: { contractVersion: CONTRACT_VERSION, connector: "repo", dryRun: true, capabilities: [{ kind: "repo.run_check", nativeIdempotency: true, query: "by_idempotency_key", automaticRetry: true, risk: "reversible" }] },
  command: process.execPath, args: [join(workerDir, "connector-worker.js")], env: { GOAH_GUARD_REPO: repo }, timeoutMs: 310_000,
});
supervisor.planWake("guardian", new Date().toISOString(), "initial repository health check", "supervisor");

if (process.argv.includes("--daemon")) {
  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort()); process.on("SIGINT", () => controller.abort());
  await runSupervisorDaemon(supervisor, { signal: controller.signal });
} else {
  await supervisor.runAvailable(1, model ? 10 : 1);
  writeFileSync(join(stateDir, "status.html"), renderDashboard(ledger));
  ledger.close();
}

function forwardEnv(names: string[]): Record<string, string> {
  return Object.fromEntries(names.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
}
