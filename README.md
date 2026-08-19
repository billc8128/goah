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
- **The session is replayable.** User messages, assistant deltas and completed messages, tool calls/results, compaction replacements, and the exact prepared model request are normalized into typed event streams. The active conversation surface is derived from those facts.
- **Every action is accountable.** An external action carries its `reason` and `evidence` (references to ledger events), passes a gate before dispatch, and has crash-safe delivery semantics — a crash mid-dispatch resolves to `unknown`, which is reconciled by querying, never blindly retried.
- **Execution stays local and inspectable.** The runner owns local files, bash, and Git under the directory containing `goah.config.json`. GOAH records process failure and recovery context; coding skills decide how to branch, commit, merge, or preserve partial Git work.
- **Lease ownership is bounded, runner policy is not prescribed.** A live runner continuously renews its fenced wake lease; if the supervisor dies, renewal stops and recovery can terminate the old process. Token, cost, timeout, and handoff-reserve policy belong to each runner implementation.

goah does not replace your agent runner (pi, or any runner that implements the `Runner` interface). It sits above it.

## Status

**Experimental.** Contracts are `0.4.0` / `experimental`. SQLite schema changes use explicit, version-checked migrations; public TypeScript contracts may still change before 1.0.

Implemented and tested today:

- Stream-aware append-only SQLite event kernel with global `seq`, contiguous per-stream `streamSeq`, required/ignorable event semantics, and five standard execution-module projections (`goals`, `schedule`, `wakes`, `mailbox`, `actions`)
- Versioned replayable Session vocabulary with a v0→v1 upgrader, future-version refusal, exact request snapshots, user/assistant/tool events, compaction replacements, and interrupted-tool `unknown` repair
- Deterministic Active Context composition: structured projections render to short Markdown, and the exact model-visible value is retained by `request.prepared`
- FIFO wake lifecycle with leases: per-agent concurrency of one, trigger deduplication, fencing tokens, recorded runner PIDs, and kill-before-recovery semantics
- Action state machine with real evidence validation, human approval/rejection, `unknown` semantics, and query-based reconciliation
- Audit advice write/ack APIs and mandatory injection of unacknowledged advice into the action owner's next context
- Connector capability manifests and isolated connector subprocesses: undeclared capabilities fail closed, ambient secrets are not inherited, automatic retry requires declared native idempotency
- Runner-owned local execution: non-software goals need no Git, while coding agents can use ordinary Git and worktree commands through their skills
- Real runner subprocess boundary with sliding lease renewal, process-group termination, optional runner-specific timeout, and stale-event rejection
- Mail acknowledged atomically with a valid handoff; abnormal wakes leave messages unread for redelivery
- Injected clocks, schema v1→v6 migration into schema v7, indexed bounded queries, and a public ledger conformance suite
- Optional mechanical metric evaluation (missing/stale/sustain/guardrails), heartbeat escalation, trigger coalescing, FTS5 fact search, and generic evidence-backed actions; Goal itself has no required metric or target
- Official Pi 0.84.2 worker binding with local file/bash tools and model-view-only mid-turn compaction
- Concurrent child agents, CEO global context, resident daemon loop, and a static read-only dashboard
- Session verifier plus blind-first global audit interfaces, audit-advice delivery, and precision/risk-weighted-recall evaluation
- Repo-guardian reference application, systemd/launchd templates, and an accelerated 30-day replay/continuity soak
- Bidirectional fenced RPC with role capabilities, executable CEO/verifier/audit prompts, versioned configuration, and singleton CLI controls

Operational acceptance evidence **not yet produced**:

- Real 7/14-day wall-clock soak evidence, a public sanitized long-run ledger, calibrated production verifier labels, and explicitly authorized small-money operation

The completed real-model fault canary is documented in [`docs/canary/2026-08-19-ark-v0.3.1.md`](./docs/canary/2026-08-19-ark-v0.3.1.md): four wakes, one deliberate mid-tool SIGKILL, automatic retry, replay/Inspector verification, and two production findings fixed from the recorded evidence.

## Quick start

Requires Node.js >= 24 (uses `node:sqlite`).

```bash
git clone https://github.com/billc8128/goah.git
cd goah
npm install
npm test          # 49 contract, replay, transaction-fault, recovery, approval, audit, and connector tests
npm run example   # one full wake: goal → schedule → lease → faux run → handoff → done
npm run example:guardian
npm run test:soak
```

Initialize and operate a configured supervisor:

```bash
npm install --save-dev @goah/cli
npx goah init --provider anthropic --model claude-sonnet-4-6
npx goah doctor
npx goah goal-create --id first-goal --owner worker --objective "Complete the first verified handoff" --wake-now
npx goah goal-show first-goal
npx goah goal-update first-goal --objective "Updated objective"
npx goah goal-pause first-goal
npx goah goal-resume first-goal
npx goah goal-complete first-goal
npx goah run-once
npx goah status
```

`goah start` runs the resident supervisor after the one-shot path is healthy. `goah wake <agent>` queues a manual wake. Provider credentials stay as `env:NAME` references in `goah.config.json`; `doctor` resolves and validates them without printing them. For an offline installation check, use `goah init --provider faux`.

Inspect and export the replayable Session ledger without requiring provider credentials:

```bash
npx goah session list
npx goah session show <wake-id>
npx goah session replay <wake-id>
npx goah context show <wake-id>
npx goah events --stream wake:<wake-id> [--from 1]
npx goah session export <wake-id> --output session.json
```

`session show` summarizes event types, request count, replayed messages, and the last Active Context. Export is redacted by default: common secret fields, bearer/API-key patterns, and the current home path are removed while event identities remain intact. `--raw` is an explicit local-only escape hatch and may contain sensitive prompts and tool results.

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
  schedule ─┼─▶ enqueue wake ─▶ lease ─▶ run local agent ─▶ handoff ─▶ done                           │
            │       │                                          │   │         │                          │
            │       │ dedupe by (agent, trigger_ref)           │   │         │ crash / no handoff       │
            │       ▼                                          │   │         ▼                          │
            │   already queued? reuse                          │   │      abnormal + recovery context   │
            │                                                  │   │                                    │
            │                              actions (reason + evidence, gated) ─▶ connector dispatch     │
            │                                                      │                                    │
            └──────────────────────────────────────────────────────┼────────────────────────────────────┘
                                                                   ▼
                                            stream-aware event kernel (source of truth)
                                            session facts + execution-module projections
```

One wake, step by step:

1. A due `schedule` entry becomes a queued `wake` (deduplicated by `(agent, trigger_ref)`).
2. The supervisor leases it — one active wake per agent, lease expiry is crash detection.
3. It deterministically composes a short Markdown Active Context from owned goals, unread mail, unacknowledged audit advice, the last handoff, open actions, and any recovery slice.
4. The supervisor starts a runner subprocess only after the wake's lease token and PID are recorded. The child gets Active Context and a local root, never a database connection or connector credentials. Its normalized messages, tool calls, results, and exact requests stream back into the wake ledger.
5. While the process is alive, the supervisor renews its fenced lease. If renewal stops, recovery kills the recorded process before another wake can own the agent. Runner-specific plugins may add token, timeout, cost, or handoff policy.
6. A valid handoff atomically records the handoff, acknowledges consumed mail, delivers outgoing mail, and schedules the next wake. Local files and Git remain the runner's responsibility.
7. Any other exit is `abnormal`: after process death is confirmed, open tool calls receive synthetic `unknown` outcomes and the session closes as interrupted. A recovery wake receives the source event slice; unread mail remains available.

External actions follow their own state machine, independent of wake success:

```
requested ─▶ approved ─▶ dispatching ─▶ confirmed
                              │  └────▶ failed
                              ▼
                           unknown ──(query connector)──▶ confirmed / failed  (+ reconciled_at)
```

`unknown` is the honest state after a crash mid-dispatch: the side effect may or may not have happened. The default resolution is querying the connector, never re-dispatching — unless the connector's manifest declares native idempotency and opts into automatic retry.

## Distribution and source modules

Goah publishes one npm package: `@goah/cli`. The internal workspaces remain separate in source, but are bundled into that tarball, so one logical release produces one package version and one npm notification. Framework consumers use subpath exports such as `@goah/cli/kernel`, `@goah/cli/session`, `@goah/cli/sqlite`, and `@goah/cli/supervisor`.

| Source workspace | Public import | What it is |
|---|---|---|
| `ledger-contract` | `@goah/cli/kernel`, `/session`, `/execution`, `/metrics` | Generic event kernel, normalized Session vocabulary/replay, execution contracts, and optional metric policy. |
| `ledger-sqlite` | `@goah/cli/sqlite` | Single-writer SQLite ledger and rebuildable standard projections. |
| `supervisor` | `@goah/cli/supervisor` | Scheduler, wake lifecycle, Active Context, action gate, and connector dispatch. |
| `runner-pi` | `@goah/cli/runner-pi` | Pi adapter, process runner, normalized Session events, exact request snapshots, local tools, and compaction. |
| `testkit` | `@goah/cli/testkit` | Simulated clock, faux worker, connector, conformance suite, and fault injection. |
| `cli` | `@goah/cli` | Configuration, singleton daemon, status/doctor, goals, approvals, and dashboard. |

## Security model

Read this before pointing goah at anything real.

Mechanically enforced today:

- No external side effects by default: a connector must declare a capability for an action's kind, and non-dry-run connectors additionally require an explicit supervisor opt-in. Anything undeclared is gated, fail-closed.
- Runner and connector code executes in child processes with minimal environments. Connector secrets are explicitly scoped to that connector; runners never receive a ledger connection. Control state defaults to `~/.goah/state`, outside the runner root.
- The events table is append-only (enforced by SQLite triggers); invalid wake/action state transitions are rejected by both the library and the database.
- `request.prepared` records model-visible behavior but excludes provider API keys, authorization headers, abort handles, and transport-private objects.
- Recovery Active Context includes only the abnormal reason, interrupted/compaction markers, and tool calls with unknown outcomes; raw deltas and request snapshots remain in the ledger for explicit inspection.
- Every action evidence sequence must exist. Gated actions require an authorized approval carrying its own reason and evidence.
- Mail survives abnormal wakes, and unacknowledged audit advice is forced into the next context.
- An `unknown` action is never automatically re-dispatched unless the connector manifest explicitly declares native idempotency and automatic retry.

Not guaranteed, by design honesty:

- goah does not make the model's judgment correct. It records reasons and evidence; it cannot verify they are good reasons.
- goah does not defend against prompt injection inside the agent's own context.
- A runner with bash enabled is trusted local code and has the operating-system permissions of the user that launched it. GOAH does not sandbox arbitrary shell commands.

## Architecture status

| Milestone | Scope |
|---|---|
| v2 ledger kernel | ✅ stream-aware event schema, required/ignorable events, SQLite v1–v6 migration, transaction fault injection |
| replayable Session | ✅ format v1, legacy upgrader, normalized Pi messages/tools/requests, compaction facts, replay and interrupted-tool repair |
| Active Context | ✅ deterministic Markdown composition with evidence source sequences |
| execution modules | ✅ Goal/Wake/Schedule/Mailbox/Action/Handoff contracts are layered above the generic kernel; further physical package splitting is intentionally deferred |
| 2 — narrow closed loop | ✅ repo-guardian implementation complete; real unattended 14-day run still operational evidence |
| 3 — verification layer | ✅ verifier/global-audit interfaces, blind-first isolation and evaluation implemented; production calibration dataset remains operational work |
| 4 — multi-agent | ✅ concurrent agents, CEO context, mailbox and dashboard implemented; domain policies remain extension-owned |

## Design

The current architecture document (Chinese) is [`Goah-架构设计-v2.html`](./Goah-架构设计-v2.html). [`北辰-harness-设计稿.html`](./北辰-harness-设计稿.html) is preserved as the historical v0.10 proposal and links forward to v2. Decisions are recorded as ADRs in [`docs/adr/`](./docs/adr/).

## Contributing

The contracts are experimental and moving; issues and discussion are more useful than large PRs right now. Everything runs offline — `npm test` is the whole setup. If you change ledger semantics, add a fault-injection case proving the transaction boundary holds.

## License

[Apache-2.0](./LICENSE)
