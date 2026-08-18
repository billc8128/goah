import {
  assertHandoff,
  assertRunLimits,
  type JsonValue,
  type RunRequest,
  type Runner,
  type RunnerResult,
  type WakeOutput,
} from "@goah/ledger-contract";

export interface PiStepRequest {
  handoffOnly: boolean;
  remainingTokens: number;
}

export interface PiStep {
  tokensUsed: number;
  trace?: Array<{ kind: string; data: JsonValue }>;
  handoff?: WakeOutput;
  stopped?: boolean;
}

export interface PiSession {
  step(request: PiStepRequest): Promise<PiStep>;
  close(): Promise<void>;
}

/**
 * Anti-corruption seam around pi-agent-core. A production binding only needs to
 * map Agent turns/tools/trace into this small interface; milestone 1A supplies
 * the same interface with FauxPiDriver and no model credentials.
 */
export interface PiDriver {
  createSession(request: RunRequest): Promise<PiSession>;
}

export class PiRunnerAdapter implements Runner {
  constructor(private readonly driver: PiDriver) {}

  async run(request: RunRequest): Promise<RunnerResult> {
    assertRunLimits(request.limits);
    const session = await this.driver.createSession(request);
    const startedAt = Date.parse(request.now());
    let tokensUsed = 0;
    let handoffOnly = false;

    try {
      while (tokensUsed < request.limits.maxTokens) {
        const elapsed = Date.parse(request.now()) - startedAt;
        const tokenReserveReached = tokensUsed >= request.limits.maxTokens - request.limits.handoffReserveTokens;
        const timeReserveReached = elapsed >= request.limits.maxWallClockMs - request.limits.handoffReserveWallClockMs;
        handoffOnly ||= tokenReserveReached || timeReserveReached;

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
        if (step.stopped) {
          return { outcome: "abnormal", reason: "runner stopped without a valid handoff", tokensUsed };
        }
      }
      return { outcome: "abnormal", reason: "token limit exceeded without a valid handoff", tokensUsed };
    } catch (error) {
      return { outcome: "abnormal", reason: error instanceof Error ? error.message : String(error), tokensUsed };
    } finally {
      await session.close();
    }
  }
}
