# Contracts

All public packages evolve in lockstep under `CONTRACT_VERSION`. The current contract is experimental and additive evolution is preferred; SQLite changes require an explicit migration and future schema versions are rejected.

- Kernel: append-only typed events with global and per-stream order. Events are required by default; `ignorable: true` explicitly permits an unfamiliar reader to skip an informational event. The kernel does not name Goal, Wake, Mailbox, or Action.
- Session: format v1 normalized user/assistant/tool/request/compaction events; format 0 upgrades in memory, future formats and unknown required events fail closed. `replaySession()` derives the model-visible transcript and interrupted open tool calls become explicit `unknown` outcomes.
- Execution modules: five rebuildable standard projections; event and projection mutations are atomic. Goal contains only identity, hierarchy, objective, ownership, the `active|paused|blocked|complete` phase, and revision. Atomic delegation commits its decision fact, child Goal, decision mail, and queued Wake in one transaction; atomic reassignment also notifies both owners and suppresses the previous owner's queued Wake. Metrics are optional registrations.
- Runner: process-isolated request/result protocol, normalized Session forwarding, fencing, structured handoff, exact request capture, and runner-owned local execution. Resource policy is not part of the core request/result contract.
- RPC: request/response IDs over the runner pipe; supervisor validates the active lease and role capability before every read or mutation.
- Load: structured projections are deterministically rendered as a short Markdown Active Context with source event sequences; the final value is recorded by `request.prepared`.
- Handoff: observations, results, next steps, optional blocker/material marker, mail, and next wake.
- CEO operating layer: the `ceo` identity is the default sole user-facing owner for root Goals. Its roster is derived from Goal/Wake/Schedule/Handoff facts, its default capabilities expose high-level organization tools, and an active root cannot hand off without child motion, a review, a blocker, or a human request.
- Connector: process-isolated capability manifest declaring idempotency, query behavior, retry policy, and generic approval risk. Payload policy belongs to the connector or an extension.

Third-party ledgers should run `assertLedgerConformance()` from `@goah/cli/testkit`. All public framework APIs ship in the single `@goah/cli` distribution; source workspace names are not independently published from 0.3 onward.
