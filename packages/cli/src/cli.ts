#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { JsonValue } from "goah-ledger-contract";
import { controlAvailable, createRuntime, diagnoseConfig, exportSession, listSessions, loadConfig, replayWakeSession, requestControl, runControlServer, showSession, showSessionContext, statusSnapshot, streamControl, streamEvents, SupervisorLock, type ControlFrame, type ControlRequest, type PiProvider, writeDefaultConfig } from "./index.js";

const args = normalizeArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const rawCommand = args[0];
  const interactive = rawCommand === undefined || rawCommand === "--continue" || Boolean(rawCommand && !rawCommand.startsWith("-") && !knownCommand(rawCommand));
  const command = interactive ? "interactive" : rawCommand!;
  const initialMessage = interactive && rawCommand && rawCommand !== "--continue" ? rawCommand : null;
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

  if (command === "interactive") { await runInteractive(configPath, config.stateDir, initialMessage); return; }
  if (command !== "start" && await controlAvailable(config.stateDir)) {
    const request = remoteRequest(command);
    if (request) { console.log(JSON.stringify(await requestControl(config.stateDir, request), null, 2)); return; }
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
      await Promise.all([run(supervisor, controller.signal), runControlServer(supervisor, ledger, config.stateDir, controller.signal)]);
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
      const parentId = option("--parent");
      const goal = { id, parentId, objective, observationMethod: option("--observation-method"), owner, phase: "active" as const, revision: 0 };
      supervisor.createGoal(goal, option("--actor") ?? "human");
      const wake = flag("--wake-now") ? supervisor.planWake(owner, new Date().toISOString(), `goal:${id}`, "supervisor") : null;
      console.log(JSON.stringify({ goal, wake }, null, 2));
    } else if (command === "goal-update") {
      const objective = option("--objective"); const observationMethod = option("--observation-method"); const owner = option("--owner");
      const goal = supervisor.updateGoal(requiredPositional(1, "goal id"), { ...(objective ? { objective } : {}), ...(observationMethod ? { observationMethod } : {}), ...(owner ? { owner } : {}) }, option("--actor") ?? "human");
      console.log(JSON.stringify({ goal }, null, 2));
    } else if (["goal-pause", "goal-resume", "goal-complete"].includes(command)) {
      const id = requiredPositional(1, "goal id");
      const goal = command === "goal-complete"
        ? supervisor.completeGoal({ goalId: id, revision: ledger.goal(id)?.revision ?? -1, reason: required("--reason"), evidence: evidence() }, option("--actor") ?? "human")
        : supervisor.transitionGoal(id, command === "goal-pause" ? "paused" : "active", option("--actor") ?? "human");
      console.log(JSON.stringify({ goal }, null, 2));
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

async function runInteractive(configPath: string, stateDir: string, initialMessage: string | null): Promise<void> {
  await ensureDaemon(configPath, stateDir);
  const interact = async (message: string) => {
    await streamControl(stateDir, { op: "interact", message }, (frame) => renderFrame(frame));
  };
  if (initialMessage) { await interact(initialMessage); return; }
  console.log("Goah CEO — type a goal or message. /goal revises the root, /observe confirms its observation method, /status inspects, /quit exits.");
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const line = (await input.question("> ")).trim();
      if (!line) continue;
      if (line === "/quit" || line === "/exit") return;
      if (line === "/status") { console.log(JSON.stringify(await requestControl(stateDir, { op: "ceo.status" }), null, 2)); continue; }
      if (line.startsWith("/goal ")) {
        const status = asRecord(await requestControl(stateDir, { op: "ceo.status" }));
        const root = firstRecord(status.roots);
        if (!root) throw new Error("no active root goal");
        console.log(JSON.stringify(await requestControl(stateDir, { op: "goal.update", id: String(root.id), objective: line.slice(6).trim() }), null, 2));
        continue;
      }
      if (line.startsWith("/observe ")) {
        const status = asRecord(await requestControl(stateDir, { op: "ceo.status" }));
        const root = firstRecord(status.roots);
        if (!root) throw new Error("no active root goal");
        console.log(JSON.stringify(await requestControl(stateDir, { op: "goal.observe", id: String(root.id), observationMethod: line.slice(9).trim() }), null, 2));
        continue;
      }
      await interact(line);
    }
  } finally { input.close(); }
}

async function ensureDaemon(configPath: string, stateDir: string): Promise<void> {
  if (await controlAvailable(stateDir)) return;
  const child = spawn(process.execPath, [process.argv[1]!, "start", "--config", resolve(configPath)], { cwd: process.cwd(), detached: true, stdio: "ignore", env: process.env });
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await controlAvailable(stateDir)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Goah Supervisor did not start; run `goah doctor` and inspect the configured provider credentials");
}

function renderFrame(frame: ControlFrame): void {
  if (frame.type === "error") throw new Error(frame.error);
  if (frame.type === "accepted") { console.log(`[ceo wake ${frame.wakeId}]`); return; }
  if (frame.type !== "event") return;
  const event = asRecord(frame.event);
  if (event.type === "tool.called") {
    const data = asRecord(event.data ?? null);
    console.log(`→ ${String(data.name)} ${JSON.stringify(data.arguments ?? {})}`);
  } else if (event.type === "message.assistant.completed") {
    const data = asRecord(event.data ?? null); const message = asRecord(data.message ?? null);
    const text = messageText(message.content);
    if (text) console.log(text);
  } else if (event.type === "handoff.recorded") {
    const handoff = asRecord(event.data ?? null);
    for (const result of Array.isArray(handoff.results) ? handoff.results : []) if (typeof result === "string") console.log(result);
    if (typeof handoff.blocker === "string") console.log(`Blocked: ${handoff.blocker}`);
  } else if (event.type === "wake.abnormal_reason") console.log(`! ${JSON.stringify(event.data)}`);
}

function remoteRequest(command: string): ControlRequest | null {
  if (command === "status") return { op: "status" };
  if (command === "goal-start") return { op: "goal.start", objective: required("--objective"), ...(option("--id") ? { id: option("--id")! } : {}) };
  if (command === "goal-update") return { op: "goal.update", id: requiredPositional(1, "goal id"), ...(option("--objective") ? { objective: option("--objective")! } : {}), ...(option("--observation-method") ? { observationMethod: option("--observation-method")! } : {}), ...(option("--owner") ? { owner: option("--owner")! } : {}) };
  if (command === "goal-pause" || command === "goal-resume") return { op: "goal.transition", id: requiredPositional(1, "goal id"), phase: command === "goal-pause" ? "paused" : "active" };
  if (command === "goal-complete") return { op: "goal.complete", id: requiredPositional(1, "goal id"), reason: required("--reason"), evidence: evidence() };
  if (command === "ceo-send") return { op: "ceo.send", message: required("--message") };
  if (command === "ceo-status") return { op: "ceo.status" };
  if (command === "ceo-inbox") return { op: "ceo.inbox" };
  if (command === "approve" || command === "ceo-approve") return { op: "action.approve", id: requiredPositional(1, "action id"), reason: required("--reason"), evidence: evidence() };
  if (command === "reject") return { op: "action.reject", id: requiredPositional(1, "action id"), reason: required("--reason"), evidence: evidence() };
  return null;
}

function printHelp(): void {
  console.log(`goah ["OBJECTIVE"] | goah --continue
goah init [--provider anthropic|openai|ark-coding|faux] [--model ID]
goah doctor
goah goal start --objective TEXT [--id ID]
goah ceo send --message TEXT
goah ceo status | ceo inbox
goah ceo approve ACTION_ID --reason TEXT --evidence SEQ[,SEQ]
goah goal-create --id ID --owner AGENT --objective TEXT [--observation-method TEXT] [--wake-now]
goah goal-show ID | goal-list
goah goal-update ID [--objective TEXT] [--observation-method TEXT] [--owner AGENT] [--actor ACTOR]
goah goal-pause|goal-resume ID [--actor ACTOR]
goah goal-complete ID --reason TEXT --evidence SEQ[,SEQ] [--actor ACTOR]
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
function knownCommand(value: string): boolean { return ["help", "init", "doctor", "start", "run-once", "wake", "status", "session", "context", "events", "goal-list", "goal-show", "goal-create", "goal-update", "goal-pause", "goal-resume", "goal-complete", "goal-start", "ceo-send", "ceo-status", "ceo-inbox", "ceo-approve", "action-list", "approve", "reject", "dashboard"].includes(value); }
function asRecord(value: JsonValue): Record<string, JsonValue> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object"); return value; }
function firstRecord(value: JsonValue | undefined): Record<string, JsonValue> | null { return Array.isArray(value) && value[0] && typeof value[0] === "object" && !Array.isArray(value[0]) ? value[0] : null; }
function messageText(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => item && typeof item === "object" && !Array.isArray(item) && item.type === "text" && typeof item.text === "string" ? item.text : "").filter(Boolean).join("\n");
}
