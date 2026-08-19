# ADR 0005: Runner policy is extension-owned; leases slide

- Status: accepted
- Date: 2026-08-19

## Decision

The public `RunRequest` and `RunnerResult` do not contain token limits, wall-clock limits, handoff reserves, cost limits, or mandatory usage accounting. These policies are runner-specific. `ProcessRunner.timeoutMs` remains an optional adapter setting, and Pi compaction remains inside the Pi package.

Wake leases are a control-plane ownership primitive, not a task-duration policy. The supervisor periodically renews the lease while a runner is alive. If the supervisor or renewal loop dies, the lease expires; recovery terminates the recorded process before making the wake abnormal or allowing later ownership.

This supersedes the fixed per-wake limit and handoff-reserve decision in ADR 0001. A runner that exits without a valid handoff is still abnormal, but GOAH does not prescribe why or when a runner must stop.
