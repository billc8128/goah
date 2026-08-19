import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "packages", "cli");
const modules = join(cli, "node_modules");
const workspaces = ["ledger-contract", "ledger-sqlite", "runner-pi", "supervisor", "testkit"];

mkdirSync(modules, { recursive: true });
for (const workspace of workspaces) {
  const source = join(root, "packages", workspace);
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  const target = join(modules, manifest.name);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(join(source, "dist"), join(target, "dist"), { recursive: true });
  writeFileSync(join(target, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}
chmodSync(join(cli, "dist", "cli.js"), 0o755);
