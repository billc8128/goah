import type { EventInput, EventRecord, JsonValue } from "./kernel.js";

export const SESSION_FORMAT_VERSION = 1;
export const SESSION_MIN_READABLE_VERSION = 0;
export type SessionEventType = "session.started" | "request.prepared" | "turn.started" | "message.user" | "message.assistant.delta" | "message.assistant.completed" | "tool.called" | "tool.completed" | "context.compacted" | "turn.completed" | "session.completed" | "session.interrupted";
export interface SessionStarted { formatVersion: typeof SESSION_FORMAT_VERSION; provider: string; model: string; runner: string; contextWindowTokens: number; maxOutputTokensPerTurn: number }
export interface SessionMessage { id: string; role: "user" | "assistant" | "tool"; content: JsonValue; toolCallId?: string; usage?: JsonValue }
export interface RequestSnapshot { provider: string; model: string; systemPrompt: string; activeContext: string; messages: JsonValue[]; tools: JsonValue[]; modelConfig: JsonValue; sourceSeqs: number[] }
export interface ReplayedSession { messages: SessionMessage[]; status: "running" | "completed" | "interrupted"; openToolCalls: Array<{ callId: string; name: string; arguments: JsonValue }>; lastRequest: RequestSnapshot | null }

const SESSION_TYPES = new Set<SessionEventType>(["session.started", "request.prepared", "turn.started", "message.user", "message.assistant.delta", "message.assistant.completed", "tool.called", "tool.completed", "context.compacted", "turn.completed", "session.completed", "session.interrupted"]);
export function isSessionEvent(event: Pick<EventRecord, "type">): event is EventRecord & { type: SessionEventType } { return SESSION_TYPES.has(event.type as SessionEventType); }

export class SessionFormatUnsupportedError extends Error {
  constructor(readonly foundVersion: number, readonly supportedVersion = SESSION_FORMAT_VERSION) { super(`session format ${foundVersion} is unsupported by this harness (supports ${supportedVersion}); upgrade the harness`); this.name = "SessionFormatUnsupportedError"; }
}
export class SessionEventUnsupportedError extends Error { constructor(readonly eventType: string) { super(`required session event is unknown to this harness: ${eventType}`); this.name = "SessionEventUnsupportedError"; } }
export class SessionCorruptionError extends Error { constructor(message: string) { super(message); this.name = "SessionCorruptionError"; } }

/** Import supported legacy records without rewriting the append-only source log. */
export function upgradeSessionEvents(source: readonly EventRecord[]): EventRecord[] {
  assertContiguous(source);
  const starts = source.filter((event) => event.type === "session.started");
  if (starts.length === 0) {
    if (source.some((event) => isSessionNamespace(event.type))) throw new SessionCorruptionError("session events exist without session.started");
    return [...source];
  }
  if (starts.length !== 1) throw new SessionCorruptionError("session stream contains multiple session.started events");
  const rawVersion = field(starts[0]!.data, "formatVersion");
  let version = rawVersion === undefined ? 0 : Number(rawVersion);
  if (!Number.isSafeInteger(version) || version < SESSION_MIN_READABLE_VERSION) throw new SessionCorruptionError(`invalid session format version: ${String(rawVersion)}`);
  if (version > SESSION_FORMAT_VERSION) throw new SessionFormatUnsupportedError(version);
  let events = [...source];
  while (version < SESSION_FORMAT_VERSION) {
    if (version === 0) {
      events = events.map((event) => event.type === "session.started" ? { ...event, data: { ...(event.data as Record<string, JsonValue>), formatVersion: 1 } } : event);
      version = 1;
    } else throw new SessionFormatUnsupportedError(version);
  }
  for (const event of events) {
    if (!isSessionEvent(event) && isSessionNamespace(event.type) && event.ignorable !== true) throw new SessionEventUnsupportedError(event.type);
  }
  return events;
}

/** Rebuild the model-visible transcript from canonical, normalized session events. */
export function replaySession(events: readonly EventRecord[]): ReplayedSession {
  const upgraded = upgradeSessionEvents(events);
  const messages: SessionMessage[] = [];
  const calls = new Map<string, { callId: string; name: string; arguments: JsonValue }>();
  let status: ReplayedSession["status"] = "running";
  let lastRequest: RequestSnapshot | null = null;
  for (const event of upgraded) {
    if (!isSessionEvent(event)) continue;
    const data = event.data as Record<string, unknown>;
    if (event.type === "message.user" || event.type === "message.assistant.completed") messages.push(data.message as SessionMessage);
    else if (event.type === "tool.called") {
      const call = { callId: String(data.callId), name: String(data.name), arguments: (data.arguments ?? null) as JsonValue };
      calls.set(call.callId, call);
    } else if (event.type === "tool.completed") {
      const callId = String(data.callId);
      calls.delete(callId);
      messages.push({ id: String(data.messageId ?? `tool:${callId}`), role: "tool", toolCallId: callId, content: (data.result ?? null) as JsonValue });
    } else if (event.type === "context.compacted") {
      const replaced = new Set(Array.isArray(data.replacedMessageIds) ? data.replacedMessageIds.map(String) : []);
      const kept = messages.filter((message) => !replaced.has(message.id));
      messages.splice(0, messages.length, ...kept);
      messages.unshift({ id: String(data.summaryMessageId), role: "user", content: String(data.summary) });
    } else if (event.type === "request.prepared") lastRequest = event.data as unknown as RequestSnapshot;
    else if (event.type === "session.completed") status = "completed";
    else if (event.type === "session.interrupted") status = "interrupted";
  }
  return { messages, status, openToolCalls: [...calls.values()], lastRequest };
}

/** Synthetic facts that close an interrupted session without hiding unknown tool outcomes. */
export function interruptedSessionEvents(events: readonly EventRecord[], ts: string, actor: string): EventInput[] {
  const replayed = replaySession(events);
  if (replayed.status !== "running" || !events.some((event) => event.type === "session.started")) return [];
  const streamId = events[0]!.streamId;
  const repairs: EventInput[] = replayed.openToolCalls.map((call) => ({ streamId, ts, actor, type: "tool.completed", data: { callId: call.callId, messageId: `repair:${call.callId}`, result: { outcome: "unknown", synthetic: true, reason: "runner interrupted before a durable result" } } }));
  repairs.push({ streamId, ts, actor, type: "session.interrupted", data: { reason: "runner interrupted" } });
  return repairs;
}

function assertContiguous(events: readonly EventRecord[]): void {
  let expected = events[0]?.streamSeq ?? 1;
  for (const event of events) {
    if (event.streamSeq !== expected) throw new SessionCorruptionError(`session stream gap: expected ${expected}, got ${event.streamSeq}`);
    expected += 1;
  }
}
function isSessionNamespace(type: string): boolean { return ["session.", "request.", "turn.", "message.", "tool.", "context."].some((prefix) => type.startsWith(prefix)); }
function field(value: unknown, key: string): unknown { return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined; }
