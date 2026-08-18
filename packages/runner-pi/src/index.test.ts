import assert from "node:assert/strict";
import test from "node:test";
import type { RunRequest, WakeSnapshot, WakeOutput } from "@goah/ledger-contract";
import { PiRunnerAdapter, type PiDriver } from "./index.js";

const wake: WakeSnapshot = { id: "w", agent: "a", triggerRef: "t", status: "running", leaseUntil: "2026-08-18T00:01:00.000Z", attempt: 1, startedAt: "2026-08-18T00:00:00.000Z", endedAt: null };

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
  const result = await new PiRunnerAdapter(faux).run(request);
  assert.equal(result.outcome, "handoff");
});

test("stopping without handoff is abnormal", async () => {
  const result = await new PiRunnerAdapter(driver([{ tokens: 10, stop: true }])).run({
    wake, context: {}, limits: { maxTokens: 100, maxWallClockMs: 100, handoffReserveTokens: 10, handoffReserveWallClockMs: 10 },
    now: () => "2026-08-18T00:00:00.000Z", emit: () => undefined,
  });
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
  const result = await new PiRunnerAdapter(faux).run({
    wake, context: {}, limits: { maxTokens: 100, maxWallClockMs: 100, handoffReserveTokens: 10, handoffReserveWallClockMs: 20 },
    now: () => new Date(nowMs).toISOString(), emit: () => undefined,
  });
  assert.equal(result.outcome, "handoff");
});
