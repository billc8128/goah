# Operating goah

`runSupervisorDaemon()` is the only resident process. Runner, metric, and connector code executes in child processes. Use the templates in `deploy/` with an explicit working directory, scoped provider credentials, and platform-side spending limits.

The repository guardian can be run once or supervised continuously:

```bash
npm run build
node examples/repo-guardian/dist/index.js
node examples/repo-guardian/dist/index.js --daemon
npm run soak:real
```

For a general installation, run `goah init --provider <provider> --model <id>`, then use `goah doctor`. The first bounded path is `goal-create --wake-now` followed by `run-once` and `status`; use `goah start` only after that succeeds. Secret values use `env:NAME` references and are resolved only when the process spec is created. The runner executes locally under the directory containing `goah.config.json`; Git behavior belongs in the selected coding skill. Control state defaults to `~/.goah/state/<project-hash>` and can be relocated with `GOAH_STATE_HOME`. Human controls include manual `wake`, goal creation, action approval/rejection, and dashboard generation.

Runner RPC is bidirectional but fenced by the active wake lease. Default child capabilities cover ledger search, budget reads, mail, scheduling, actions, and advice acknowledgement. Only CEO profiles can write child goals; verifier/audit profiles can write audit advice.

Set `GOAH_GUARD_REPO`, `GOAH_GUARD_STATE`, and optionally `GOAH_GUARD_TEST_COMMAND`. To use a real Pi worker, explicitly pass `GOAH_PI_MODEL`, `GOAH_PI_PROVIDER`, and the matching provider key. Without them the example uses the faux process worker and has no network dependency.

Ark Coding Plan uses the Responses-compatible `ark-coding` provider. Use `arkcli resources list --modality text` to select a concrete model ID (`auto` is an ArkCLI-side alias and is not sent directly to the API), then inject the plan key only into the supervisor process:

```bash
# Replace the capability values below with those published for your selected model.
ARK_API_KEY=... \
GOAH_PI_PROVIDER=ark-coding \
GOAH_PI_MODEL=glm-5.2 \
GOAH_PI_MODEL_CAPABILITIES='{"contextWindowTokens":256000,"maxOutputTokensPerTurn":32000}' \
GOAH_GUARD_REPO=/path/to/repository \
GOAH_GUARD_TEST_COMMAND='npm test' \
npm run example:guardian
```

`GOAH_PI_BASE_URL` overrides the default `https://ark.cn-beijing.volces.com/api/coding/v3` endpoint. Ark's model-list response does not expose context/output limits, so its capability manifest is mandatory and should use the limits published for the selected model. Pi's built-in providers read these values directly from their model manifests. The runner process receives only the explicit environment above; it does not read ArkCLI profiles or inherit unrelated supervisor secrets.

Compaction defaults to 70% of the selected model's context window and retains a 20% recent tail. `GOAH_PI_COMPACT_AT_TOKENS` and `GOAH_PI_RETAIN_CONTEXT_TOKENS` are explicit overrides. These context limits are independent from the supervisor's per-wake policy: `maxTotalTokens` defaults to 2,000,000, with 96,000 reserved for handoff and a 60-minute wall-clock limit.

The automated test suite includes an accelerated 30-day simulation. This proves bounded reconstructed context and replay invariants under simulated time; it is not a substitute for the milestone's real 7/14-day wall-clock soak. `npm run soak:real` defaults to seven elapsed days and can be changed with `GOAH_SOAK_MS`. Preserve the resulting SQLite ledger and `.goah/status.html` as the auditable operating record.
