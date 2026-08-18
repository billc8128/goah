#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRuntime, loadConfig, SupervisorLock, writeDefaultConfig } from "./index.js";

const args = process.argv.slice(2);
const command = args[0] ?? "help";
const configPath = option("--config") ?? "goah.config.json";

if (command === "init") {
  writeDefaultConfig(configPath);
  console.log(`created ${configPath}`);
} else if (command === "help") {
  console.log("goah init|start|status|doctor|goal-list|goal-create|action-list|approve|reject|dashboard");
} else {
  const config = loadConfig(configPath);
  const { ledger, supervisor } = createRuntime(config);
  try {
    if (command === "start") {
      const lock = new SupervisorLock(config.stateDir); lock.acquire();
      const controller = new AbortController();
      const stop = () => controller.abort(); process.on("SIGINT", stop); process.on("SIGTERM", stop);
      try { await run(supervisor, controller.signal); } finally { lock.release(); }
    } else if (command === "status") {
      console.log(JSON.stringify({ seq: ledger.events().at(-1)?.seq ?? 0, goals: ledger.goals(), wakes: ledger.wakes(), actions: ledger.actions() }, null, 2));
    } else if (command === "doctor") {
      console.log(JSON.stringify({ ok: true, contractVersion: (await import("./index.js")).CONTRACT_VERSION, workspace: config.workspace, stateDir: config.stateDir }, null, 2));
    } else if (command === "goal-list") console.log(JSON.stringify(ledger.goals(), null, 2));
    else if (command === "goal-create") {
      const id = required("--id"); const owner = required("--owner"); const objective = required("--objective");
      supervisor.createGoal({ id, parentId: option("--parent"), objective, owner, phase: "active", revision: 0, target: Number(option("--target") ?? 1), budget: null, metric: { source: option("--metric-source") ?? id, window: option("--window") ?? "latest", direction: "at_least", target: Number(option("--target") ?? 1), freshnessMs: Number(option("--freshness-ms") ?? 86_400_000), onMissing: "wake_owner", onStale: "wake_owner" } }, option("--actor") ?? "human");
      console.log(`created goal ${id}`);
    } else if (command === "action-list") console.log(JSON.stringify(ledger.actions(), null, 2));
    else if (command === "approve") console.log(JSON.stringify(await supervisor.approveAction(requiredPositional(1), option("--actor") ?? "human", required("--reason"), evidence()), null, 2));
    else if (command === "reject") console.log(JSON.stringify(supervisor.rejectAction(requiredPositional(1), option("--actor") ?? "human", required("--reason"), evidence()), null, 2));
    else if (command === "dashboard") { const path = option("--output") ?? join(config.stateDir, "status.html"); writeFileSync(path, (await import("@goah/supervisor")).renderDashboard(ledger)); console.log(path); }
    else throw new Error(`unknown command: ${command}`);
  } finally { ledger.close(); }
}

async function run(supervisor: ReturnType<typeof createRuntime>["supervisor"], signal: AbortSignal): Promise<void> {
  const { runSupervisorDaemon } = await import("@goah/supervisor");
  await runSupervisorDaemon(supervisor, { signal });
}
function option(name: string): string | null { const index = args.indexOf(name); return index >= 0 ? args[index + 1] ?? null : null; }
function required(name: string): string { const value = option(name); if (!value) throw new Error(`${name} is required`); return value; }
function requiredPositional(index: number): string { const value = args[index]; if (!value || value.startsWith("--")) throw new Error("action id is required"); return value; }
function evidence(): number[] { return required("--evidence").split(",").map(Number); }
