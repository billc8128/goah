import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import {
  assertHandoff,
  assertRunLimits,
  type JsonValue,
  type RunRequest,
  type Runner,
  type RunnerHandle,
  type RunnerResult,
  type WakeOutput,
} from "@goah/ledger-contract";

export interface PiStepRequest { handoffOnly: boolean; remainingTokens: number }
export interface PiStep {
  tokensUsed: number;
  trace?: Array<{ kind: string; data: JsonValue }>;
  handoff?: WakeOutput;
  stopped?: boolean;
}
export interface PiSession { step(request: PiStepRequest): Promise<PiStep>; close(): Promise<void> }
export interface PiDriver { createSession(request: RunRequest): Promise<PiSession> }

/** In-process adapter for tests and for use inside a ProcessRunner worker. */
export class PiRunnerAdapter {
  constructor(private readonly driver: PiDriver) {}

  prepare(request: RunRequest): RunnerHandle {
    let started = false;
    let resolveResult!: (result: RunnerResult) => void;
    const result = new Promise<RunnerResult>((resolve) => { resolveResult = resolve; });
    return {
      pid: null,
      begin: () => {
        if (started) return;
        started = true;
        void this.#run(request).then(resolveResult);
      },
      result,
      terminate: async () => undefined,
    };
  }

  async terminateProcess(pid: number): Promise<void> { await terminatePid(pid, 500); }

  async #run(request: RunRequest): Promise<RunnerResult> {
    assertRunLimits(request.limits);
    const session = await this.driver.createSession(request);
    const startedAt = Date.parse(request.now());
    let tokensUsed = 0;
    let handoffOnly = false;
    try {
      while (tokensUsed < request.limits.maxTokens) {
        const elapsed = Date.parse(request.now()) - startedAt;
        handoffOnly ||= tokensUsed >= request.limits.maxTokens - request.limits.handoffReserveTokens
          || elapsed >= request.limits.maxWallClockMs - request.limits.handoffReserveWallClockMs;
        if (elapsed >= request.limits.maxWallClockMs) {
          return { outcome: "abnormal", reason: "wall-clock limit exceeded without a valid handoff", tokensUsed };
        }
        const step = await session.step({ handoffOnly, remainingTokens: request.limits.maxTokens - tokensUsed });
        if (!Number.isInteger(step.tokensUsed) || step.tokensUsed <= 0) {
          return { outcome: "abnormal", reason: "runner returned a non-positive token charge", tokensUsed };
        }
        tokensUsed += step.tokensUsed;
        for (const trace of step.trace ?? []) request.emit(trace);
        if (step.handoff) {
          assertHandoff(step.handoff.handoff);
          return { outcome: "handoff", output: step.handoff, tokensUsed };
        }
        if (step.stopped) return { outcome: "abnormal", reason: "runner stopped without a valid handoff", tokensUsed };
      }
      return { outcome: "abnormal", reason: "token limit exceeded without a valid handoff", tokensUsed };
    } catch (error) {
      return { outcome: "abnormal", reason: error instanceof Error ? error.message : String(error), tokensUsed };
    } finally {
      await session.close();
    }
  }
}

export interface ProcessRunnerOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  inheritEnv?: string[];
  killGraceMs?: number;
}

type WorkerRequest = Omit<RunRequest, "now" | "emit">;
type WorkerMessage =
  | { type: "trace"; event: { kind: string; data: JsonValue } }
  | { type: "result"; result: RunnerResult };

/** Real process boundary. The child stays idle until begin() sends its request. */
export class ProcessRunner implements Runner {
  readonly isolation = "process" as const;
  constructor(readonly options: ProcessRunnerOptions) {}

  prepare(request: RunRequest): RunnerHandle {
    const child = spawn(this.options.command, this.options.args ?? [], {
      detached: process.platform !== "win32",
      env: childEnvironment(this.options.env, this.options.inheritEnv),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let started = false;
    let timedOut = false;
    let messageResult: RunnerResult | null = null;
    let protocolError: string | null = null;
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    let resolveResult!: (result: RunnerResult) => void;
    const result = new Promise<RunnerResult>((resolve) => { resolveResult = resolve; });
    const settle = (value: RunnerResult) => { if (!settled) { settled = true; resolveResult(value); } };

    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as WorkerMessage;
        if (message.type === "trace") request.emit(message.event);
        else messageResult = message.result;
      } catch (error) {
        protocolError = error instanceof Error ? error.message : String(error);
        void terminate();
      }
    });
    child.once("error", (error) => { if (timer) clearTimeout(timer); settle({ outcome: "abnormal", reason: error.message, tokensUsed: 0 }); });
    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (protocolError) settle({ outcome: "abnormal", reason: `runner protocol error: ${protocolError}`, tokensUsed: 0 });
      else if (messageResult) settle(messageResult);
      else if (timedOut) settle({ outcome: "abnormal", reason: "runner wall-clock limit exceeded and process was killed", tokensUsed: 0 });
      else settle({ outcome: "abnormal", reason: stderr.trim() || `runner exited without a result (${code ?? signal ?? "unknown"})`, tokensUsed: 0 });
    });

    const terminate = async () => {
      if (child.pid) await terminateOwnedChild(child, this.options.killGraceMs ?? 500);
    };
    return {
      pid: child.pid ?? null,
      begin: () => {
        if (started) return;
        started = true;
        const serializable: WorkerRequest = {
          wake: request.wake,
          context: request.context,
          ...(request.workspacePath ? { workspacePath: request.workspacePath } : {}),
          limits: request.limits,
        };
        child.stdin?.end(`${JSON.stringify(serializable)}\n`);
        timer = setTimeout(() => { timedOut = true; void terminate(); }, request.limits.maxWallClockMs);
      },
      result,
      terminate,
    };
  }

  async terminateProcess(pid: number): Promise<void> { await terminatePid(pid, this.options.killGraceMs ?? 500); }
}

export type WorkerRun = (request: WorkerRequest, emit: (event: { kind: string; data: JsonValue }) => void) => Promise<RunnerResult>;

/** Entry helper for runner executables. It exits when its parent disappears. */
export async function runProcessWorker(run: WorkerRun): Promise<void> {
  const parent = process.ppid;
  const monitor = setInterval(() => {
    if (process.ppid !== parent || !isAlive(parent)) process.exit(70);
  }, 250);
  monitor.unref();
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    const request = JSON.parse(line) as WorkerRequest;
    const result = await run(request, (event) => process.stdout.write(`${JSON.stringify({ type: "trace", event })}\n`));
    process.stdout.write(`${JSON.stringify({ type: "result", result })}\n`);
    clearInterval(monitor);
    return;
  }
}

async function terminateOwnedChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  signalPid(child.pid, "SIGTERM");
  await Promise.race([new Promise<void>((resolve) => child.once("close", () => resolve())), delay(graceMs)]);
  if (child.exitCode === null && child.signalCode === null) {
    signalPid(child.pid, "SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
  }
}

async function terminatePid(pid: number, graceMs: number): Promise<void> {
  if (!isAlive(pid)) return;
  signalPid(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (isAlive(pid) && Date.now() < deadline) await delay(25);
  if (isAlive(pid)) signalPid(pid, "SIGKILL");
  const killDeadline = Date.now() + graceMs;
  while (isAlive(pid) && Date.now() < killDeadline) await delay(25);
  if (isAlive(pid)) throw new Error(`runner process ${pid} did not exit after SIGKILL`);
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(process.platform === "win32" ? pid : -pid, signal); } catch {}
}
function isAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function childEnvironment(explicit: Record<string, string> = {}, inherited: string[] = []): NodeJS.ProcessEnv {
  const names = new Set(["PATH", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", ...inherited]);
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, ...explicit };
}
