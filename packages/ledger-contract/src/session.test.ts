import assert from "node:assert/strict";
import test from "node:test";
import { interruptedSessionEvents, replaySession, SESSION_FORMAT_VERSION, SessionCorruptionError, SessionEventUnsupportedError, SessionFormatUnsupportedError, upgradeSessionEvents, type EventRecord } from "./index.js";

function event(streamSeq: number, type: string, data: EventRecord["data"], ignorable = false): EventRecord {
  return { seq: streamSeq, streamId: "wake:w", streamSeq, ts: "2030-01-01T00:00:00.000Z", actor: "worker", type, data, ...(ignorable ? { ignorable: true as const } : {}) };
}

test("session replay derives messages from normalized facts and applies compaction without deleting history", () => {
  const events = [
    event(1, "session.started", {}),
    event(2, "message.user", { message: { id: "u1", role: "user", content: "start" } }),
    event(3, "message.assistant.delta", { messageId: "a1", delta: "par" }),
    event(4, "message.assistant.completed", { message: { id: "a1", role: "assistant", content: "partial answer" } }),
    event(5, "tool.called", { callId: "t1", name: "read", arguments: { path: "x" } }),
    event(6, "tool.completed", { callId: "t1", result: { text: "ok" } }),
    event(7, "context.compacted", { replacedMessageIds: ["u1", "a1", "tool:t1"], retainedMessageIds: [], summaryMessageId: "s1", summary: "work so far" }),
    event(8, "request.prepared", { provider: "faux", model: "m", systemPrompt: "s", activeContext: "ctx", messages: [], tools: [], modelConfig: {}, sourceSeqs: [2] }),
    event(9, "session.completed", {}),
  ];
  const replayed = replaySession(events);
  assert.deepEqual(replayed.messages, [{ id: "s1", role: "user", content: "work so far" }]);
  assert.equal(replayed.status, "completed");
  assert.equal(replayed.lastRequest?.activeContext, "ctx");
  assert.equal(events.length, 9);
});

test("interrupted session repair preserves an unknown tool outcome", () => {
  const events = [event(1, "session.started", {}), event(2, "tool.called", { callId: "t1", name: "publish", arguments: {} })];
  const repair = interruptedSessionEvents(events, "2030-01-01T00:01:00.000Z", "supervisor");
  assert.deepEqual(repair.map((item) => item.type), ["tool.completed", "session.interrupted"]);
  assert.equal((repair[0]!.data as { result: { outcome: string } }).result.outcome, "unknown");
});

test("session replay rejects a gap in the stream", () => {
  assert.throws(() => replaySession([event(1, "session.started", {}), event(3, "session.completed", {})]), /stream gap/);
});

test("legacy format zero upgrades in memory without rewriting source events", () => {
  const source = [event(1, "session.started", { provider: "faux", model: "m" }), event(2, "session.completed", {})];
  const upgraded = upgradeSessionEvents(source);
  assert.equal((source[0]!.data as Record<string, unknown>).formatVersion, undefined);
  assert.equal((upgraded[0]!.data as Record<string, unknown>).formatVersion, SESSION_FORMAT_VERSION);
  assert.equal(replaySession(source).status, "completed");
});

test("future formats and unknown required events fail closed while informational events may be skipped", () => {
  assert.throws(() => replaySession([event(1, "session.started", { formatVersion: SESSION_FORMAT_VERSION + 1 })]), SessionFormatUnsupportedError);
  const started = event(1, "session.started", { formatVersion: SESSION_FORMAT_VERSION });
  assert.throws(() => replaySession([started, event(2, "message.future", {})]), SessionEventUnsupportedError);
  assert.equal(replaySession([started, event(2, "message.future", {}, true), event(3, "session.completed", {})]).status, "completed");
  assert.throws(() => replaySession([event(1, "message.user", { message: { id: "u", role: "user", content: "x" } })]), SessionCorruptionError);
});
