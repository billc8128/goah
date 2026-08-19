# Changelog

## 0.3.0

- Replaced the wake-specific event envelope with generic `streamId` / `streamSeq` events.
- Added normalized Session event types, replay, request snapshots, and interrupted-session repair.
- Split kernel, execution, Session, and optional metric contracts into source modules.
- Removed mandatory Goal metric and target fields.

## 0.2.0

- Removed the preassigned workspace path from `RunRequest`; local execution is owned by the runner.
- Removed monetary goal budgets and the `budget.read` capability; domain policy is extension-owned.
- Removed `RunLimits` and mandatory token usage from the public runner contract.

## 0.1.0

- Experimental ledger, runner, load, handoff, metric, budget, and connector contracts.
