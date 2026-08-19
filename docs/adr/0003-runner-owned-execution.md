# ADR 0003: Local execution belongs to the runner

- Status: accepted
- Date: 2026-08-19

## Decision

The GOAH core does not model workspaces, artifacts, files, Git, or domain-specific monetary budgets. The supervisor owns control state only: goals, wakes, leases, process lifetime, actions, mail, and handoffs.

Each process runner executes under a local root chosen by its configuration. File, bash, and Git behavior belongs to the runner and its skills. Coding agents may create repositories, branches, commits, or worktrees directly; operational agents can ignore the filesystem entirely.

GOAH guarantees that an expired runner process is terminated before recovery and that abnormal state, unread mail, and the recovery event slice remain durable. It does not guarantee Git merge, conflict handling, or salvage refs. Partial local files remain in the runner root for the next wake or a human to inspect.

This supersedes the Git/workspace ownership decisions in ADR 0001 and ADR 0002. The legacy `merge_blocked` status remains readable for schema compatibility but is not produced by the reference supervisor.
