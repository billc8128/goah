# Changelog

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
