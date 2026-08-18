# ADR 0002: Goal-layer completion semantics

- Status: accepted
- Date: 2026-08-19

## Decisions

1. Metrics remain append-only events rather than a seventh projection. A metric contract mechanically handles missing data, freshness, direction, sustain windows, and guardrails; missed/stale samples create owner wakes.
2. An agent owns at most one active budgeted goal in the reference implementation. `approved`, `dispatching`, and `unknown` amounts are reserved; `confirmed` is actual spend; `failed` releases exposure. Goal/day/month windows use the action-request event timestamp.
3. Simultaneous schedule, mail, metric, and watchdog triggers for one agent coalesce into its oldest queued wake. The context consumes all current increments.
4. Pi is pinned at 0.84.2. `transformContext` compacts only the provider view; the agent transcript and ledger trace remain unchanged. The first authoritative wake context and recent turns remain visible.
5. Session verification and global audit share an interface but not inputs. Global audit first receives facts with handoffs, notes, action reasons, and evidence claims removed; reasons are revealed only in phase two.
6. The supervisor daemon may run different agents concurrently, while `GitWorkspaceManager` serializes all rebase/merge operations.
7. Calendar-duration soak and real-money operation are evidence-producing deployment activities, not facts that a unit test may claim. The repository supplies daemon templates, an accelerated soak, and a repo-guardian app; operators must publish real elapsed-time evidence separately.
