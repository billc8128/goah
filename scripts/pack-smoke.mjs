import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const temp = mkdtempSync(join(tmpdir(), "goah-pack-"));
const artifacts = join(temp, "artifacts");
const app = join(temp, "app");
mkdirSync(artifacts); mkdirSync(app);

const packed = JSON.parse(execFileSync("npm", ["pack", "--workspace", "packages/cli", "--pack-destination", artifacts, "--json"], { cwd: root, encoding: "utf8" }));
const tarball = join(artifacts, packed[0].filename);
if (packed[0].bundled?.length !== 5) throw new Error(`single distribution omitted internal modules: ${JSON.stringify(packed[0].bundled)}`);

writeFileSync(join(app, "package.json"), `${JSON.stringify({ name: "goah-install-smoke", private: true, version: "1.0.0" }, null, 2)}\n`);
execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: app, stdio: "pipe" });
execFileSync(process.execPath, ["--input-type=module", "-e", `
  const modules = await Promise.all([
    import('@goah/cli/kernel'), import('@goah/cli/session'), import('@goah/cli/execution'), import('@goah/cli/metrics'),
    import('@goah/cli/sqlite'), import('@goah/cli/supervisor'), import('@goah/cli/runner-pi'), import('@goah/cli/testkit')
  ]);
  const names = ['controlStream','replaySession','assertHandoff','evaluateMetric','SqliteLedger','Supervisor','ProcessRunner','SimulatedClock'];
  for (let index = 0; index < names.length; index += 1) if (typeof modules[index][names[index]] !== 'function') throw new Error('missing public subpath export: '+names[index]);
`], { cwd: app, stdio: "pipe" });
execFileSync("git", ["init", "-b", "main"], { cwd: app });
execFileSync("git", ["config", "user.email", "goah-pack@example.test"], { cwd: app });
execFileSync("git", ["config", "user.name", "GOAH Pack Test"], { cwd: app });
execFileSync("git", ["add", "package.json", "package-lock.json"], { cwd: app });
execFileSync("git", ["commit", "-m", "initial"], { cwd: app });

const bin = join(app, "node_modules", ".bin", process.platform === "win32" ? "goah.cmd" : "goah");
const run = (...args) => execFileSync(bin, args, { cwd: app, encoding: "utf8" });
run("init", "--provider", "faux", "--agent", "worker");
const doctor = JSON.parse(run("doctor"));
if (!doctor.ok) throw new Error(`packed CLI doctor failed: ${JSON.stringify(doctor)}`);
run("goal-create", "--id", "pack-smoke", "--owner", "worker", "--objective", "Prove the installed CLI works", "--wake-now");
const wake = JSON.parse(run("run-once")).wake;
const status = JSON.parse(run("status"));
if (wake?.status !== "done" || status.wakes?.length !== 1 || status.recentHandoffs?.length !== 1) throw new Error("packed CLI did not complete the first handoff");
const sessions = JSON.parse(run("session", "list"));
const detail = JSON.parse(run("session", "show", wake.id));
const exported = join(app, "session.json");
run("session", "export", wake.id, "--output", exported);
if (sessions[0]?.wakeId !== wake.id || sessions[0]?.formatVersion !== 1 || detail.eventTypes?.["request.prepared"] !== 1 || JSON.parse(readFileSync(exported, "utf8")).redacted !== true) throw new Error("packed CLI session inspector failed");
run("goal-show", "pack-smoke");
run("goal-pause", "pack-smoke");
run("goal-resume", "pack-smoke");
const completedGoal = JSON.parse(run("goal-complete", "pack-smoke")).goal;
if (completedGoal.phase !== "complete" || completedGoal.revision !== 3) throw new Error("packed CLI goal lifecycle failed");

process.stdout.write(`${JSON.stringify({ ok: true, app, packages: 1, bundledModules: packed[0].bundled.length, wake: wake.id }, null, 2)}\n`);
