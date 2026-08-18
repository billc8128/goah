import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const request = JSON.parse(line) as { goalId: string };
  const repo = process.env.GOAH_GUARD_REPO ?? process.cwd();
  const command = process.env.GOAH_GUARD_TEST_COMMAND ?? "npm test";
  let value = 0;
  try { await execFileAsync("/bin/sh", ["-lc", command], { cwd: repo, timeout: 300_000, maxBuffer: 2_000_000 }); value = 1; } catch {}
  process.stdout.write(JSON.stringify({ goalId: request.goalId, source: "repo.tests", observedAt: new Date().toISOString(), value }));
}
