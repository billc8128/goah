#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRuntime, diagnoseConfig, exportSession, listSessions, loadConfig, replayWakeSession, showSession, showSessionContext, statusSnapshot, streamEvents, SupervisorLock, type PiProvider, writeDefaultConfig } from "./index.js";

const args = normalizeArgs(process.argv.slice(2));

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

  const config = loadConfig(configPath, { resolveSecrets: ["start", "run-once", "approve", "ceo-approve"].includes(command) });
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
    } else if (command === "goal-start") {
      console.log(JSON.stringify(supervisor.startGoal(required("--objective"), option("--id") ?? undefined), null, 2));
    } else if (command === "ceo-send") {
      console.log(JSON.stringify(supervisor.sendToCeo({ message: required("--message") }, "decision"), null, 2));
    } else if (command === "ceo-status") {
      console.log(JSON.stringify({
        roots: ledger.goals().filter((goal) => goal.parentId === null && goal.owner === "ceo"),
        team: supervisor.teamList(),
        pendingHuman: ledger.unreadMail("human"),
        recentCeoHandoffs: ledger.eventsSince(0, ["handoff.recorded"]).filter((event) => event.actor === "ceo").slice(-10),
      }, null, 2));
    } else if (command === "ceo-inbox") {
      console.log(JSON.stringify(ledger.unreadMail("human"), null, 2));
    } else if (command === "session") {
      const subcommand = requiredPositional(1, "session command");
      if (subcommand === "list") console.log(JSON.stringify(listSessions(ledger), null, 2));
      else {
        const wakeId = requiredPositional(2, "wake id");
        if (subcommand === "show") console.log(JSON.stringify(showSession(ledger, wakeId), null, 2));
        else if (subcommand === "replay") console.log(JSON.stringify(replayWakeSession(ledger, wakeId), null, 2));
        else if (subcommand === "export") {
          const output = option("--output") ?? `${wakeId}.session.json`;
          writeFileSync(output, `${JSON.stringify(exportSession(ledger, wakeId, { raw: flag("--raw") }), null, 2)}\n`);
          console.log(JSON.stringify({ output, redacted: !flag("--raw") }, null, 2));
        } else throw new Error(`unknown session command: ${subcommand}`);
      }
    } else if (command === "context") {
      if (requiredPositional(1, "context command") !== "show") throw new Error("unknown context command");
      console.log(JSON.stringify(showSessionContext(ledger, requiredPositional(2, "wake id")), null, 2));
    } else if (command === "events") {
      console.log(JSON.stringify(streamEvents(ledger, required("--stream"), option("--from") ? numberOption("--from") : 1), null, 2));
    } else if (command === "goal-list") console.log(JSON.stringify(ledger.goals(), null, 2));
    else if (command === "goal-show") {
      const goal = ledger.goal(requiredPositional(1, "goal id"));
      if (!goal) throw new Error("goal not found");
      console.log(JSON.stringify({ goal }, null, 2));
    }
    else if (command === "goal-create") {
      const id = required("--id"); const owner = required("--owner"); const objective = required("--objective");
      const goal = { id, parentId: option("--parent"), objective, owner, phase: "active" as const, revision: 0 };
      supervisor.createGoal(goal, option("--actor") ?? "human");
      const wake = flag("--wake-now") ? supervisor.planWake(owner, new Date().toISOString(), `goal:${id}`, "supervisor") : null;
      console.log(JSON.stringify({ goal, wake }, null, 2));
    } else if (command === "goal-update") {
      const objective = option("--objective"); const owner = option("--owner");
      const goal = supervisor.updateGoal(requiredPositional(1, "goal id"), { ...(objective ? { objective } : {}), ...(owner ? { owner } : {}) }, option("--actor") ?? "human");
      console.log(JSON.stringify({ goal }, null, 2));
    } else if (["goal-pause", "goal-resume", "goal-complete"].includes(command)) {
      const phase = command === "goal-pause" ? "paused" : command === "goal-resume" ? "active" : "complete";
      console.log(JSON.stringify({ goal: supervisor.transitionGoal(requiredPositional(1, "goal id"), phase, option("--actor") ?? "human") }, null, 2));
    } else if (command === "action-list") console.log(JSON.stringify(ledger.actions(), null, 2));
    else if (command === "approve" || command === "ceo-approve") console.log(JSON.stringify(await supervisor.approveAction(requiredPositional(1, "action id"), option("--actor") ?? "human", required("--reason"), evidence()), null, 2));
    else if (command === "reject") console.log(JSON.stringify(supervisor.rejectAction(requiredPositional(1, "action id"), option("--actor") ?? "human", required("--reason"), evidence()), null, 2));
    else if (command === "dashboard") { const path = option("--output") ?? join(config.stateDir, "status.html"); writeFileSync(path, (await import("goah-supervisor")).renderDashboard(ledger)); console.log(path); }
    else throw new Error(`unknown command: ${command}`);
  } finally {
    runtime?.ledger.close();
    lock?.release();
  }
}

async function run(supervisor: ReturnType<typeof createRuntime>["supervisor"], signal: AbortSignal): Promise<void> {
  const { runSupervisorDaemon } = await import("goah-supervisor");
  await runSupervisorDaemon(supervisor, { signal });
}
function printHelp(): void {
  console.log(`goah init [--provider anthropic|openai|ark-coding|faux] [--model ID]
goah doctor
goah goal start --objective TEXT [--id ID]
goah ceo send --message TEXT
goah ceo status | ceo inbox
goah ceo approve ACTION_ID --reason TEXT --evidence SEQ[,SEQ]
goah goal-create --id ID --owner AGENT --objective TEXT [--wake-now]
goah goal-show ID | goal-list
goah goal-update ID [--objective TEXT] [--owner AGENT] [--actor ACTOR]
goah goal-pause|goal-resume|goal-complete ID [--actor ACTOR]
goah wake AGENT [--reason TEXT]
goah run-once
goah session list
goah session show|replay|export WAKE_ID [--output FILE] [--raw]
goah context show WAKE_ID
goah events --stream STREAM_ID [--from N]
goah start | status | goal-list | action-list | approve | reject | dashboard
Runner file and Git operations execute locally under the directory containing goah.config.json.`);
}
function option(name: string): string | null { const index = args.indexOf(name); return index >= 0 ? args[index + 1] ?? null : null; }
function flag(name: string): boolean { return args.includes(name); }
function required(name: string): string { const value = option(name); if (!value) throw new Error(`${name} is required`); return value; }
function numberOption(name: string): number { const value = Number(required(name)); if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`); return value; }
function requiredPositional(index: number, label: string): string {
  const positional: string[] = [];
  const flags = new Set(["--wake-now", "--raw"]);
  for (let cursor = 0; cursor < args.length; cursor += 1) {
    const value = args[cursor]!;
    if (!value.startsWith("--")) { positional.push(value); continue; }
    if (!flags.has(value)) cursor += 1;
  }
  const value = positional[index];
  if (!value) throw new Error(`${label} is required`);
  return value;
}
function evidence(): number[] { return required("--evidence").split(",").map(Number); }
function providerOption(value: string): PiProvider {
  if (!["anthropic", "openai", "ark-coding", "faux"].includes(value)) throw new Error(`unsupported provider: ${value}`);
  return value as PiProvider;
}
function mutates(command: string): boolean { return ["start", "run-once", "wake", "goal-start", "ceo-send", "ceo-approve", "goal-create", "goal-update", "goal-pause", "goal-resume", "goal-complete", "approve", "reject"].includes(command); }
function normalizeArgs(values: string[]): string[] {
  if ((values[0] === "goal" || values[0] === "ceo") && values[1] && !values[1].startsWith("--")) return [`${values[0]}-${values[1]}`, ...values.slice(2)];
  return values;
}
