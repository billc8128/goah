import { spawn } from "node:child_process";

const durationMs = Number(process.env.GOAH_SOAK_MS ?? 7 * 24 * 60 * 60 * 1_000);
const child = spawn(process.execPath, ["examples/repo-guardian/dist/index.js", "--daemon"], { env: process.env, stdio: "inherit" });
const stop = () => { if (!child.killed) child.kill("SIGTERM"); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const timer = setTimeout(stop, durationMs);
const code = await new Promise((resolve) => child.once("exit", (value) => resolve(value ?? 1)));
clearTimeout(timer);
process.exitCode = code;
