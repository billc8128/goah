import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PiRunnerAdapter } from "@goah/runner-pi";
import { GitWorkspaceManager, Supervisor } from "@goah/supervisor";
import { createMemoryLedger, FauxPiDriver, SimulatedClock } from "@goah/testkit";

const clock = new SimulatedClock();
const ledger = createMemoryLedger();
const repo = mkdtempSync(join(tmpdir(), "goah-example-"));
runGit(["init", "-b", "main"]);
runGit(["config", "user.email", "goah@example.test"]);
runGit(["config", "user.name", "GOAH Example"]);
writeFileSync(join(repo, "README.md"), "# example artifact workspace\n");
runGit(["add", "README.md"]);
runGit(["commit", "-m", "initial"]);

const faux = new FauxPiDriver(clock, [[
  { tokens: 100, write: { path: "result.txt", content: "north star reached\n" } },
  { tokens: 50, handoff: { handoff: { observations: ["goal loaded"], results: ["result committed"], nextSteps: [] }, mail: [], nextWakeAt: null } },
]]);
const supervisor = new Supervisor(ledger, new PiRunnerAdapter(faux), clock, { workspace: new GitWorkspaceManager(repo) });
supervisor.createGoal({
  id: "root", parentId: null, objective: "produce one durable artifact",
  metric: { source: "workspace", window: "wake", direction: "at_least", target: 1, freshnessMs: 60_000, onMissing: "abnormal", onStale: "wake_owner" },
  target: 1, owner: "worker", budget: null, phase: "active", revision: 0,
});
supervisor.planWake("worker", clock.now().toISOString(), "initial plan");
const wake = await supervisor.tick();
console.log(JSON.stringify({ wake: wake?.status, workspace: repo, events: ledger.events().length }, null, 2));
ledger.close();

function runGit(args: string[]): void {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}
