# Contracts

All public packages evolve in lockstep under `CONTRACT_VERSION`. The current contract is experimental and additive evolution is preferred; SQLite changes require an explicit migration and future schema versions are rejected.

- Kernel: append-only typed events with global and per-stream order. The kernel does not name Goal, Wake, Mailbox, or Action.
- Session: normalized user/assistant/tool/request/compaction events; `replaySession()` derives the model-visible transcript and interrupted open tool calls become explicit `unknown` outcomes.
- Execution modules: five rebuildable standard projections; event and projection mutations are atomic. Goal contains only identity, hierarchy, objective, ownership, phase, and revision. Metrics are optional registrations.
- Runner: process-isolated request/result protocol, normalized Session forwarding, fencing, structured handoff, exact request capture, and runner-owned local execution. Resource policy is not part of the core request/result contract.
- RPC: request/response IDs over the runner pipe; supervisor validates the active lease and role capability before every read or mutation.
- Load: structured projections are deterministically rendered as a short Markdown Active Context with source event sequences; the final value is recorded by `request.prepared`.
- Handoff: observations, results, next steps, optional blocker, mail, and next wake.
- Connector: process-isolated capability manifest declaring idempotency, query behavior, retry policy, and generic approval risk. Payload policy belongs to the connector or an extension.

Third-party ledgers should run `assertLedgerConformance()` from `goah-testkit`.
