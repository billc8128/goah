import assert from "node:assert/strict";
import test from "node:test";
import type { EventRecord } from "goah-ledger-contract";
import { composeActiveContext, selectRecoveryEvents } from "./context-view.js";

function event(streamSeq: number, type: string, data: EventRecord["data"] = {}): EventRecord {
  return { seq: streamSeq, streamId: "wake:failed", streamSeq, ts: "2030-01-01T00:00:00.000Z", actor: "worker", type, data };
}

test("recovery context selects semantic failure facts instead of raw session traffic", () => {
  const events = [
    event(1, "session.started"),
    ...Array.from({ length: 200 }, (_, index) => event(index + 2, "message.assistant.delta", { delta: "x".repeat(100) })),
    event(202, "request.prepared", { activeContext: "large".repeat(1_000) }),
    event(203, "tool.called", { callId: "read", name: "read_file", arguments: {} }),
    event(204, "tool.completed", { callId: "read", result: { text: "ok" } }),
    event(205, "tool.called", { callId: "publish", name: "publish", arguments: { id: 1 } }),
    event(206, "wake.abnormal_reason", { reason: "SIGKILL" }),
    event(207, "tool.completed", { callId: "publish", result: { outcome: "unknown", synthetic: true } }),
    event(208, "session.interrupted", { reason: "runner interrupted" }),
  ];
  const selected = selectRecoveryEvents(events);
  assert.deepEqual(selected.map((item) => item.type), ["tool.called", "wake.abnormal_reason", "tool.completed", "session.interrupted"]);
  const view = composeActiveContext({
    role: "child", capabilities: ["ledger.search"], systemPrompt: "worker", wake: { id: "retry", agent: "worker", triggerRef: "retry:failed", status: "running", leaseUntil: "2030-01-01T00:01:00.000Z", attempt: 1, startedAt: "2030-01-01T00:00:00.000Z", endedAt: null, enqueuedSeq: 1, leaseToken: "lease", runnerPid: 1 },
    goals: [], mail: [], actions: [], lastHandoff: null, teamHandoffs: [], team: [], recoveryEvents: selected,
  });
  assert.ok(view.text.length < 1_000);
  assert.doesNotMatch(view.text, /message\.assistant\.delta|request\.prepared/);
  assert.match(view.text, /unknown|SIGKILL/);
});
