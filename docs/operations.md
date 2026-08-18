# Operating goah

`runSupervisorDaemon()` is the only resident process. Runner, metric, and connector code executes in child processes. Use the templates in `deploy/` with an explicit working directory, scoped provider credentials, and platform-side spending limits.

The repository guardian can be run once or supervised continuously:

```bash
npm run build
node examples/repo-guardian/dist/index.js
node examples/repo-guardian/dist/index.js --daemon
npm run soak:real
```

For a general installation, run `goah init`, edit the generated `goah.config.json`, then use `goah doctor` and `goah start`. Secret values use `env:NAME` references and are resolved only when the process spec is created. Human controls include goal creation, action approval/rejection, dashboard generation, and `workspace-inspect`, `workspace-recover`, and guarded `workspace-discard` commands.

Runner RPC is bidirectional but fenced by the active wake lease. Default child capabilities cover ledger search, budget reads, mail, scheduling, actions, and advice acknowledgement. Only CEO profiles can write child goals; verifier/audit profiles can write audit advice.

Set `GOAH_GUARD_REPO`, `GOAH_GUARD_STATE`, and optionally `GOAH_GUARD_TEST_COMMAND`. To use a real Pi worker, explicitly pass `GOAH_PI_MODEL`, `GOAH_PI_PROVIDER`, and the matching provider key. Without them the example uses the faux process worker and has no network dependency.

The automated test suite includes an accelerated 30-day simulation. This proves bounded reconstructed context and replay invariants under simulated time; it is not a substitute for the milestone's real 7/14-day wall-clock soak. `npm run soak:real` defaults to seven elapsed days and can be changed with `GOAH_SOAK_MS`. Preserve the resulting SQLite ledger and `.goah/status.html` as the auditable operating record.
