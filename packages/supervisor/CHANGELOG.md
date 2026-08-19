# Changelog

## 0.3.0

- Added deterministic Markdown Active Context composition with evidence source sequences.
- Repairs interrupted Session tool calls as unknown before scheduling recovery.
- Metric policy is registered independently of Goal.

## 0.2.0

- Removed workspace/Git lifecycle management and monetary budget policy from the supervisor; abnormal recovery preserves control state only.
- Added sliding wake-lease renewal while a runner process is alive.

## 0.1.0

- Scheduler, daemon, metrics, watchdog, action gate, verification plane, multi-agent contexts, and dashboard.
