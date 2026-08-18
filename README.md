# goah

**Goal-Oriented Agent Harness.** Agents handle tasks; goah holds the goal.

goah is an open-source framework for building long-running, accountable agent systems. It provides an event-sourced ledger, wake scheduling and recovery, bounded handoffs, connector safety semantics, and Git-backed artifact continuity above task-level agent runners.

The current implementation covers the runnable Milestone 0/1A vertical slice: one append-only event source, five rebuildable projections, wake/action failure semantics, a single-writer supervisor, faux runner, simulated connector, and Git worktree recovery.

```bash
npm install
npm test
npm run example
```

默认无外部密钥、connector fail-closed、wake token 与 wall-clock 硬上限开启。agent runner 只拿装载上下文和 workspace 路径，不拿 SQLite 连接或 connector 密钥。

The original v0.10 architecture source is [`北辰-harness-设计稿.html`](./北辰-harness-设计稿.html). Milestone 0 decisions are recorded in [`docs/adr/0001-milestone-0-semantics.md`](./docs/adr/0001-milestone-0-semantics.md).

Licensed under Apache-2.0.
