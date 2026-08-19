# ADR 0006: Separate the ledger kernel, replayable sessions, and active context

Status: accepted

## Context

The original design used one `EventRecord` and one `Ledger` interface for event storage, Goal metrics, wake scheduling, mailbox delivery, actions, runner traces, roles, and connector policy. Pi traces were durable but retained Pi's private event shapes, so the ledger could audit a wake without promising that it could reconstruct the exact model-visible conversation. The load path handed structured JSON to the runner and relied on handoff as the primary semantic compression.

This made the framework core look like one particular organization design. It also left a gap between the statement that events are the source of truth and the absence of a versioned Session replay contract.

## Decision

Goah 0.3 introduces three logical layers without adding a service boundary:

1. The ledger kernel owns generic typed events, a global sequence, a contiguous per-stream sequence, append/read operations, and persistence. It does not know standard projection names.
2. Session runtime normalizes runner events into Goah-owned message, tool, request, compaction, and terminal events. `replaySession()` derives model-visible messages. Recovery closes open tool calls with an explicit `unknown` result.
3. Execution modules own Goal, Wake, Schedule, Mailbox, Action, and Handoff semantics. Their SQLite projections remain transactionally updated with the source event in the default implementation.

Supervisor builds an ephemeral Active Context View by deterministically rendering structured projections to Markdown. The composer does not call a model. The runner records the exact rendered context, system prompt, messages, tools, and behavior-affecting model configuration in `request.prepared` immediately before dispatch. Authentication values, authorization headers, abort handles, and transport-private objects are excluded mechanically.

Goal no longer requires a metric or target. Applications may register a metric contract and collector independently.

The layers remain source modules and public contract sections inside the existing packages. We do not introduce a general plugin framework, message queue, cache, or second resident service.

## Consequences

- One wake is one Session stream by default. Cross-wake continuity uses durable Goal, Handoff, Mailbox, Action, and Active Context rather than silently resuming a provider thread.
- Raw deltas remain auditable while completed messages drive conversation replay.
- Compaction changes only the active surface; original events remain immutable.
- The SQLite schema moves to version 6 and migrates versions 1 through 5.
- `EventRecord`, Goal, runner trace, metric registration, and connector contract versions are breaking changes, so all packages move in lockstep to 0.3.0.
- The five standard projections still exist physically for indexed claims and state-machine constraints, but they no longer define the generic ledger kernel.
