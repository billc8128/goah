import { homedir } from "node:os";
import { replaySession, wakeStream, type EventRecord, type JsonValue, type ReplayedSession, type RequestSnapshot, type WakeSnapshot } from "goah-ledger-contract";
import type { SqliteLedger } from "goah-ledger-sqlite";

export interface SessionListItem {
  wakeId: string;
  streamId: string;
  agent: string;
  wakeStatus: WakeSnapshot["status"];
  sessionStatus: ReplayedSession["status"] | WakeSnapshot["status"];
  triggerRef: string;
  eventCount: number;
  firstSeq: number | null;
  lastSeq: number | null;
  provider: string | null;
  model: string | null;
  formatVersion: number | null;
  messageCount: number;
  toolCalls: number;
  compactions: number;
}

export interface SessionDetail {
  session: SessionListItem;
  eventTypes: Record<string, number>;
  replay: { status: ReplayedSession["status"]; messageCount: number; openToolCalls: ReplayedSession["openToolCalls"] };
  requests: number;
  activeContext: SessionContextSnapshot | null;
}

export interface SessionContextSnapshot {
  eventSeq: number;
  provider: string;
  model: string;
  systemPrompt: string;
  text: string;
  sourceSeqs: number[];
  toolCount: number;
  messageCount: number;
  modelConfig: JsonValue;
}

export interface SessionExport {
  format: "goah.session-export.v1";
  exportedAt: string;
  redacted: boolean;
  session: SessionListItem;
  context: SessionContextSnapshot | null;
  replay: ReplayedSession;
  events: EventRecord[];
}

export function listSessions(ledger: SqliteLedger): SessionListItem[] {
  return ledger.wakes().map((wake) => summarize(ledger, wake)).sort((a, b) => (b.lastSeq ?? 0) - (a.lastSeq ?? 0));
}

export function showSession(ledger: SqliteLedger, wakeId: string): SessionDetail {
  const wake = requiredWake(ledger, wakeId);
  const events = ledger.eventsForWake(wakeId);
  const replay = replaySession(events);
  const eventTypes: Record<string, number> = {};
  for (const event of events) eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1;
  return {
    session: summarize(ledger, wake),
    eventTypes,
    replay: { status: replay.status, messageCount: replay.messages.length, openToolCalls: replay.openToolCalls },
    requests: eventTypes["request.prepared"] ?? 0,
    activeContext: contextSnapshot(events),
  };
}

export function replayWakeSession(ledger: SqliteLedger, wakeId: string): ReplayedSession {
  requiredWake(ledger, wakeId);
  return replaySession(ledger.eventsForWake(wakeId));
}

export function showSessionContext(ledger: SqliteLedger, wakeId: string): SessionContextSnapshot | null {
  requiredWake(ledger, wakeId);
  return contextSnapshot(ledger.eventsForWake(wakeId));
}

export function streamEvents(ledger: SqliteLedger, streamId: string, fromStreamSeq = 1): EventRecord[] {
  if (!streamId.trim()) throw new Error("--stream is required");
  if (!Number.isInteger(fromStreamSeq) || fromStreamSeq < 1) throw new Error("--from must be a positive integer");
  return ledger.readStream(streamId, fromStreamSeq);
}

export function exportSession(ledger: SqliteLedger, wakeId: string, options: { raw?: boolean; now?: string } = {}): SessionExport {
  const detail = showSession(ledger, wakeId);
  const value: SessionExport = {
    format: "goah.session-export.v1",
    exportedAt: options.now ?? new Date().toISOString(),
    redacted: !options.raw,
    session: detail.session,
    context: detail.activeContext,
    replay: replaySession(ledger.eventsForWake(wakeId)),
    events: ledger.eventsForWake(wakeId),
  };
  return options.raw ? value : redactValue(value) as unknown as SessionExport;
}

export function redactValue(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactValue(child, childKey)]));
  if (typeof value !== "string") return value;
  return value
    .replaceAll(homedir(), "<HOME>")
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ak|key)[-_][A-Za-z0-9_-]{12,}\b/gi, "[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*)[^\s,;"']+/gi, "$1[REDACTED]");
}

function summarize(ledger: SqliteLedger, wake: WakeSnapshot): SessionListItem {
  const events = ledger.eventsForWake(wake.id);
  const replay = replaySession(events);
  const started = events.find((event) => event.type === "session.started")?.data as Record<string, unknown> | undefined;
  return {
    wakeId: wake.id,
    streamId: wakeStream(wake.id),
    agent: wake.agent,
    wakeStatus: wake.status,
    sessionStatus: replay.status === "running" && ["done", "abnormal", "merge_blocked"].includes(wake.status) ? wake.status : replay.status,
    triggerRef: wake.triggerRef,
    eventCount: events.length,
    firstSeq: events[0]?.seq ?? null,
    lastSeq: events.at(-1)?.seq ?? null,
    provider: typeof started?.provider === "string" ? started.provider : null,
    model: typeof started?.model === "string" ? started.model : null,
    formatVersion: typeof started?.formatVersion === "number" ? started.formatVersion : started ? 0 : null,
    messageCount: replay.messages.length,
    toolCalls: events.filter((event) => event.type === "tool.called").length,
    compactions: events.filter((event) => event.type === "context.compacted").length,
  };
}

function contextSnapshot(events: EventRecord[]): SessionContextSnapshot | null {
  const event = events.findLast((candidate) => candidate.type === "request.prepared");
  if (!event) return null;
  const request = event.data as unknown as RequestSnapshot;
  return {
    eventSeq: event.seq,
    provider: request.provider,
    model: request.model,
    systemPrompt: request.systemPrompt,
    text: request.activeContext,
    sourceSeqs: request.sourceSeqs,
    toolCount: request.tools.length,
    messageCount: request.messages.length,
    modelConfig: request.modelConfig,
  };
}

function requiredWake(ledger: SqliteLedger, wakeId: string): WakeSnapshot {
  const wake = ledger.wake(wakeId);
  if (!wake) throw new Error(`wake not found: ${wakeId}`);
  return wake;
}

const SENSITIVE_KEY = /^(?:api[_-]?key|token|secret|password|authorization|cookie|set-cookie)$/i;
