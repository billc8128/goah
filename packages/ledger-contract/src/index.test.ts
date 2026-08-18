import assert from "node:assert/strict";
import test from "node:test";
import { evaluateMetric, type MetricContract, type MetricSample } from "./index.js";

const base: MetricContract = { source: "revenue", window: "1h", direction: "at_least", target: 100, freshnessMs: 1_000, onMissing: "wake_owner", onStale: "wake_owner" };
const sample = (value: number | null, observedAt = "2030-01-01T00:00:00.000Z", guardrails?: Record<string, number>): MetricSample => ({ goalId: "g", source: "revenue", observedAt, value, ...(guardrails ? { guardrails } : {}) });

test("metric contract handles missing, stale, direction, sustain, and guardrails mechanically", () => {
  assert.equal(evaluateMetric(base, [], "2030-01-01T00:00:00.000Z").status, "missing");
  assert.equal(evaluateMetric(base, [sample(100)], "2030-01-01T00:00:02.000Z").status, "stale");
  assert.equal(evaluateMetric(base, [sample(99)], "2030-01-01T00:00:00.500Z").status, "missed");
  assert.equal(evaluateMetric(base, [sample(100)], "2030-01-01T00:00:00.500Z").status, "met");
  const guarded = { ...base, guardrails: [{ metric: "error_rate", direction: "at_most" as const, target: 0.05 }] };
  assert.equal(evaluateMetric(guarded, [sample(120, undefined, { error_rate: 0.1 })], "2030-01-01T00:00:00.500Z").status, "guardrail_breached");
  const sustained = { ...base, sustainForMs: 1_000, freshnessMs: 5_000 };
  assert.equal(evaluateMetric(sustained, [sample(110, "2029-12-31T23:59:59.000Z"), sample(105, "2030-01-01T00:00:00.000Z")], "2030-01-01T00:00:00.500Z").status, "met");
});
