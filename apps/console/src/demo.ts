import type { ConsoleSnapshot, EventView } from "./types"

const events: EventView[] = [
  { seq: 12835, streamId: "wake:operations-3", streamSeq: 19, ts: "2026-08-20T14:10:22.000+08:00", actor: "operations", type: "handoff.recorded", data: { observations: ["Fulfillment p95 is 41 hours", "Support SLA is 96%"], results: ["Carrier backlog cleared", "Refund queue is stable"], nextSteps: ["Recheck fulfillment window at 14:30"] } },
  { seq: 12836, streamId: "wake:web-3", streamSeq: 17, ts: "2026-08-20T14:11:12.000+08:00", actor: "web", type: "handoff.recorded", data: { observations: ["Production smoke test passed"], results: ["Storefront v1 is ready to publish"], nextSteps: ["Request human approval for publish.storefront"] } },
  { seq: 12841, streamId: "goal:storefront", streamSeq: 4, ts: "2026-08-20T14:12:31.000+08:00", actor: "ceo", type: "goal.delegated", data: { goalId: "storefront", owner: "web", reason: "Launch acquisition surface" } },
  { seq: 12842, streamId: "metric:orders", streamSeq: 18, ts: "2026-08-20T14:12:57.000+08:00", actor: "operations", type: "metric.evaluated", data: { status: "passed", summary: "Orders p95 fulfillment ≤ 48h" } },
  { seq: 12843, streamId: "wake:growth-7", streamSeq: 31, ts: "2026-08-20T14:13:21.000+08:00", actor: "growth", type: "handoff.recorded", data: { observations: ["342 paying users"], results: ["ROAS 2.8"], nextSteps: ["Scale winning channel"] } },
  { seq: 12844, streamId: "wake:web-4", streamSeq: 1, ts: "2026-08-20T14:14:18.000+08:00", actor: "web", type: "wake.enqueued", data: { reason: "Launch storefront", nextWakeAt: "2026-08-20T14:30:00.000+08:00" } },
  { seq: 12845, streamId: "action:publish-storefront", streamSeq: 1, ts: "2026-08-20T14:16:21.000+08:00", actor: "web", type: "action.requested", data: { kind: "publish.storefront", reason: "Validated landing page is ready" } },
  { seq: 12846, streamId: "mail:decision-growth", streamSeq: 1, ts: "2026-08-20T14:17:04.000+08:00", actor: "ceo", type: "mail.sent", data: { to: "growth", level: "decision", summary: "Increase paid acquisition carefully" } },
  { seq: 12847, streamId: "wake:growth-8", streamSeq: 2, ts: "2026-08-20T14:18:02.000+08:00", actor: "growth", type: "wake.running", data: { runnerPid: 21874, triggerRef: "mail:decision-growth" } },
  { seq: 12848, streamId: "wake:growth-8", streamSeq: 3, ts: "2026-08-20T14:18:03.000+08:00", actor: "growth", type: "request.prepared", data: { activeContext: "Goal: Acquire 500 paying users. Observation method: count paid Stripe users and require 30-day ROAS ≥ 2.0. CEO decision: increase paid acquisition carefully.", provider: "faux", model: "faux-goah" } },
  { seq: 12849, streamId: "wake:growth-8", streamSeq: 4, ts: "2026-08-20T14:18:04.000+08:00", actor: "growth", type: "message.user", data: { message: { id: "growth-u1", role: "user", content: "Continue the paid acquisition goal using the confirmed observation method." } } },
  { seq: 12850, streamId: "wake:growth-8", streamSeq: 5, ts: "2026-08-20T14:18:07.000+08:00", actor: "growth", type: "message.assistant.completed", data: { message: { id: "growth-a1", role: "assistant", content: "I’ll inspect the latest paid-user and channel evidence before changing spend." } } },
  { seq: 12851, streamId: "wake:growth-8", streamSeq: 6, ts: "2026-08-20T14:18:08.000+08:00", actor: "growth", type: "tool.called", data: { callId: "read-metrics", name: "bash", arguments: { command: "node scripts/acquisition-report.mjs --window 30d" } } },
  { seq: 12852, streamId: "wake:growth-8", streamSeq: 7, ts: "2026-08-20T14:18:10.000+08:00", actor: "growth", type: "tool.completed", data: { callId: "read-metrics", name: "bash", result: { paidUsers: 342, roas: 2.8, bestChannel: "Meta Ads", stale: false } } },
  { seq: 12853, streamId: "wake:growth-8", streamSeq: 8, ts: "2026-08-20T14:18:12.000+08:00", actor: "growth", type: "message.assistant.completed", data: { message: { id: "growth-a2", role: "assistant", content: "The observation passes: 342 paid users and ROAS 2.8. I’ll preserve the current winner and prepare a bounded spend increase for approval." } } },
  { seq: 12854, streamId: "wake:growth-8", streamSeq: 9, ts: "2026-08-20T14:18:13.000+08:00", actor: "growth", type: "tool.called", data: { callId: "write-plan", name: "write", arguments: { path: "growth/next-experiment.md", content: "Scale Meta Ads by 12% with a 48-hour ROAS guardrail." } } },
  { seq: 12855, streamId: "wake:growth-8", streamSeq: 10, ts: "2026-08-20T14:18:14.000+08:00", actor: "growth", type: "tool.completed", data: { callId: "write-plan", name: "write", result: { path: "growth/next-experiment.md", bytes: 68 } } },
  { seq: 12856, streamId: "wake:growth-8", streamSeq: 11, ts: "2026-08-20T14:18:16.000+08:00", actor: "growth", type: "message.assistant.completed", data: { message: { id: "growth-a3", role: "assistant", content: "Experiment plan recorded. The spend increase remains gated; no external action was replayed." } } },
  { seq: 12857, streamId: "wake:growth-8", streamSeq: 12, ts: "2026-08-20T14:18:18.000+08:00", actor: "growth", type: "handoff.recorded", data: { observations: ["342 paid users", "30-day ROAS 2.8"], results: ["Prepared a guarded 12% Meta Ads scale experiment"], nextSteps: ["Request approval", "Re-observe after 48 hours"], material: true } },
]

export const demoSnapshot: ConsoleSnapshot = {
  seq: 12857,
  now: "2026-08-20T14:18:22.000+08:00",
  goals: [
    { id: "company", parentId: null, objective: "Launch a profitable store", observationMethod: "Revenue ≥ $10k MRR for 3 consecutive days with CAC:LTV ≥ 1:3. Verify against paid orders, refunds, acquisition spend, and retained revenue.", owner: "ceo", phase: "active", revision: 3 },
    { id: "growth", parentId: "company", objective: "Acquire 500 paying users", observationMethod: "Count paid users in Stripe and require 30-day ROAS ≥ 2.0.", owner: "growth", phase: "active", revision: 2 },
    { id: "orders", parentId: "company", objective: "Fulfill orders reliably", observationMethod: "Require order fulfillment p95 ≤ 48 hours and support SLA ≥ 95%.", owner: "operations", phase: "active", revision: 1 },
    { id: "storefront", parentId: "company", objective: "Launch storefront", observationMethod: "Run storefront checks and require a successful production smoke test.", owner: "web", phase: "active", revision: 1 },
  ],
  team: [
    { agent: "ceo", goalIds: ["company"], status: "running", lastHandoffSeq: 12841, lastWakeStatus: "done", nextWakeAt: null },
    { agent: "growth", goalIds: ["growth"], status: "running", lastHandoffSeq: 12857, lastWakeStatus: "running", nextWakeAt: null },
    { agent: "operations", goalIds: ["orders"], status: "scheduled", lastHandoffSeq: 12835, lastWakeStatus: "done", nextWakeAt: "2026-08-20T14:30:00.000+08:00" },
    { agent: "web", goalIds: ["storefront"], status: "queued", lastHandoffSeq: 12836, lastWakeStatus: "queued", nextWakeAt: "2026-08-20T14:30:00.000+08:00" },
  ],
  wakes: [
    { id: "growth-8", agent: "growth", triggerRef: "mail:decision-growth", status: "running", leaseUntil: "2026-08-20T14:19:00.000+08:00", startedAt: "2026-08-20T14:11:00.000+08:00", endedAt: null, runnerPid: 21874, enqueuedSeq: 12846 },
    { id: "web-4", agent: "web", triggerRef: "goal:storefront", status: "queued", leaseUntil: null, startedAt: null, endedAt: null, runnerPid: null, enqueuedSeq: 12844 },
  ],
  actions: [{ id: "publish-storefront", agent: "web", kind: "publish.storefront", connector: "web", reason: "Validated landing page is ready", status: "requested", gated: true, evidence: [12841, 12844] }],
  schedules: [
    { id: "schedule:operations", agent: "operations", nextWakeAt: "2026-08-20T14:30:00.000+08:00", reason: "Check fulfillment window", setBy: "operations" },
    { id: "schedule:web", agent: "web", nextWakeAt: "2026-08-20T14:30:00.000+08:00", reason: "Continue storefront launch", setBy: "ceo" },
  ],
  mailbox: [{ id: "decision-growth", to: "growth", from: "ceo", level: "decision", body: { summary: "Increase paid acquisition carefully" }, readAt: "2026-08-20T14:17:30.000+08:00" }],
  events,
}
