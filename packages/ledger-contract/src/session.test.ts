import assert from "node:assert/strict";
import test from "node:test";
import { interruptedSessionEvents, replaySession, type EventRecord } from "./index.js";

function event(streamSeq: number, type: string, data: EventRecord["data"]): EventRecord {
  return { seq: streamSeq, streamId: "wake:w", streamSeq, ts: "2030-01-01T00:00:00.000Z", actor: "worker", type, data };
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
