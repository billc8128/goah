import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runProcessWorker } from "goah-runner-pi";
import type { JsonValue, RunnerResult, WakeOutput } from "goah-ledger-contract";

interface WorkerStep {
  tokens: number;
  trace?: Array<{ kind: string; data: JsonValue }>;
  write?: { path: string; content: string };
  handoff?: WakeOutput;
  crash?: string;
  hang?: boolean;
  delayMs?: number;
  rpc?: { method: import("goah-ledger-contract").AgentCapability; params: JsonValue };
}

await runProcessWorker(async (request, emit, rpc): Promise<RunnerResult> => {
  if (process.env.GOAH_FAUX_CONTEXT_FILE) writeFileSync(process.env.GOAH_FAUX_CONTEXT_FILE, JSON.stringify(request.context));
  const steps = JSON.parse(process.env.GOAH_FAUX_STEPS ?? "[]") as WorkerStep[];
  let tokensUsed = 0;
  for (const step of steps) {
    if (step.write) {
      const path = join(process.cwd(), step.write.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, step.write.content);
    }
    for (const trace of step.trace ?? []) emit(trace);
    if (step.rpc) emit({ kind: "rpc.result", data: await rpc(step.rpc.method, step.rpc.params) });
    tokensUsed += step.tokens;
    if (step.crash) throw new Error(step.crash);
    if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
    if (step.hang) await new Promise(() => undefined);
    if (step.handoff) return { outcome: "handoff", output: step.handoff, tokensUsed };
  }
  return { outcome: "abnormal", reason: "faux worker stopped without handoff", tokensUsed };
});
