import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { ActionSnapshot } from "@goah/ledger-contract";

const execFileAsync = promisify(execFile);
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const request = JSON.parse(line) as { operation: "dispatch" | "query"; action: ActionSnapshot };
  const repo = process.env.GOAH_GUARD_REPO ?? process.cwd();
  const command = String((request.action.payload as Record<string, unknown>).command ?? "git status --porcelain");
  try {
    const result = await execFileAsync("/bin/sh", ["-lc", command], { cwd: repo, timeout: 300_000, maxBuffer: 2_000_000 });
    process.stdout.write(JSON.stringify({ status: "confirmed", externalRef: `${request.action.id}:${Buffer.from(result.stdout).toString("base64url").slice(0, 24)}` }));
  } catch { process.stdout.write(JSON.stringify({ status: "failed" })); }
}
