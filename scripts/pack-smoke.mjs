import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const temp = mkdtempSync(join(tmpdir(), "goah-pack-"));
const artifacts = join(temp, "artifacts");
const app = join(temp, "app");
mkdirSync(artifacts); mkdirSync(app);

const workspaces = [
  "packages/ledger-contract",
  "packages/ledger-sqlite",
  "packages/runner-pi",
  "packages/supervisor",
  "packages/testkit",
  "packages/cli",
];
const tarballs = workspaces.map((workspace) => {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--workspace", workspace, "--pack-destination", artifacts, "--json"], { cwd: root, encoding: "utf8" }));
  return join(artifacts, packed[0].filename);
});

writeFileSync(join(app, "package.json"), `${JSON.stringify({ name: "goah-install-smoke", private: true, version: "1.0.0" }, null, 2)}\n`);
execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], { cwd: app, stdio: "pipe" });
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

process.stdout.write(`${JSON.stringify({ ok: true, app, packages: tarballs.length, wake: wake.id }, null, 2)}\n`);
