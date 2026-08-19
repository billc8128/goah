# Changelog

## 0.5.0

- Added durable textual Goal observation methods with SQLite schema v8 migration, root human confirmation, atomic child delegation, revision invalidation, replay, and evidence-backed completion.
- Added a root-revision barrier that prevents stale child Goals from submitting new gated actions until CEO revises their objective/observation-method pair.
- Every Pi Agent now receives the `read`, `write`, `edit`, and `bash` coding baseline plus `handoff`; Goah control tools remain role-scoped.
- Added filesystem-first CEO onboarding policy and Active Context sections for observation methods and revision barriers.
- Added a resident Supervisor local control socket and interactive `goah` shell, including live goal revisions and observation confirmation while the daemon owns SQLite.

## 0.4.0

- Added the CEO Agent Operating Layer as the sole normal user entry: `goal start`, `ceo send/status/inbox/approve`, automatic CEO wakes, and a built-in operating policy.
- Added ledger-derived team rosters and role-filtered Pi tools for atomic delegation, reassignment, child lifecycle control, and human decision requests.
- Delegation now commits its event, child Goal, decision mail, and queued Wake in one SQLite transaction; reassignment is idempotent and suppresses stale owner motion.
- Added CEO motion validation, child material/blocker/exhaustion triggers, root-completion descendant checks, recovery injection, and a deterministic two-child organization canary.
- Added revisioned Goal show/update/pause/resume/complete commands and mechanical phase transitions.
- Added Session format v1, an in-memory v0 upgrader, future-version refusal, and required-vs-ignorable unknown event semantics.
- SQLite schema v7 persists the event `ignorable` marker and enforces Goal phases in SQL.

## 0.3.1

- Added read-only Session list/show/replay/context/events inspection and redacted audit exports.
- Request snapshots now use a behavior-only allowlist and never persist provider credentials or abort handles.
- Recovery Active Context now selects only actionable failure facts instead of expanding raw deltas and request snapshots.

## 0.3.0

- Split the generic ledger kernel from standard execution modules.
- Added global and per-stream event ordering, normalized replayable Session events, exact request snapshots, interrupted-tool repair, and deterministic Active Context Markdown.
- Removed mandatory Goal metrics and targets; metric contracts are now optional registrations.
- Added SQLite schema v6 migrations and Goah architecture design v2.
- Consolidated npm delivery into one `@goah/cli` tarball with public framework subpath exports.

## 0.1.0 — 2026-08-19

- Initial experimental GOAH contracts and SQLite schema v3.
- Durable wake/action/mail/audit semantics, process isolation, Pi worker, compaction, metrics, budgets, verification, multi-agent daemon, dashboard, and repo-guardian example.
- Bidirectional role-scoped RPC, executable CEO/verifier roles, generic CLI/configuration, singleton daemon controls, and workspace-ref recovery.
