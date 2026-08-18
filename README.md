# goah

**Goal-Oriented Agent Harness** — a long-running, goal-oriented agentic system.

Agents handle tasks. goah holds the goal.

[![CI](https://github.com/billc8128/goah/actions/workflows/ci.yml/badge.svg)](https://github.com/billc8128/goah/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
![Status](https://img.shields.io/badge/status-experimental-orange.svg)

## Why

Coding agents are good at bounded tasks: you give one a prompt, it works, it stops. Give one a goal measured in weeks — "keep this repo healthy", "grow revenue to $X/day" — and everything between sessions is on you: remembering the goal, scheduling the next run, checking what the agent actually did, recovering when it crashes mid-flight.

goah is the harness around the agent that owns exactly that layer:

- **The ledger is the agent.** Agent processes are short-lived: hydrate → work → handoff → exit. Everything durable lives in an append-only event ledger; every table is a projection that can be rebuilt from events. Crash recovery is replay, not heuristics.
- **Every action is accountable.** An external action carries its `reason` and `evidence` (references to ledger events), passes a gate before dispatch, and has crash-safe delivery semantics — a crash mid-dispatch resolves to `unknown`, which is reconciled by querying, never blindly retried.
- **Work survives, mistakes don't spread.** Each wake runs in its own git worktree. Merges are serial and rebase-based; a conflict blocks instead of overwriting. A crashed wake's partial work is preserved under a salvage ref for forensics.
- **Bounded runs by construction.** Every wake has hard token and wall-clock limits with a reserved handoff zone: near the limit the runner may only hand off, and a run that ends without a valid handoff is recorded as `abnormal` — never silently lost.

goah does not replace your agent runner (pi, or any runner that implements the `Runner` interface). It sits above it.

## Status

**Experimental.** Contracts are `0.1.0` / `experimental` and will change without migration paths.

Implemented and tested today (Milestone 0/1A vertical slice):

- Append-only SQLite event ledger with five rebuildable projections (`goals`, `schedule`, `wakes`, `mailbox`, `actions`), event + projection committed in one transaction, fault-injection tested at every state transition
- Wake lifecycle with leases: per-agent concurrency of one, trigger deduplication, expired-lease recovery (`leased` → requeued, `running` → `abnormal`)
- Action state machine with `unknown` semantics and query-based reconciliation
- Connector capability manifests: undeclared capabilities fail closed, external side effects are off by default, automatic retry only with declared native idempotency
- Per-wake git worktrees with serial rebase-merge, `merge_blocked` on conflict, salvage refs on crash
- Token / wall-clock limits with a handoff reserve zone

Designed but **not implemented yet** — do not rely on these:

- Human approval flow for gated actions (gated actions currently stop at `requested` with no approve API)
- Audit advice delivery (`audit_advice` exists in the schema; nothing writes or injects it yet)
- Verification layer, metric collection, budgets, multi-agent goal trees, mid-turn compaction for 10h+ runs

## Quick start

Requires Node.js >= 24 (uses `node:sqlite`).

```bash
git clone https://github.com/billc8128/goah.git
cd goah
npm install
npm test          # 14 tests: transaction faults, crash recovery, merge conflicts, connector semantics
npm run example   # one full wake: goal → schedule → lease → faux run → handoff → git merge → done
```

The example runs entirely offline: a simulated clock, an in-memory ledger, a faux driver instead of a real model, and a throwaway git repo. No API keys are involved anywhere in this codebase.

## How it works

```
            ┌──────────────────────────── supervisor (only resident process) ───────────────────────────┐
            │                                                                                           │
  schedule ─┼─▶ enqueue wake ─▶ lease ─▶ prepare worktree ─▶ run agent ─▶ handoff ─▶ merge ─▶ done      │
            │       │                                          │   │         │                          │
            │       │ dedupe by (agent, trigger_ref)           │   │         │ crash / no handoff       │
            │       ▼                                          │   │         ▼                          │
            │   already queued? reuse                          │   │      abnormal + salvage ref        │
            │                                                  │   │                                    │
            │                              actions (reason + evidence, gated) ─▶ connector dispatch     │
            │                                                      │                                    │
            └──────────────────────────────────────────────────────┼────────────────────────────────────┘
                                                                   ▼
                                            append-only events ledger (source of truth)
                                            goals · schedule · wakes · mailbox · actions = projections
```

One wake, step by step:

1. A due `schedule` entry becomes a queued `wake` (deduplicated by `(agent, trigger_ref)`).
2. The supervisor leases it — one active wake per agent, lease expiry is crash detection.
3. It hydrates context from the ledger (goals, unread mail, last handoff) and hands the runner a worktree path. The runner never gets a database connection or credentials.
4. The runner works under token/wall-clock limits. Inside the reserve zone it may only produce a handoff.
5. A valid handoff (`observations` / `results` / `nextSteps` / `blocker`) is recorded, outgoing mail is delivered, the next wake is scheduled, and the worktree is rebased and merged — or `merge_blocked` on conflict.
6. Any other exit is `abnormal`: partial work goes to a salvage ref, and a recovery wake can load the abnormal wake's event slice.

External actions follow their own state machine, independent of wake success:

```
requested ─▶ approved ─▶ dispatching ─▶ confirmed
                              │  └────▶ failed
                              ▼
                           unknown ──(query connector)──▶ confirmed / failed  (+ reconciled_at)
```

`unknown` is the honest state after a crash mid-dispatch: the side effect may or may not have happened. The default resolution is querying the connector, never re-dispatching — unless the connector's manifest declares native idempotency and opts into automatic retry.

## Packages

| Package | Depends on | What it is |
|---|---|---|
| `@goah/ledger-contract` | nothing | The contract: types, state machines, schema assertions. Agent-side code depends only on this. |
| `@goah/ledger-sqlite` | contract | Single-writer SQLite ledger. Append-only events enforced by triggers, projections rebuildable from events. |
| `@goah/supervisor` | contract | Scheduler, wake lifecycle, action gate, connector dispatch, git workspace manager. Never executes user code in-process. |
| `@goah/runner-pi` | contract | Runner adapter: limits, handoff reserve, trace forwarding. Bind any session-based runner via the `PiDriver` seam. |
| `@goah/testkit` | all of the above | Simulated clock, faux driver, mock connector, fault injection. Everything needed to test without keys. |

## Security model

Read this before pointing goah at anything real.

Mechanically enforced today:

- No external side effects by default: a connector must declare a capability for an action's kind, and non-dry-run connectors additionally require an explicit supervisor opt-in. Anything undeclared is gated, fail-closed.
- The agent runner receives hydrated context and a worktree path — never credentials, never a ledger connection.
- The events table is append-only (enforced by SQLite triggers); invalid wake/action state transitions are rejected by both the library and the database.
- An `unknown` action is never automatically re-dispatched unless the connector manifest explicitly declares native idempotency and automatic retry.

Not guaranteed, by design honesty:

- goah does not make the model's judgment correct. It records reasons and evidence; it cannot verify they are good reasons.
- goah does not defend against prompt injection inside the agent's own context.
- The current version has no human approval API and no audit-advice delivery — the accountability loop is not closed yet (see Status).

## Roadmap

| Milestone | Scope |
|---|---|
| 0 — contracts & failure semantics | ✅ shipped: state machines, transaction boundaries, fault-injection tests |
| 1A — durable core | ✅ shipped: SQLite ledger, wake/action recovery, worktree continuity |
| 1B — long-wake continuity | 10h+ runs: mid-turn compaction, kill -9 at every compaction phase, no duplicate side effects |
| 2 — narrow closed loop | one real scenario (repo guardian) running unattended for 14 days |
| 3 — verification layer | audit advice delivery, calibration/holdout eval, precision + risk-weighted recall |
| 4 — multi-agent | goal trees, budgets with reservation semantics, real connectors |

## Design

The architecture document (Chinese) is [`北辰-harness-设计稿.html`](./北辰-harness-设计稿.html) — the design this codebase implements, including the reasoning behind session-per-wake, the rejection of resume-based continuity, and the action-centric accountability model. Milestone 0 decisions are recorded as ADRs in [`docs/adr/`](./docs/adr/).

## Contributing

The contracts are experimental and moving; issues and discussion are more useful than large PRs right now. Everything runs offline — `npm test` is the whole setup. If you change ledger semantics, add a fault-injection case proving the transaction boundary holds.

## License

[Apache-2.0](./LICENSE)
