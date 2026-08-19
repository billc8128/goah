# Operating goah

`runSupervisorDaemon()` is the only resident process. Runner, metric, and connector code executes in child processes. Use the templates in `deploy/` with an explicit working directory, scoped provider credentials, and platform-side spending limits.

The repository guardian can be run once or supervised continuously:

```bash
npm run build
node examples/repo-guardian/dist/index.js
node examples/repo-guardian/dist/index.js --daemon
npm run soak:real
```

For a general installation, run `goah init --provider <provider> --model <id>`, then use `goah doctor`. Run `goah "<objective>"` to start the resident Supervisor when necessary and enter the interactive CEO; `goah --continue` reconnects later. Secret values use `env:NAME` references and are resolved only inside the resident process. The runner executes locally under the directory containing `goah.config.json`; every Pi Agent has read/write/edit/bash, while Git behavior belongs in the selected coding skill. Control state defaults to `~/.goah/state/<project-hash>` and can be relocated with `GOAH_STATE_HOME`. The interactive CLI and lower-level mutation commands use the Supervisor-owned local control socket rather than opening SQLite as a second writer.

Goal operators can inspect and revise lifecycle state with `goal-show`, `goal-update`, `goal-pause`, `goal-resume`, and `goal-complete`. Objective revisions replace or invalidate the textual observation method. `goal-complete` requires a reason and evidence from the current revision; it is terminal. A worker handoff never completes its own Goal automatically. In the interactive shell, `/goal ...` revises the root and `/observe ...` confirms its observation method through human authority.

Runner RPC is bidirectional but fenced by the active wake lease. Default child capabilities cover ledger search, mail, scheduling, actions, and advice acknowledgement. Only CEO profiles can write child goals; verifier/audit profiles can write audit advice.

Session inspection is read-only and does not resolve provider or connector secrets. Use `goah session list`, `session show`, `session replay`, `context show`, and `events --stream` to inspect the exact wake stream. `session export` writes a redacted `goah.session-export.v1` bundle by default; use `--raw` only when the destination is trusted because raw model requests and tool results may contain sensitive data.

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

Pi compaction defaults to 70% of the selected model's context window and retains a 20% recent tail. `GOAH_PI_COMPACT_AT_TOKENS` and `GOAH_PI_RETAIN_CONTEXT_TOKENS` are runner-specific overrides. The core defines no token, cost, timeout, or handoff-reserve policy; custom runners may implement their own. `ProcessRunner.timeoutMs` is an optional adapter-level timeout.

The automated test suite includes an accelerated 30-day simulation. This proves bounded Active Context, Session replay, and projection invariants under simulated time; it is not a substitute for a real wall-clock soak. `npm run soak:real` defaults to seven elapsed days and can be changed with `GOAH_SOAK_MS`. Preserve the resulting SQLite ledger and status dashboard as the auditable operating record.
