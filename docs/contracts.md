# Contracts

All public packages evolve in lockstep under `CONTRACT_VERSION`. The current contract is experimental and additive evolution is preferred; SQLite changes require an explicit migration and future schema versions are rejected.

- Ledger: append-only events plus five rebuildable projections; event and projection mutations are atomic.
- Runner: process-isolated request/result protocol, lossless trace forwarding, fencing, structured handoff, and runner-owned local execution. Resource policy is not part of the core request/result contract.
- RPC: request/response IDs over the runner pipe; supervisor validates the active lease and role capability before every read or mutation.
- Load: bounded role-specific context; unacknowledged audit advice is mandatory and raw hidden reasoning is never reloaded.
- Handoff: observations, results, next steps, optional blocker, mail, and next wake.
- Connector: process-isolated capability manifest declaring idempotency, query behavior, retry policy, and generic approval risk. Payload policy belongs to the connector or an extension.

Third-party ledgers should run `assertLedgerConformance()` from `goah-testkit`.
