import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { ActionSnapshot } from "@goah/ledger-contract";

const statePath = process.env.GOAH_MOCK_CONNECTOR_STATE;
if (!statePath) throw new Error("GOAH_MOCK_CONNECTOR_STATE is required");
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const request = JSON.parse(line) as { operation: "dispatch" | "query"; action: ActionSnapshot };
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { dispatched: string[]; failAfterEffect: boolean };
  if (request.operation === "dispatch") {
    if (!state.dispatched.includes(request.action.id)) state.dispatched.push(request.action.id);
    if (state.failAfterEffect) {
      state.failAfterEffect = false;
      writeFileSync(statePath, JSON.stringify(state));
      process.stderr.write("injected connector crash after side effect\n");
      process.exitCode = 1;
      break;
    }
    writeFileSync(statePath, JSON.stringify(state));
    process.stdout.write(JSON.stringify({ status: "confirmed", externalRef: `mock:${request.action.id}` }));
  } else {
    process.stdout.write(JSON.stringify(state.dispatched.includes(request.action.id)
      ? { status: "confirmed", externalRef: `mock:${request.action.id}` }
      : { status: "failed" }));
  }
}
