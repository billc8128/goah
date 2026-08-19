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

**Experimental.** Contracts are `0.1.0` / `experimental`. SQLite schema changes now use explicit, version-checked migrations; public TypeScript contracts may still change before 1.0.

Implemented and tested today:

- Append-only SQLite event ledger with five rebuildable projections (`goals`, `schedule`, `wakes`, `mailbox`, `actions`), event + projection committed in one transaction, fault-injection tested at every state transition
- FIFO wake lifecycle with leases: per-agent concurrency of one, trigger deduplication, fencing tokens, recorded runner PIDs, and kill-before-salvage recovery
- Action state machine with real evidence validation, human approval/rejection, `unknown` semantics, and query-based reconciliation
- Audit advice write/ack APIs and mandatory injection of unacknowledged advice into the action owner's next context
- Connector capability manifests and isolated connector subprocesses: undeclared capabilities fail closed, ambient secrets are not inherited, automatic retry requires declared native idempotency
- Per-wake git worktrees with serial rebase-merge, retained refs for `merge_blocked` and abnormal work, and bounded checkout retention
- Real runner subprocess boundary with token/wall-clock limits, a handoff reserve zone, process-group termination, and stale-event rejection
- Mail acknowledged atomically with a valid handoff; abnormal wakes leave messages unread for redelivery
- Injected clocks, schema v1→v3 migration, indexed bounded queries, and a public ledger conformance suite
- Mechanical metric evaluation (missing/stale/sustain/guardrails), heartbeat escalation, trigger coalescing, FTS5 fact search, and goal-budget reservation windows
- Official Pi 0.84.2 worker binding with workspace tools and model-view-only mid-turn compaction
- Concurrent child agents, CEO global context, serialized artifact merges, resident daemon loop, and a static read-only dashboard
- Session verifier plus blind-first global audit interfaces, audit-advice delivery, and precision/risk-weighted-recall evaluation
- Repo-guardian reference application, systemd/launchd templates, and an accelerated 30-day replay/continuity soak
- Bidirectional fenced RPC with role capabilities, executable CEO/verifier/audit prompts, versioned configuration, singleton CLI controls, and workspace-ref recovery

Operational acceptance evidence **not yet produced**:

- Real 7/14-day wall-clock soak evidence, a public sanitized long-run ledger, calibrated production verifier labels, and explicitly authorized small-money operation

## Quick start

Requires Node.js >= 24 (uses `node:sqlite`).

```bash
git clone https://github.com/billc8128/goah.git
cd goah
npm install
npm test          # contract, transaction-fault, process-recovery, merge, approval, audit, and connector tests
npm run example   # one full wake: goal → schedule → lease → faux run → handoff → git merge → done
npm run example:guardian
npm run test:soak
```

Initialize and operate a configured supervisor:

```bash
npm install --save-dev goah
npx goah init --provider anthropic --model claude-sonnet-4-6
npx goah doctor
npx goah goal-create --id first-goal --owner worker --objective "Complete the first verified handoff" --wake-now
npx goah run-once
npx goah status
```

`goah start` runs the resident supervisor after the one-shot path is healthy. `goah wake <agent>` queues a manual wake. Provider credentials stay as `env:NAME` references in `goah.config.json`; `doctor` resolves and validates them without printing them. For an offline installation check, use `goah init --provider faux`.

Ark Coding Plan requires explicit model capabilities because its model-list API does not publish context/output limits:

```bash
npx goah init --provider ark-coding --model glm-5.2 \
  --api-key-env ARK_API_KEY \
  --context-window-tokens 256000 \
  --max-output-tokens 32000
```

Replace those sample limits with the selected model's published values.

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
3. It hydrates bounded context from indexed ledger queries: owned goals, unread mail, unacknowledged audit advice, last handoff, and any recovery slice.
4. The supervisor starts a runner subprocess only after the wake's lease token and PID are recorded. The child gets the context and worktree path, never a database connection or connector credentials.
5. The process runs under token/wall-clock limits. A timeout kills the process group before the worktree can be salvaged; stale lease tokens cannot append runner events.
6. A valid handoff atomically records the handoff, acknowledges consumed mail, delivers outgoing mail, and schedules the next wake. The worktree is then rebased and merged — or retained as a `merge_blocked` ref.
7. Any other exit is `abnormal`: after process death is confirmed, partial work goes to a salvage ref and a recovery wake can load the event slice. Unacknowledged mail remains available.

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
| `@goah/runner-pi` | contract | Worker-side Pi adapter plus supervisor-side `ProcessRunner`: IPC, timeout termination, handoff reserve, and trace forwarding. |
| `@goah/testkit` | all of the above | Simulated clock, faux process worker, isolated mock connector, public ledger conformance suite, and fault injection. |
| `goah` | contract, SQLite, runner, supervisor | Versioned config, singleton daemon, status/doctor, goals, approvals, dashboard, and recovery refs. |

## Security model

Read this before pointing goah at anything real.

Mechanically enforced today:

- No external side effects by default: a connector must declare a capability for an action's kind, and non-dry-run connectors additionally require an explicit supervisor opt-in. Anything undeclared is gated, fail-closed.
- Runner and connector code executes in child processes with minimal environments. Connector secrets are explicitly scoped to that connector; runners never receive them or a ledger connection.
- The events table is append-only (enforced by SQLite triggers); invalid wake/action state transitions are rejected by both the library and the database.
- Every action evidence sequence must exist. Gated actions require an authorized approval carrying its own reason and evidence.
- Mail survives abnormal wakes, and unacknowledged audit advice is forced into the next context.
- An `unknown` action is never automatically re-dispatched unless the connector manifest explicitly declares native idempotency and automatic retry.

Not guaranteed, by design honesty:

- goah does not make the model's judgment correct. It records reasons and evidence; it cannot verify they are good reasons.
- goah does not defend against prompt injection inside the agent's own context.

## Roadmap

| Milestone | Scope |
|---|---|
| 0 — contracts & failure semantics | ✅ implementation complete: metric/action/wake/connector contracts, FTS5, conformance and fault injection |
| 1A — durable core | ✅ implementation complete: daemon, process isolation, leases, recovery, worktree continuity, Pi binding |
| 1B — long-wake continuity | ✅ implementation complete: model-view compaction and accelerated continuity tests; real 10h soak still operational evidence |
| 2 — narrow closed loop | ✅ repo-guardian implementation complete; real unattended 14-day run still operational evidence |
| 3 — verification layer | ✅ verifier/global-audit interfaces, blind-first isolation and evaluation implemented; production calibration dataset remains operational work |
| 4 — multi-agent | ✅ concurrent agents, CEO context, mailbox, budgets and dashboard implemented; real-money trial requires explicit human authorization |

## Design

The architecture document (Chinese) is [`北辰-harness-设计稿.html`](./北辰-harness-设计稿.html) — the design this codebase implements, including the reasoning behind session-per-wake, the rejection of resume-based continuity, and the action-centric accountability model. Milestone 0 decisions are recorded as ADRs in [`docs/adr/`](./docs/adr/).

## Contributing

The contracts are experimental and moving; issues and discussion are more useful than large PRs right now. Everything runs offline — `npm test` is the whole setup. If you change ledger semantics, add a fault-injection case proving the transaction boundary holds.

## License

[Apache-2.0](./LICENSE)
