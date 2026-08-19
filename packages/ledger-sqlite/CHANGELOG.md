# Changelog

## 0.5.0

- Added SQLite schema v8 observation methods, migration/replay support, atomic method delegation, and current-revision completion evidence.

## 0.4.0

- Schema v7 persists `EventRecord.ignorable` and adds SQL Goal phase checks/transitions.
- Migrates schema v6 without rewriting event identity or payload history.

## 0.3.0

- Added SQLite schema v6 with global and per-stream event order.
- Migrates schema versions 1 through 5 while preserving event sequence identities.
- Removed Goal metric/target columns and kept standard execution projections transactionally coupled to events.

## 0.2.0

- Schema v5 removes the legacy goal budget column while preserving old goal projections during migration.

## 0.1.0

- SQLite schema v3, WAL, FTS5, explicit migrations, projections, fencing, budgets, and conformance.
