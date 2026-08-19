# ADR 0008: Version Session vocabulary and complete the Goal lifecycle

Status: accepted

## Context

Goah 0.3 could replay its normalized Session events, but the durable stream did not declare a format version. A future event-shape change therefore had no mechanical upgrade or refusal boundary. Unknown Session-namespaced events were silently ignored because the same stream also contains Wake and Handoff facts.

Goal storage already carried `phase` and `revision`, but `phase` was an unconstrained string and the CLI exposed only create/list. A finished real canary therefore produced a final report while its Goal remained active.

## Decision

Session streams now declare `formatVersion: 1` in `session.started`. Readers pass the complete stream through `upgradeSessionEvents()` before replay:

- an absent version is legacy format 0 and upgrades in memory to format 1;
- source events are never rewritten;
- a future format fails with `SessionFormatUnsupportedError` and directs the operator to upgrade the harness;
- an unknown required event in the Session namespace fails with `SessionEventUnsupportedError`;
- an event explicitly carrying `ignorable: true` may be skipped by an unfamiliar reader;
- missing/multiple starts, invalid versions, and stream gaps are corruption.

The generic event envelope gains the optional `ignorable` marker. SQLite schema 7 persists it and migrates schemas 1 through 6.

Goal phases are the closed union `active | paused | blocked | complete`. Contract code and SQLite triggers enforce:

- active → paused, blocked, complete
- paused → active, complete
- blocked → active, complete
- complete is terminal

Objective and owner edits retain phase and increment revision. CLI commands cover show, update, pause, resume, and complete. Existing parent authority and CAS rules continue to apply.

## Consequences

- Goah 0.4 can evolve Session vocabulary without silently replaying an incomplete history.
- Existing Goah 0.3 Session streams remain readable as format 0 and are not rewritten during database migration.
- Informational extensions must opt into skip safety; required is the default.
- A parent/human must explicitly complete a Goal; a worker handoff cannot rewrite its own purpose.
- The SQLite schema moves to version 7 and the public contract to 0.4.0.
