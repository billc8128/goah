# ADR 0004: Domain policy stays outside the core

- Status: accepted
- Date: 2026-08-19

## Decision

Goals do not contain a monetary budget contract. The core does not define currencies, spend limits, day/month accounting windows, or action payload amount fields. These concepts belong to connector packages, policy extensions, or downstream applications.

The action state machine remains generic: reason, evidence, approval gate, dispatch, unknown, reconciliation, confirmed, and failed. Extensions can enforce finance, advertising, procurement, quota, or compliance policy before approval without changing the ledger contract.

Connector manifests likewise do not predefine account, environment, currency, or amount constraints. They declare only idempotency/query/retry behavior and whether an action is reversible, gated, or irreversible. Connector implementations and policy extensions own payload validation.

Per-wake token, cost, timeout, and handoff-reserve policy are also outside the core request/result contract. A runner adapter may implement them when appropriate.

SQLite schema v5 removes the legacy `goals.budget` projection column. Migration reads old goals and preserves every non-budget field without rewriting event history.
