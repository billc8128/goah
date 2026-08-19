import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modules = join(root, "packages", "cli", "node_modules");
for (const workspace of ["ledger-contract", "ledger-sqlite", "runner-pi", "supervisor", "testkit"]) {
  const manifest = JSON.parse(readFileSync(join(root, "packages", workspace, "package.json"), "utf8"));
  rmSync(join(modules, manifest.name), { recursive: true, force: true });
}
