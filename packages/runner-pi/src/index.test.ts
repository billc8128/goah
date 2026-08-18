import assert from "node:assert/strict";
import test from "node:test";
import type { RunRequest, WakeSnapshot, WakeOutput } from "@goah/ledger-contract";
import { PiRunnerAdapter, ProcessRunner, type PiDriver } from "./index.js";
import { compactMessages, validateNextWakeAt } from "./pi-worker.js";
import { createPiModel, providerApiKey } from "./model-provider.js";

const wake: WakeSnapshot = { id: "w", agent: "a", triggerRef: "t", status: "running", leaseUntil: "2026-08-18T00:01:00.000Z", attempt: 1, startedAt: "2026-08-18T00:00:00.000Z", endedAt: null, enqueuedSeq: 1, leaseToken: "lease", runnerPid: null };

function driver(steps: Array<{ tokens: number; stop?: boolean; requireHandoffOnly?: boolean; handoff?: WakeOutput }>): PiDriver {
  return {
    createSession: async () => ({
      step: async (mode) => {
        const step = steps.shift() ?? { tokens: 1, stop: true };
        if (step.requireHandoffOnly) assert.equal(mode.handoffOnly, true);
        return { tokensUsed: step.tokens, ...(step.stop ? { stopped: true } : {}), ...(step.handoff ? { handoff: step.handoff } : {}) };
      },
      close: async () => undefined,
    }),
  };
}

test("token reserve disables ordinary work and preserves a legal handoff", async () => {
  const now = "2026-08-18T00:00:00.000Z";
  const faux = driver([
    { tokens: 750 },
    { tokens: 100, requireHandoffOnly: true, handoff: { handoff: { observations: [], results: ["done"], nextSteps: [] }, mail: [], nextWakeAt: null } },
  ]);
  const request: RunRequest = {
    wake, context: {}, limits: { maxTokens: 1_000, maxWallClockMs: 10_000, handoffReserveTokens: 250, handoffReserveWallClockMs: 1_000 },
    now: () => now, emit: () => undefined,
  };
  const handle = new PiRunnerAdapter(faux).prepare(request);
  handle.begin();
  const result = await handle.result;
  assert.equal(result.outcome, "handoff");
});

test("stopping without handoff is abnormal", async () => {
  const handle = new PiRunnerAdapter(driver([{ tokens: 10, stop: true }])).prepare({
    wake, context: {}, limits: { maxTokens: 100, maxWallClockMs: 100, handoffReserveTokens: 10, handoffReserveWallClockMs: 10 },
    now: () => "2026-08-18T00:00:00.000Z", emit: () => undefined,
  });
  handle.begin();
  const result = await handle.result;
  assert.deepEqual(result.outcome, "abnormal");
});

test("wall-clock reserve also switches the runner to handoff-only mode", async () => {
  let nowMs = Date.parse("2026-08-18T00:00:00.000Z");
  const faux: PiDriver = {
    createSession: async () => {
      let turn = 0;
      return {
        step: async (mode) => {
          turn += 1;
          if (turn === 1) {
            nowMs += 85;
            return { tokensUsed: 10 };
          }
          assert.equal(mode.handoffOnly, true);
          return { tokensUsed: 10, handoff: { handoff: { observations: [], results: [], nextSteps: [] }, mail: [], nextWakeAt: null } };
        },
        close: async () => undefined,
      };
    },
  };
  const handle = new PiRunnerAdapter(faux).prepare({
    wake, context: {}, limits: { maxTokens: 100, maxWallClockMs: 100, handoffReserveTokens: 10, handoffReserveWallClockMs: 20 },
    now: () => new Date(nowMs).toISOString(), emit: () => undefined,
  });
  handle.begin();
  const result = await handle.result;
  assert.equal(result.outcome, "handoff");
});

test("ProcessRunner kills a child stuck inside one step before reporting abnormal", async () => {
  const runner = new ProcessRunner({ command: process.execPath, args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"], killGraceMs: 25 });
  const handle = runner.prepare({
    wake, context: {}, limits: { maxTokens: 100, maxWallClockMs: 50, handoffReserveTokens: 10, handoffReserveWallClockMs: 10 },
    now: () => new Date().toISOString(), emit: () => undefined,
  });
  assert.ok(handle.pid);
  handle.begin();
  const result = await handle.result;
  assert.equal(result.outcome, "abnormal");
  assert.throws(() => process.kill(handle.pid!, 0));
});

test("mid-turn compaction changes only the model view and preserves boundary messages", () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({ role: "user" as const, content: `constraint-${index}`, timestamp: index }));
  const original = JSON.stringify(messages);
  const compacted = compactMessages(messages, 4);
  assert.equal(JSON.stringify(messages), original);
  assert.equal(compacted[0], messages[0]);
  assert.deepEqual(compacted.slice(-4), messages.slice(-4));
  assert.match((compacted[1] as { content: string }).content, /Source message indexes/);
});

test("Ark Coding Plan is exposed as an OpenAI Responses provider", () => {
  const previousKey = process.env.ARK_API_KEY;
  const previousBaseUrl = process.env.GOAH_PI_BASE_URL;
  process.env.ARK_API_KEY = "test-key";
  process.env.GOAH_PI_BASE_URL = "https://example.test/api/coding/v3";
  try {
    const { model } = createPiModel("ark-coding", "glm-test");
    assert.equal(model.provider, "ark-coding");
    assert.equal(model.api, "openai-responses");
    assert.equal(model.baseUrl, "https://example.test/api/coding/v3");
    assert.equal(providerApiKey("ark-coding"), "test-key");
  } finally {
    if (previousKey === undefined) delete process.env.ARK_API_KEY; else process.env.ARK_API_KEY = previousKey;
    if (previousBaseUrl === undefined) delete process.env.GOAH_PI_BASE_URL; else process.env.GOAH_PI_BASE_URL = previousBaseUrl;
  }
});

test("handoff rejects stale next-wake times", () => {
  const startedAt = "2026-08-19T00:00:00.000Z";
  assert.equal(validateNextWakeAt(undefined, startedAt), null);
  assert.equal(validateNextWakeAt("2026-08-19T01:00:00Z", startedAt), "2026-08-19T01:00:00.000Z");
  assert.throws(() => validateNextWakeAt("2025-08-19T01:00:00Z", startedAt), /later than/);
  assert.throws(() => validateNextWakeAt("not-a-date", startedAt), /later than/);
});
