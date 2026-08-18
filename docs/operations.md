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

Ark Coding Plan uses the Responses-compatible `ark-coding` provider. Use `arkcli resources list --modality text` to select a concrete model ID (`auto` is an ArkCLI-side alias and is not sent directly to the API), then inject the plan key only into the supervisor process:

```bash
ARK_API_KEY=... \
GOAH_PI_PROVIDER=ark-coding \
GOAH_PI_MODEL=glm-5.2 \
GOAH_GUARD_REPO=/path/to/repository \
GOAH_GUARD_TEST_COMMAND='npm test' \
npm run example:guardian
```

`GOAH_PI_BASE_URL` overrides the default `https://ark.cn-beijing.volces.com/api/coding/v3` endpoint. The runner process receives only the explicit environment above; it does not read ArkCLI profiles or inherit unrelated supervisor secrets.

The automated test suite includes an accelerated 30-day simulation. This proves bounded reconstructed context and replay invariants under simulated time; it is not a substitute for the milestone's real 7/14-day wall-clock soak. `npm run soak:real` defaults to seven elapsed days and can be changed with `GOAH_SOAK_MS`. Preserve the resulting SQLite ledger and `.goah/status.html` as the auditable operating record.
