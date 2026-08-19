import type { JsonValue } from "./kernel.js";

/** Optional goal-measurement policy. It is not part of the Goal contract. */
export interface MetricContract {
  source: string;
  window: string;
  direction: "increase" | "decrease" | "at_least" | "at_most";
  target: number;
  freshnessMs: number;
  onMissing: "abnormal" | "wake_owner";
  onStale: "abnormal" | "wake_owner";
  sustainForMs?: number;
  guardrails?: Array<{ metric: string; direction: "at_least" | "at_most"; target: number }>;
}

export interface MetricSample { goalId: string; source: string; observedAt: string; value: number | null; guardrails?: Record<string, number> }
export interface MetricEvaluation { goalId: string; status: "met" | "missed" | "missing" | "stale" | "guardrail_breached"; shouldWakeOwner: boolean; evaluatedAt: string; value: number | null }
export interface MetricProcessSpec { command: string; args: string[]; env?: Record<string, string>; timeoutMs?: number }

export function evaluateMetric(metric: MetricContract, samples: MetricSample[], now: string): MetricEvaluation {
  const latest = samples.filter((sample) => sample.source === metric.source).sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
  if (!latest || latest.value === null) return { goalId: latest?.goalId ?? "unknown", status: "missing", shouldWakeOwner: metric.onMissing === "wake_owner", evaluatedAt: now, value: null };
  if (Date.parse(now) - Date.parse(latest.observedAt) > metric.freshnessMs) return { goalId: latest.goalId, status: "stale", shouldWakeOwner: metric.onStale === "wake_owner", evaluatedAt: now, value: latest.value };
  const guardrailBreached = (metric.guardrails ?? []).some((guardrail) => {
    const value = latest.guardrails?.[guardrail.metric];
    return value === undefined || (guardrail.direction === "at_least" ? value < guardrail.target : value > guardrail.target);
  });
  if (guardrailBreached) return { goalId: latest.goalId, status: "guardrail_breached", shouldWakeOwner: true, evaluatedAt: now, value: latest.value };
  const meets = (value: number) => metric.direction === "increase" || metric.direction === "at_least" ? value >= metric.target : value <= metric.target;
  let met = meets(latest.value);
  if (met && metric.sustainForMs) {
    const cutoff = Date.parse(now) - metric.sustainForMs;
    const ordered = samples.filter((sample) => sample.source === metric.source && sample.value !== null && Date.parse(sample.observedAt) <= Date.parse(now)).sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    const baseline = ordered.findLast((sample) => Date.parse(sample.observedAt) <= cutoff);
    const sustained = ordered.filter((sample) => Date.parse(sample.observedAt) >= cutoff);
    met = Boolean(baseline && meets(baseline.value!) && sustained.every((sample) => meets(sample.value!)));
  }
  return { goalId: latest.goalId, status: met ? "met" : "missed", shouldWakeOwner: !met, evaluatedAt: now, value: latest.value };
}

export function metricEventData(value: MetricSample | MetricEvaluation): JsonValue { return value as unknown as JsonValue; }
