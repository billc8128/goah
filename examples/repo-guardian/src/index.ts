import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_VERSION } from "@goah/ledger-contract";
import { SqliteLedger } from "@goah/ledger-sqlite";
import { piWorkerPath, ProcessRunner } from "@goah/runner-pi";
import { GitWorkspaceManager, renderDashboard, runSupervisorDaemon, Supervisor } from "@goah/supervisor";
import { fauxRunnerWorkerPath } from "@goah/testkit";

const repo = process.env.GOAH_GUARD_REPO ?? process.cwd();
const stateDir = process.env.GOAH_GUARD_STATE ?? join(repo, ".goah");
mkdirSync(stateDir, { recursive: true });
const ledger = new SqliteLedger(join(stateDir, "guardian.sqlite"));
const model = process.env.GOAH_PI_MODEL;
const runner = new ProcessRunner(model
  ? { command: process.execPath, args: [piWorkerPath()], env: { GOAH_PI_MODEL: model, GOAH_PI_PROVIDER: process.env.GOAH_PI_PROVIDER ?? "anthropic", ...(process.env.GOAH_PI_BASE_URL ? { GOAH_PI_BASE_URL: process.env.GOAH_PI_BASE_URL } : {}), ...(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}), ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {}), ...(process.env.ARK_API_KEY ? { ARK_API_KEY: process.env.ARK_API_KEY } : {}), GOAH_PI_ALLOW_BASH: "true" } }
  : { command: process.execPath, args: [fauxRunnerWorkerPath()], env: { GOAH_FAUX_STEPS: JSON.stringify([{ tokens: 10, handoff: { handoff: { observations: ["test status collected"], results: [], nextSteps: ["check again"] }, mail: [], nextWakeAt: new Date(Date.now() + 86_400_000).toISOString() } }]) } });
const supervisor = new Supervisor(ledger, runner, new class { now(): Date { return new Date(); } }(), {
  workspace: new GitWorkspaceManager(repo),
  ...(model ? { limits: {
    maxTokens: Number(process.env.GOAH_PI_MAX_TOKENS ?? 24_000),
    maxWallClockMs: Number(process.env.GOAH_PI_MAX_WALL_CLOCK_MS ?? 180_000),
    handoffReserveTokens: Number(process.env.GOAH_PI_HANDOFF_RESERVE_TOKENS ?? 6_000),
    handoffReserveWallClockMs: Number(process.env.GOAH_PI_HANDOFF_RESERVE_WALL_CLOCK_MS ?? 15_000),
  } } : {}),
  heartbeatPolicies: [{ agent: "guardian", maxSilentMs: 172_800_000, escalateTo: "human" }],
  verifyMetricsAfterWake: Boolean(model),
  retryPolicy: { maxAttempts: 2, baseDelayMs: 5_000 },
  profiles: [{
    agent: "guardian",
    role: "child",
    systemPrompt: "Keep this repository's test metric green. Run the configured tests first. If they fail, diagnose from concrete output, make the smallest safe code change, rerun tests, record durable notes, and hand off only after verification. Never claim a repair without command evidence.",
  }],
});

if (!ledger.goal("repo-health")) supervisor.createGoal({
  id: "repo-health", parentId: null, objective: "Keep the repository tests green", owner: "guardian", phase: "active", revision: 0, target: 1, budget: null,
  metric: { source: "repo.tests", window: "latest", direction: "at_least", target: 1, freshnessMs: 172_800_000, onMissing: "wake_owner", onStale: "wake_owner" },
});
const workerDir = fileURLToPath(new URL(".", import.meta.url));
supervisor.registerMetricCollector("repo-health", { command: process.execPath, args: [join(workerDir, "metric-worker.js")], env: { GOAH_GUARD_REPO: repo, ...(process.env.GOAH_GUARD_TEST_COMMAND ? { GOAH_GUARD_TEST_COMMAND: process.env.GOAH_GUARD_TEST_COMMAND } : {}) }, timeoutMs: 310_000 }, 86_400_000);
supervisor.registerConnector({
  manifest: { contractVersion: CONTRACT_VERSION, connector: "repo", dryRun: true, capabilities: [{ kind: "repo.run_check", nativeIdempotency: true, query: "by_idempotency_key", automaticRetry: true, risk: "reversible", constraints: {} }] },
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
