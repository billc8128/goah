import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadConfig, redactValue, SupervisorLock } from "./index.js";

const cli = fileURLToPath(new URL("./cli.js", import.meta.url));

function repository(): string {
  const directory = mkdtempSync(join(tmpdir(), "goah-cli-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "goah@example.test"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "GOAH Test"], { cwd: directory });
  execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: directory });
  return directory;
}

function invoke(directory: string, ...args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], { cwd: directory, encoding: "utf8", env: { ...process.env, GOAH_STATE_HOME: join(tmpdir(), "goah-cli-test-state") } });
}

test("CLI initializes versioned config, resolves secret references, and enforces singleton lock", () => {
  const directory = repository();
  invoke(directory, "init");
  const initialized = JSON.parse(readFileSync(join(directory, "goah.config.json"), "utf8"));
  assert.equal(initialized.version, 1);
  assert.equal(initialized.workspace, undefined);
  assert.equal(initialized.stateDir.startsWith(directory), false);
  assert.equal(initialized.limits, undefined);
  process.env.GOAH_CLI_TEST_KEY = "secret";
  const raw = JSON.parse(readFileSync(join(directory, "goah.config.json"), "utf8"));
  raw.runner.env.ANTHROPIC_API_KEY = "env:GOAH_CLI_TEST_KEY";
  writeFileSync(join(directory, "goah.config.json"), JSON.stringify(raw));
  assert.equal(loadConfig(join(directory, "goah.config.json")).runner.env?.ANTHROPIC_API_KEY, "secret");
  delete process.env.GOAH_CLI_TEST_KEY;
  const lock = new SupervisorLock(join(directory, ".goah")); lock.acquire();
  assert.throws(() => new SupervisorLock(join(directory, ".goah")).acquire(), /already running/);
  lock.release();
  const next = new SupervisorLock(join(directory, ".goah")); next.acquire(); next.release();
});

test("CLI runs the install-to-first-handoff path with the faux provider", () => {
  const directory = repository();
  invoke(directory, "init", "--provider", "faux", "--agent", "worker");
  const doctor = JSON.parse(invoke(directory, "doctor"));
  assert.equal(doctor.ok, true);
  assert.equal(doctor.checks.find((item: { name: string }) => item.name === "runner").detail.includes("faux/faux-goah"), true);
  const created = JSON.parse(invoke(directory, "goal-create", "--id", "first", "--owner", "worker", "--objective", "Complete the first handoff", "--wake-now"));
  assert.equal(created.goal.id, "first");
  assert.equal(created.wake.status, "queued");
  const run = JSON.parse(invoke(directory, "run-once"));
  assert.equal(run.wake.status, "done");
  const wakeId = run.wake.id;
  const status = JSON.parse(invoke(directory, "status"));
  assert.equal(status.goals[0].id, "first");
  assert.equal(status.wakes.length, 1);
  assert.equal(status.wakes[0].status, "done");
  assert.equal(status.modelCapabilities.provider, "faux");
  assert.equal(status.recentHandoffs.length, 1);
  const sessions = JSON.parse(invoke(directory, "session", "list"));
  assert.equal(sessions[0].wakeId, wakeId);
  assert.equal(sessions[0].sessionStatus, "completed");
  const detail = JSON.parse(invoke(directory, "session", "show", "--config", "goah.config.json", wakeId));
  assert.equal(detail.eventTypes["request.prepared"], 1);
  assert.ok(detail.replay.messageCount > 0);
  assert.equal(JSON.stringify(detail).includes("apiKey"), false);
  const context = JSON.parse(invoke(directory, "context", "show", wakeId));
  assert.match(context.text, /Complete the first handoff/);
  const events = JSON.parse(invoke(directory, "events", "--stream", `wake:${wakeId}`));
  assert.equal(events.at(-1).type, "wake.done");
  const exportedPath = join(directory, "session.json");
  const exported = JSON.parse(invoke(directory, "session", "export", wakeId, "--output", exportedPath));
  assert.equal(exported.redacted, true);
  assert.equal(JSON.parse(readFileSync(exportedPath, "utf8")).format, "goah.session-export.v1");
  const queued = JSON.parse(invoke(directory, "wake", "worker", "--reason", "manual follow-up"));
  assert.equal(queued.wake.status, "queued");
  assert.equal(JSON.parse(invoke(directory, "run-once")).wake.status, "done");
  assert.equal(JSON.parse(invoke(directory, "status")).wakes.length, 2);
});

test("CLI writes and diagnoses an explicit Ark model capability manifest", () => {
  const directory = repository();
  invoke(directory, "init", "--provider", "ark-coding", "--model", "glm-test", "--api-key-env", "GOAH_TEST_ARK_KEY", "--context-window-tokens", "256000", "--max-output-tokens", "32000");
  const raw = JSON.parse(readFileSync(join(directory, "goah.config.json"), "utf8"));
  assert.equal(raw.runner.env.ARK_API_KEY, "env:GOAH_TEST_ARK_KEY");
  assert.deepEqual(JSON.parse(raw.runner.env.GOAH_PI_MODEL_CAPABILITIES), { contextWindowTokens: 256_000, maxOutputTokensPerTurn: 32_000 });
  const missing = spawnSync(process.execPath, [cli, "doctor"], { cwd: directory, encoding: "utf8", env: { ...process.env, GOAH_STATE_HOME: join(tmpdir(), "goah-cli-test-state") } });
  assert.equal(missing.status, 1);
  const missingResult = JSON.parse(missing.stdout);
  assert.equal(missingResult.ok, false);
  assert.match(missingResult.checks.find((item: { name: string }) => item.name === "runner").detail, /GOAH_TEST_ARK_KEY/);
  assert.deepEqual(JSON.parse(invoke(directory, "session", "list")), []);
  process.env.GOAH_TEST_ARK_KEY = "secret";
  try {
    const doctor = JSON.parse(invoke(directory, "doctor"));
    assert.equal(doctor.ok, true);
    assert.match(doctor.checks.find((item: { name: string }) => item.name === "runner").detail, /context=256000 output=32000/);
  } finally {
    delete process.env.GOAH_TEST_ARK_KEY;
  }
});

test("session export redaction preserves structure while removing common secrets and home paths", () => {
  const redacted = redactValue({ token: "top-secret", nested: { text: `Bearer abcdef /Users/example key-abcdefghijklmnop ${process.env.HOME}` } }) as { token: string; nested: { text: string } };
  assert.equal(redacted.token, "[REDACTED]");
  assert.doesNotMatch(redacted.nested.text, /abcdef|abcdefghijklmnop/);
  if (process.env.HOME) assert.doesNotMatch(redacted.nested.text, new RegExp(process.env.HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("CLI runs a local operations goal without Git", () => {
  const directory = mkdtempSync(join(tmpdir(), "goah-operations-"));
  invoke(directory, "init", "--provider", "faux", "--agent", "operator");
  const doctor = JSON.parse(invoke(directory, "doctor"));
  assert.equal(doctor.ok, true);
  assert.match(doctor.checks.find((item: { name: string }) => item.name === "root").detail, /runner-owned local execution/);
  invoke(directory, "goal-create", "--id", "store", "--owner", "operator", "--objective", "Open a storefront", "--wake-now");
  assert.equal(JSON.parse(invoke(directory, "run-once")).wake.status, "done");
  assert.equal(JSON.parse(invoke(directory, "status")).wakes.length, 1);
});
