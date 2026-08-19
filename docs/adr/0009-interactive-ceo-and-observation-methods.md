# ADR 0009: Interactive CEO and durable Goal observation methods

Status: accepted
Date: 2026-08-20

## Context

An objective alone does not preserve how separately reconstructed Agent Sessions should inspect reality. Quantitative goals can drift in data source or calculation; qualitative goals can drift in acceptance criteria. The lower-level CLI also could not mutate state while the resident Supervisor held the singleton lock, and the Pi worker exposed an inconsistent local tool surface across roles.

## Decision

- `GoalSnapshot` adds nullable textual `observationMethod`; SQLite schema v8 stores it in the existing Goal projection.
- A new root begins with a null method. CEO explores the current directory and proposes a method; only human root authority confirms it.
- Atomic delegation requires each child objective and non-empty observation method together with mail and wake.
- Objective revisions replace or invalidate the method. Child Goals older than the latest root revision cannot submit gated actions until CEO revises the pair.
- Completion requires a reason and Ledger evidence newer than the current Goal revision event.
- Every Pi Agent receives `read`, `write`, `edit`, and `bash`; role capabilities only filter Goah control tools.
- `goah` starts or attaches an interactive CEO through a local Supervisor-owned control socket. The Supervisor remains the only SQLite writer.
- Filesystem-readable configuration is discovered with ordinary coding tools; no mirror `capability.list`, `connector.list`, or `metric.list` RPC is introduced.

## Consequences

Observation methods remain general enough for scripts, queries, checklists, artifact inspection, and human confirmation without making numeric metrics mandatory. Existing schema-v7 Goals migrate with a null method and must be operationalized before evidence-backed completion. The local shell is a client of the resident process rather than a second scheduler or message service.
