#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { discardWorkspaceRef, inspectWorkspaceRef, recoverWorkspaceRef } from "@goah/supervisor";
import { createRuntime, diagnoseConfig, loadConfig, statusSnapshot, SupervisorLock, type PiProvider, writeDefaultConfig } from "./index.js";

const args = process.argv.slice(2);

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const command = args[0] ?? "help";
  const configPath = option("--config") ?? "goah.config.json";
  if (command === "help") { printHelp(); return; }
  if (command === "init") {
    const provider = providerOption(option("--provider") ?? "anthropic");
    writeDefaultConfig(configPath, {
      provider,
      ...(option("--model") ? { model: option("--model")! } : {}),
      ...(option("--api-key-env") ? { apiKeyEnv: option("--api-key-env")! } : {}),
      ...(option("--agent") ? { agent: option("--agent")! } : {}),
      ...(option("--context-window-tokens") ? { contextWindowTokens: numberOption("--context-window-tokens") } : {}),
      ...(option("--max-output-tokens") ? { maxOutputTokensPerTurn: numberOption("--max-output-tokens") } : {}),
      ...(option("--base-url") ? { baseUrl: option("--base-url")! } : {}),
    });
    console.log(JSON.stringify({ created: configPath, provider }, null, 2));
    return;
  }

  const config = loadConfig(configPath, { resolveSecrets: command !== "doctor" });
  if (command === "doctor") {
    const result = diagnoseConfig(config);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  const lock = mutates(command) ? new SupervisorLock(config.stateDir) : null;
  lock?.acquire();
  let runtime: ReturnType<typeof createRuntime> | null = null;
  try {
    runtime = createRuntime(config);
    const { ledger, supervisor } = runtime;
    if (command === "start") {
      const controller = new AbortController();
      const stop = () => controller.abort(); process.on("SIGINT", stop); process.on("SIGTERM", stop);
      await run(supervisor, controller.signal);
    } else if (command === "run-once") {
      await supervisor.recover();
      console.log(JSON.stringify({ wake: await supervisor.tick() }, null, 2));
    } else if (command === "wake") {
      const agent = requiredPositional(1, "agent");
      const wake = supervisor.planWake(agent, new Date().toISOString(), option("--reason") ?? "manual wake", "supervisor");
      console.log(JSON.stringify({ wake }, null, 2));
    } else if (command === "status") {
      console.log(JSON.stringify(statusSnapshot(ledger), null, 2));
    } else if (command === "goal-list") console.log(JSON.stringify(ledger.goals(), null, 2));
    else if (command === "goal-create") {
      const id = required("--id"); const owner = required("--owner"); const objective = required("--objective");
      const target = Number(option("--target") ?? 1);
      const goal = { id, parentId: option("--parent"), objective, owner, phase: "active" as const, revision: 0, target, budget: null, metric: { source: option("--metric-source") ?? id, window: option("--window") ?? "latest", direction: "at_least" as const, target, freshnessMs: Number(option("--freshness-ms") ?? 86_400_000), onMissing: "wake_owner" as const, onStale: "wake_owner" as const } };
      supervisor.createGoal(goal, option("--actor") ?? "human");
      const wake = flag("--wake-now") ? supervisor.planWake(owner, new Date().toISOString(), `goal:${id}`, "supervisor") : null;
      console.log(JSON.stringify({ goal, wake }, null, 2));
    } else if (command === "action-list") console.log(JSON.stringify(ledger.actions(), null, 2));
    else if (command === "approve") console.log(JSON.stringify(await supervisor.approveAction(requiredPositional(1, "action id"), option("--actor") ?? "human", required("--reason"), evidence()), null, 2));
    else if (command === "reject") console.log(JSON.stringify(supervisor.rejectAction(requiredPositional(1, "action id"), option("--actor") ?? "human", required("--reason"), evidence()), null, 2));
    else if (command === "dashboard") { const path = option("--output") ?? join(config.stateDir, "status.html"); writeFileSync(path, (await import("@goah/supervisor")).renderDashboard(ledger)); console.log(path); }
    else if (command === "workspace-inspect") console.log(inspectWorkspaceRef(config.workspace, requiredPositional(1, "workspace ref")));
    else if (command === "workspace-recover") console.log(recoverWorkspaceRef(config.workspace, requiredPositional(1, "workspace ref"), required("--branch")));
    else if (command === "workspace-discard") { if (option("--yes") !== "true") throw new Error("workspace-discard requires --yes true"); discardWorkspaceRef(config.workspace, requiredPositional(1, "workspace ref")); console.log("discarded"); }
    else throw new Error(`unknown command: ${command}`);
  } finally {
    runtime?.ledger.close();
    lock?.release();
  }
}

async function run(supervisor: ReturnType<typeof createRuntime>["supervisor"], signal: AbortSignal): Promise<void> {
  const { runSupervisorDaemon } = await import("@goah/supervisor");
  await runSupervisorDaemon(supervisor, { signal });
}
function printHelp(): void {
  console.log(`goah init [--provider anthropic|openai|ark-coding|faux] [--model ID]
goah doctor
goah goal-create --id ID --owner AGENT --objective TEXT [--wake-now]
goah wake AGENT [--reason TEXT]
goah run-once
goah start | status | goal-list | action-list | approve | reject | dashboard
goah workspace-inspect | workspace-recover | workspace-discard`);
}
function option(name: string): string | null { const index = args.indexOf(name); return index >= 0 ? args[index + 1] ?? null : null; }
function flag(name: string): boolean { return args.includes(name); }
function required(name: string): string { const value = option(name); if (!value) throw new Error(`${name} is required`); return value; }
function numberOption(name: string): number { const value = Number(required(name)); if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`); return value; }
function requiredPositional(index: number, label: string): string { const value = args[index]; if (!value || value.startsWith("--")) throw new Error(`${label} is required`); return value; }
function evidence(): number[] { return required("--evidence").split(",").map(Number); }
function providerOption(value: string): PiProvider {
  if (!["anthropic", "openai", "ark-coding", "faux"].includes(value)) throw new Error(`unsupported provider: ${value}`);
  return value as PiProvider;
}
function mutates(command: string): boolean { return ["start", "run-once", "wake", "goal-create", "approve", "reject", "workspace-recover", "workspace-discard"].includes(command); }
