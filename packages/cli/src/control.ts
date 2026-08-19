import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import type { JsonValue, Ledger } from "goah-ledger-contract";
import type { Supervisor } from "goah-supervisor";

export type ControlRequest =
  | { op: "ping" }
  | { op: "status" }
  | { op: "interact"; message: string }
  | { op: "goal.start"; objective: string; id?: string }
  | { op: "goal.update"; id: string; objective?: string; observationMethod?: string | null; owner?: string }
  | { op: "goal.observe"; id: string; observationMethod: string }
  | { op: "goal.transition"; id: string; phase: "paused" | "active" }
  | { op: "goal.complete"; id: string; reason: string; evidence: number[] }
  | { op: "ceo.send"; message: string }
  | { op: "ceo.status" }
  | { op: "ceo.inbox" }
  | { op: "action.approve"; id: string; reason: string; evidence: number[] }
  | { op: "action.reject"; id: string; reason: string; evidence: number[] };

export type ControlFrame =
  | { type: "result"; value: JsonValue }
  | { type: "accepted"; wakeId: string; value: JsonValue }
  | { type: "event"; event: JsonValue }
  | { type: "error"; error: string };

export function controlEndpoint(stateDir: string): string {
  if (process.platform !== "win32") return join(stateDir, "control.sock");
  return `\\\\.\\pipe\\goah-${createHash("sha256").update(stateDir).digest("hex").slice(0, 16)}`;
}

export async function runControlServer(supervisor: Supervisor, ledger: Ledger, stateDir: string, signal: AbortSignal): Promise<void> {
  mkdirSync(stateDir, { recursive: true });
  const endpoint = controlEndpoint(stateDir);
  if (process.platform !== "win32" && existsSync(endpoint)) rmSync(endpoint);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => { sockets.add(socket); socket.on("error", () => undefined); socket.once("close", () => sockets.delete(socket)); void serve(socket, supervisor, ledger); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  if (process.platform !== "win32") chmodSync(endpoint, 0o600);
  await new Promise<void>((resolve) => {
    const stop = () => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); };
    if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
  });
  if (process.platform !== "win32" && existsSync(endpoint)) rmSync(endpoint);
}

export async function requestControl(stateDir: string, request: ControlRequest): Promise<JsonValue> {
  let result: JsonValue | undefined;
  await streamControl(stateDir, request, (frame) => {
    if (frame.type === "error") throw new Error(frame.error);
    if (frame.type === "result") result = frame.value;
  });
  if (result === undefined) throw new Error("control request ended without a result");
  return result;
}

export async function streamControl(stateDir: string, request: ControlRequest, onFrame: (frame: ControlFrame) => void): Promise<void> {
  const socket = createConnection(controlEndpoint(stateDir));
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.write(`${JSON.stringify(request)}\n`);
  let buffer = "";
  await new Promise<void>((resolve, reject) => {
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line) continue;
        try { onFrame(JSON.parse(line) as ControlFrame); } catch (error) { reject(error); socket.destroy(); }
      }
    });
    socket.once("end", resolve);
    socket.once("error", reject);
  });
}

export async function controlAvailable(stateDir: string): Promise<boolean> {
  try { return (await requestControl(stateDir, { op: "ping" })) === "pong"; } catch { return false; }
}

async function serve(socket: Socket, supervisor: Supervisor, ledger: Ledger): Promise<void> {
  let buffer = "";
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const index = buffer.indexOf("\n");
    if (index < 0) return;
    socket.removeAllListeners("data");
    const line = buffer.slice(0, index);
    let request: ControlRequest;
    try { request = JSON.parse(line) as ControlRequest; }
    catch (error) { write(socket, { type: "error", error: error instanceof Error ? error.message : String(error) }); socket.end(); return; }
    void dispatch(request, socket, supervisor, ledger).catch((error) => {
      write(socket, { type: "error", error: error instanceof Error ? error.message : String(error) });
      socket.end();
    });
  });
}

async function dispatch(request: ControlRequest, socket: Socket, supervisor: Supervisor, ledger: Ledger): Promise<void> {
  if (request.op === "interact") { await interact(request.message, socket, supervisor, ledger); return; }
  let value: unknown;
  if (request.op === "ping") value = "pong";
  else if (request.op === "status") value = snapshot(ledger, supervisor);
  else if (request.op === "goal.start") value = supervisor.startGoal(request.objective, request.id);
  else if (request.op === "goal.update") value = supervisor.updateGoal(request.id, { ...(request.objective !== undefined ? { objective: request.objective } : {}), ...(request.observationMethod !== undefined ? { observationMethod: request.observationMethod } : {}), ...(request.owner !== undefined ? { owner: request.owner } : {}) }, "human");
  else if (request.op === "goal.observe") value = supervisor.confirmObservationMethod(request.id, request.observationMethod);
  else if (request.op === "goal.transition") value = supervisor.transitionGoal(request.id, request.phase, "human");
  else if (request.op === "goal.complete") value = supervisor.completeGoal({ goalId: request.id, revision: requiredGoal(ledger, request.id).revision, reason: request.reason, evidence: request.evidence }, "human");
  else if (request.op === "ceo.send") value = supervisor.sendToCeo({ message: request.message });
  else if (request.op === "ceo.status") value = ceoStatus(ledger, supervisor);
  else if (request.op === "ceo.inbox") value = ledger.unreadMail("human");
  else if (request.op === "action.approve") value = await supervisor.approveAction(request.id, "human", request.reason, request.evidence);
  else value = supervisor.rejectAction(request.id, "human", request.reason, request.evidence);
  write(socket, { type: "result", value: value as JsonValue });
  socket.end();
}

async function interact(message: string, socket: Socket, supervisor: Supervisor, ledger: Ledger): Promise<void> {
  if (!message.trim()) throw new Error("message is required");
  const root = ledger.goals().find((goal) => goal.parentId === null && goal.owner === "ceo" && goal.phase !== "complete");
  const accepted = root ? supervisor.sendToCeo({ message }) : supervisor.startGoal(message);
  write(socket, { type: "accepted", wakeId: accepted.wake.id, value: accepted as unknown as JsonValue });
  let lastSeq = 0;
  while (true) {
    if (socket.destroyed) return;
    for (const event of ledger.eventsForWake(accepted.wake.id)) {
      if (event.seq <= lastSeq) continue;
      lastSeq = event.seq;
      if (event.type.startsWith("message.assistant") || event.type.startsWith("tool.") || event.type.startsWith("rpc.") || event.type === "handoff.recorded" || event.type.startsWith("wake.")) write(socket, { type: "event", event: event as unknown as JsonValue });
    }
    const wake = ledger.wake(accepted.wake.id);
    if (wake && ["done", "abnormal", "merge_blocked"].includes(wake.status)) {
      write(socket, { type: "result", value: { wake, handoff: ledger.lastEvent("ceo", "handoff.recorded") } as unknown as JsonValue });
      socket.end(); return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function snapshot(ledger: Ledger, supervisor: Supervisor): JsonValue {
  return { seq: ledger.events().at(-1)?.seq ?? 0, goals: ledger.goals(), team: supervisor.teamList(), wakes: ledger.wakes(), actions: ledger.actions() } as unknown as JsonValue;
}
function ceoStatus(ledger: Ledger, supervisor: Supervisor): JsonValue {
  return { roots: ledger.goals().filter((goal) => goal.parentId === null && goal.owner === "ceo"), team: supervisor.teamList(), pendingHuman: ledger.unreadMail("human"), recentCeoHandoffs: ledger.eventsSince(0, ["handoff.recorded"]).filter((event) => event.actor === "ceo").slice(-10) } as unknown as JsonValue;
}
function requiredGoal(ledger: Ledger, id: string) { const goal = ledger.goal(id); if (!goal) throw new Error("goal not found"); return goal; }
function write(socket: Socket, frame: ControlFrame): void { socket.write(`${JSON.stringify(frame)}\n`); }
