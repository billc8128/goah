import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type, type Message, type Model, type Api } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { JsonValue, RunnerResult, WakeOutput } from "@goah/ledger-contract";
import { runProcessWorker } from "./index.js";

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
  await runProcessWorker(async (request, emit): Promise<RunnerResult> => {
    const provider = process.env.GOAH_PI_PROVIDER ?? "anthropic";
    const modelId = process.env.GOAH_PI_MODEL;
    if (!modelId) throw new Error("GOAH_PI_MODEL is required");
    const models = createModels();
    let model: Model<Api> | undefined;
    if (provider === "anthropic") { models.setProvider(anthropicProvider()); model = models.getModel(provider, modelId); }
    else if (provider === "openai") { models.setProvider(openaiProvider()); model = models.getModel(provider, modelId); }
    else if (provider === "faux") {
      const faux = fauxProvider({ provider: "faux", models: [{ id: modelId }] });
      const handoff = JSON.parse(process.env.GOAH_PI_FAUX_HANDOFF ?? "{}") as Record<string, unknown>;
      faux.setResponses([fauxAssistantMessage(fauxToolCall("handoff", handoff), { stopReason: "toolUse" })]);
      models.setProvider(faux.provider);
      model = faux.getModel() as Model<Api>;
    } else throw new Error(`unsupported GOAH Pi provider: ${provider}`);
    if (!model) throw new Error(`Pi model not found: ${provider}/${modelId}`);

    let output: WakeOutput | null = null;
    let tokensUsed = 0;
    let compactions = 0;
    const workspace = request.workspacePath ? resolve(request.workspacePath) : undefined;
    const tools = createTools(workspace, (value) => { output = value; }, process.env.GOAH_PI_ALLOW_BASH === "true");
    const compactAt = Number(process.env.GOAH_PI_COMPACT_AT_TOKENS ?? Math.floor(request.limits.maxTokens * 0.6));
    const agent = new Agent({
      initialState: {
        systemPrompt: `${process.env.GOAH_PI_SYSTEM_PROMPT ?? "You are a goal-oriented worker."}\nYou must finish by calling handoff exactly once. Treat the supplied context as authoritative.`,
        model,
        tools,
      },
      streamFn: models.streamSimple.bind(models),
      getApiKey: (id) => providerApiKey(id),
      transformContext: async (messages) => {
        if (estimateMessages(messages) < compactAt) return messages;
        compactions += 1;
        emit({ kind: "context.compacted", data: { compaction: compactions, sourceMessageCount: messages.length } });
        return compactMessages(messages);
      },
      beforeToolCall: async ({ toolCall }) => {
        const reserve = tokensUsed >= request.limits.maxTokens - request.limits.handoffReserveTokens;
        if (reserve && toolCall.name !== "handoff") return { block: true, reason: "handoff reserve active; only handoff is allowed" };
        return undefined;
      },
      shouldStopAfterTurn: () => output !== null || tokensUsed >= request.limits.maxTokens,
      toolExecution: "sequential",
    });
    agent.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") tokensUsed += event.message.usage.totalTokens;
      emit({ kind: `pi.${event.type}`, data: JSON.parse(JSON.stringify(event)) as JsonValue });
    });
    await agent.prompt(`Wake context:\n${JSON.stringify(request.context)}\n\nWork in: ${workspace ?? "no workspace"}`);
    if (!output) return { outcome: "abnormal", reason: "Pi worker exited without a valid handoff", tokensUsed };
    return { outcome: "handoff", output, tokensUsed };
  });
}

function createTools(workspace: string | undefined, handoff: (output: WakeOutput) => void, allowBash: boolean): AgentTool<any>[] {
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
      const value: WakeOutput = { handoff: { observations: input.observations, results: input.results, nextSteps: input.nextSteps, ...(input.blocker ? { blocker: input.blocker } : {}) }, mail: [], nextWakeAt: input.nextWakeAt ?? null };
      handoff(value);
      return { content: [{ type: "text", text: "handoff recorded" }], details: value, terminate: true };
    },
  };
  if (!workspace) return [handoffTool];
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
  if (!allowBash) return [readTool, writeTool, noteTool, handoffTool];
  const bashTool: AgentTool<any> = {
    name: "bash", label: "Bash", description: "Run a shell command in the wake workspace.",
    parameters: Type.Object({ command: Type.String() }), executionMode: "sequential",
    execute: async (_id, params, signal) => {
      const input = params as { command: string };
      const result = await execFileAsync("/bin/sh", ["-lc", input.command], { cwd: workspace, signal, maxBuffer: 1_000_000 });
      return { content: [{ type: "text", text: `${result.stdout}${result.stderr}`.slice(-50_000) }], details: { command: input.command } };
    },
  };
  return [readTool, writeTool, noteTool, bashTool, handoffTool];
}

function scoped(workspace: string, path: string): string {
  const resolved = resolve(workspace, path);
  if (resolved !== workspace && !resolved.startsWith(`${workspace}${sep}`)) throw new Error("path escapes workspace");
  return resolved;
}
function estimateMessages(messages: AgentMessage[]): number { return Math.ceil(JSON.stringify(messages).length / 4); }
function messageText(message: AgentMessage): string {
  const value = message as Message;
  if (value.role === "user") return typeof value.content === "string" ? value.content : value.content.map((item) => item.type === "text" ? item.text : "[image]").join(" ");
  if (value.role === "assistant") return value.content.map((item) => item.type === "text" ? item.text : item.type === "thinking" ? item.thinking : `[tool:${item.name}]`).join(" ");
  return value.content.map((item) => item.type === "text" ? item.text : "[image]").join(" ");
}
function providerApiKey(provider: string): string | undefined {
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY;
  if (provider === "openai") return process.env.OPENAI_API_KEY;
  return undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await runPiWorker();
