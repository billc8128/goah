import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, Type, type Message } from "@earendil-works/pi-ai";
import type { AgentCapability, JsonValue, RunnerResult, WakeOutput } from "@goah/ledger-contract";
import { runProcessWorker, type WorkerRpc } from "./index.js";
import { createPiModel, providerApiKey } from "./model-provider.js";

const execFileAsync = promisify(execFile);

export function compactMessages(messages: AgentMessage[], maxRecent = 8): AgentMessage[] {
  if (messages.length <= maxRecent + 1) return messages;
  const removed = messages.slice(1, -maxRecent);
  const summary = removed.map((message, index) => `${index + 1}. ${messageText(message).slice(0, 240)}`).join("\n");
  return [
    messages[0]!,
    { role: "user", content: `Compacted model view. Original trace is unchanged. Source message indexes 1-${removed.length}:\n${summary}`, timestamp: Date.now() },
    ...messages.slice(-maxRecent),
  ];
}

export async function runPiWorker(): Promise<void> {
  await runProcessWorker(async (request, emit, rpc): Promise<RunnerResult> => {
    const provider = process.env.GOAH_PI_PROVIDER ?? "anthropic";
    const modelId = process.env.GOAH_PI_MODEL;
    if (!modelId) throw new Error("GOAH_PI_MODEL is required");
    const configured = createPiModel(provider, modelId);
    const { models, model } = configured;
    if (provider === "faux") {
      const faux = configured.faux!;
      const handoff = JSON.parse(process.env.GOAH_PI_FAUX_HANDOFF ?? "{}") as Record<string, unknown>;
      faux.setResponses([fauxAssistantMessage(fauxToolCall("handoff", handoff), { stopReason: "toolUse" })]);
    }

    let output: WakeOutput | null = null;
    let tokensUsed = 0;
    let compactions = 0;
    const workspace = request.workspacePath ? resolve(request.workspacePath) : undefined;
    const tools = createTools(workspace, (value) => { output = value; }, process.env.GOAH_PI_ALLOW_BASH === "true", rpc, request.wake.startedAt);
    const contextPolicy = resolveContextPolicy(model.contextWindow, process.env);
    emit({ kind: "model.capabilities", data: { provider, model: modelId, contextWindowTokens: model.contextWindow, maxOutputTokensPerTurn: model.maxTokens, ...contextPolicy } });
    const suppliedPrompt = typeof request.context === "object" && request.context !== null && !Array.isArray(request.context) && typeof request.context.systemPrompt === "string" ? request.context.systemPrompt : undefined;
    const agent = new Agent({
      initialState: {
        systemPrompt: `${process.env.GOAH_PI_SYSTEM_PROMPT ?? suppliedPrompt ?? "You are a goal-oriented worker."}\nYou must finish by calling handoff exactly once. Treat the supplied context as authoritative.`,
        model,
        tools,
      },
      streamFn: models.streamSimple.bind(models),
      getApiKey: (id) => providerApiKey(id),
      transformContext: async (messages) => {
        let view = messages;
        if (estimateMessages(messages) >= contextPolicy.compactAtTokens) {
          compactions += 1;
          emit({ kind: "context.compacted", data: { compaction: compactions, sourceMessageCount: messages.length } });
          view = compactMessagesToTokenBudget(messages, contextPolicy.retainAfterCompactTokens);
        }
        if (tokensUsed < request.limits.maxTotalTokens - request.limits.handoffReserveTokens) return view;
        return [...view, {
          role: "user",
          content: "Handoff reserve is active. Do not call any other tool. Call handoff now with the best verified state available.",
          timestamp: Date.now(),
        }];
      },
      beforeToolCall: async ({ toolCall }) => {
        const reserve = tokensUsed >= request.limits.maxTotalTokens - request.limits.handoffReserveTokens;
        if (reserve && toolCall.name !== "handoff") return { block: true, reason: "handoff reserve active; only handoff is allowed" };
        return undefined;
      },
      shouldStopAfterTurn: () => output !== null || tokensUsed >= request.limits.maxTotalTokens,
      toolExecution: "sequential",
    });
    agent.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") tokensUsed += event.message.usage.totalTokens;
      emit({ kind: `pi.${event.type}`, data: JSON.parse(JSON.stringify(event)) as JsonValue });
    });
    await agent.prompt(`Wake started at: ${request.wake.startedAt ?? "unknown"}\nWake context:\n${JSON.stringify(request.context)}\n\nWork in: ${workspace ?? "no workspace"}`);
    if (!output) return { outcome: "abnormal", reason: "Pi worker exited without a valid handoff", tokensUsed };
    return { outcome: "handoff", output, tokensUsed };
  });
}

function createTools(workspace: string | undefined, handoff: (output: WakeOutput) => void, allowBash: boolean, rpc: WorkerRpc, wakeStartedAt: string | null): AgentTool<any>[] {
  const handoffTool: AgentTool<any> = {
    name: "handoff",
    label: "Handoff",
    description: "Record a structured handoff and end the wake.",
    parameters: Type.Object({
      observations: Type.Array(Type.String()),
      results: Type.Array(Type.String()),
      nextSteps: Type.Array(Type.String()),
      blocker: Type.Optional(Type.String()),
      nextWakeAt: Type.Optional(Type.String()),
    }),
    execute: async (_id, params) => {
      const input = params as { observations: string[]; results: string[]; nextSteps: string[]; blocker?: string; nextWakeAt?: string };
      const value: WakeOutput = { handoff: { observations: input.observations, results: input.results, nextSteps: input.nextSteps, ...(input.blocker ? { blocker: input.blocker } : {}) }, mail: [], nextWakeAt: validateNextWakeAt(input.nextWakeAt, wakeStartedAt) };
      handoff(value);
      return { content: [{ type: "text", text: "handoff recorded" }], details: value, terminate: true };
    },
  };
  const rpcTools = createRpcTools(rpc);
  if (!workspace) return [...rpcTools, handoffTool];
  const readTool: AgentTool<any> = {
    name: "read_file", label: "Read file", description: "Read a UTF-8 file inside the wake workspace.",
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id, params) => { const input = params as { path: string }; return { content: [{ type: "text", text: await readFile(scoped(workspace, input.path), "utf8") }], details: {} }; },
  };
  const writeTool: AgentTool<any> = {
    name: "write_file", label: "Write file", description: "Write a UTF-8 file inside the wake workspace.",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    execute: async (_id, params) => { const input = params as { path: string; content: string }; const path = scoped(workspace, input.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, input.content); return { content: [{ type: "text", text: "written" }], details: {} }; },
  };
  const noteTool: AgentTool<any> = {
    name: "record_note", label: "Record note", description: "Append a durable workspace note. The tool result is also indexed in the ledger trace.",
    parameters: Type.Object({ note: Type.String() }),
    execute: async (_id, params) => { const input = params as { note: string }; await appendFile(scoped(workspace, ".goah-notes.md"), `${input.note}\n`); return { content: [{ type: "text", text: "note recorded" }], details: { note: input.note } }; },
  };
  if (!allowBash) return [readTool, writeTool, noteTool, ...rpcTools, handoffTool];
  const bashTool: AgentTool<any> = {
    name: "bash", label: "Bash", description: "Run a shell command in the wake workspace.",
    parameters: Type.Object({ command: Type.String() }), executionMode: "sequential",
    execute: async (_id, params, signal) => {
      const input = params as { command: string };
      const result = await execFileAsync("/bin/sh", ["-lc", input.command], { cwd: workspace, signal, maxBuffer: 1_000_000 });
      return { content: [{ type: "text", text: `${result.stdout}${result.stderr}`.slice(-50_000) }], details: { command: input.command } };
    },
  };
  return [readTool, writeTool, noteTool, bashTool, ...rpcTools, handoffTool];
}

export function validateNextWakeAt(value: string | undefined, wakeStartedAt: string | null): string | null {
  if (value === undefined) return null;
  const next = Date.parse(value);
  const started = wakeStartedAt === null ? Number.NaN : Date.parse(wakeStartedAt);
  if (!Number.isFinite(next) || !Number.isFinite(started) || next <= started) throw new Error("nextWakeAt must be a valid time later than the current wake start");
  return new Date(next).toISOString();
}

export interface ContextPolicy {
  compactAtTokens: number;
  retainAfterCompactTokens: number;
}

export function resolveContextPolicy(contextWindowTokens: number, env: NodeJS.ProcessEnv): ContextPolicy {
  if (!Number.isInteger(contextWindowTokens) || contextWindowTokens <= 0) throw new Error("model context window is missing");
  const compactAtTokens = integerSetting(env.GOAH_PI_COMPACT_AT_TOKENS, Math.floor(contextWindowTokens * 0.7));
  const retainAfterCompactTokens = integerSetting(env.GOAH_PI_RETAIN_CONTEXT_TOKENS, Math.floor(contextWindowTokens * 0.2));
  if (retainAfterCompactTokens >= compactAtTokens || compactAtTokens >= contextWindowTokens) throw new Error("invalid Pi context policy");
  return { compactAtTokens, retainAfterCompactTokens };
}

export function compactMessagesToTokenBudget(messages: AgentMessage[], retainTokens: number): AgentMessage[] {
  if (messages.length <= 2 || estimateMessages(messages) <= retainTokens) return messages;
  const tailBudget = Math.max(1, Math.floor(retainTokens * 0.6));
  let start = messages.length;
  let retained = 0;
  while (start > 1) {
    const tokens = estimateMessages([messages[start - 1]!]);
    if (retained > 0 && retained + tokens > tailBudget) break;
    retained += tokens;
    start -= 1;
  }
  const removed = messages.slice(1, start);
  const rawSummary = removed.map((message, index) => `${index + 1}. ${messageText(message).slice(0, 240)}`).join("\n");
  const summaryChars = Math.max(0, (retainTokens - retained - 80) * 4);
  const summary = summaryChars === 0 ? "[older entries truncated]"
    : rawSummary.length <= summaryChars ? rawSummary : `[older entries truncated]\n${rawSummary.slice(-summaryChars)}`;
  return [
    messages[0]!,
    { role: "user", content: `Compacted model view. Original trace is unchanged. Source message indexes 1-${removed.length}:\n${summary}`, timestamp: Date.now() },
    ...messages.slice(start),
  ];
}

function createRpcTools(rpc: WorkerRpc): AgentTool<any>[] {
  const tool = (name: string, description: string, method: AgentCapability, parameters: ReturnType<typeof Type.Object>): AgentTool<any> => ({
    name, label: name, description, parameters,
    execute: async (_id, params) => { const result = await rpc(method, params as JsonValue); return { content: [{ type: "text", text: JSON.stringify(result) }], details: result }; },
  });
  return [
    tool("ledger_search", "Search durable ledger facts.", "ledger.search", Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) })),
    tool("budget_status", "Read the current goal budget exposure.", "budget.read", Type.Object({})),
    tool("send_mail", "Send a durable message to another agent or human.", "mail.send", Type.Object({ to: Type.String(), level: Type.Union([Type.Literal("fyi"), Type.Literal("decision"), Type.Literal("emergency")]), body: Type.Any() })),
    tool("schedule_wake", "Schedule this agent's next wake.", "schedule.set", Type.Object({ at: Type.String(), reason: Type.String() })),
    tool("submit_action", "Submit a gated external action with evidence.", "action.submit", Type.Object({ id: Type.String(), kind: Type.String(), connector: Type.String(), payload: Type.Any(), reason: Type.String(), evidence: Type.Array(Type.Number()) })),
    tool("ack_audit_advice", "Acknowledge audit advice after incorporating it.", "audit.ack", Type.Object({ actionId: Type.String() })),
    tool("write_audit_advice", "Write audit advice for an action.", "audit.write", Type.Object({ actionId: Type.String(), body: Type.Any(), evidence: Type.Array(Type.Number()) })),
    tool("put_goal", "Create or update a goal using parent-layer authority.", "goal.put", Type.Object({ goal: Type.Any() })),
  ];
}

function scoped(workspace: string, path: string): string {
  const resolved = resolve(workspace, path);
  if (resolved !== workspace && !resolved.startsWith(`${workspace}${sep}`)) throw new Error("path escapes workspace");
  return resolved;
}
function estimateMessages(messages: AgentMessage[]): number { return Math.ceil(JSON.stringify(messages).length / 4); }
function integerSetting(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("Pi token settings must be positive integers");
  return parsed;
}
function messageText(message: AgentMessage): string {
  const value = message as Message;
  if (value.role === "user") return typeof value.content === "string" ? value.content : value.content.map((item) => item.type === "text" ? item.text : "[image]").join(" ");
  if (value.role === "assistant") return value.content.map((item) => item.type === "text" ? item.text : item.type === "thinking" ? item.thinking : `[tool:${item.name}]`).join(" ");
  return value.content.map((item) => item.type === "text" ? item.text : "[image]").join(" ");
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await runPiWorker();
