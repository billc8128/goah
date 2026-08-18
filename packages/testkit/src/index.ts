import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CONTRACT_VERSION,
  type ActionSnapshot,
  type Clock,
  type Connector,
  type ConnectorManifest,
  type ConnectorQueryResult,
  type JsonValue,
  type RunRequest,
  type WakeOutput,
} from "@goah/ledger-contract";
import { SqliteLedger, type SqliteLedgerOptions } from "@goah/ledger-sqlite";
import type { PiDriver, PiSession, PiStepRequest } from "@goah/runner-pi";

export class SimulatedClock implements Clock {
  #value: Date;

  constructor(value = "2026-08-18T00:00:00.000Z") {
    this.#value = new Date(value);
  }

  now(): Date { return new Date(this.#value); }
  advance(ms: number): void { this.#value = new Date(this.#value.getTime() + ms); }
  set(value: string): void { this.#value = new Date(value); }
}

export function createMemoryLedger(options: SqliteLedgerOptions = {}): SqliteLedger {
  return new SqliteLedger(":memory:", options);
}

export interface FauxStep {
  tokens: number;
  advanceMs?: number;
  trace?: Array<{ kind: string; data: JsonValue }>;
  write?: { path: string; content: string };
  handoff?: WakeOutput;
  stop?: boolean;
  crash?: string;
  requireHandoffOnly?: boolean;
  effect?: (request: RunRequest, mode: PiStepRequest) => void;
}

export class FauxPiDriver implements PiDriver {
  readonly requests: RunRequest[] = [];
  #sessions: FauxStep[][];

  constructor(readonly clock: SimulatedClock, sessions: FauxStep[][]) {
    this.#sessions = sessions.map((steps) => [...steps]);
  }

  async createSession(request: RunRequest): Promise<PiSession> {
    this.requests.push(request);
    const steps = this.#sessions.shift() ?? [];
    return {
      step: async (mode: PiStepRequest) => {
        const step = steps.shift();
        if (!step) return { tokensUsed: 1, stopped: true };
        if (step.requireHandoffOnly && !mode.handoffOnly) throw new Error("faux model expected handoff-only mode");
        if (mode.handoffOnly && step.write) throw new Error("ordinary tool call attempted in handoff reserve");
        if (step.advanceMs) this.clock.advance(step.advanceMs);
        if (step.write) {
          if (!request.workspacePath) throw new Error("faux write has no workspace");
          const path = join(request.workspacePath, step.write.path);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, step.write.content);
        }
        step.effect?.(request, mode);
        if (step.crash) throw new Error(step.crash);
        return { tokensUsed: step.tokens, ...(step.trace ? { trace: step.trace } : {}), ...(step.handoff ? { handoff: step.handoff } : {}), ...(step.stop ? { stopped: true } : {}) };
      },
      close: async () => undefined,
    };
  }
}

export class MockConnector implements Connector {
  readonly dispatched: string[] = [];
  readonly manifest: ConnectorManifest;
  failAfterEffect = false;
  queryResult: ConnectorQueryResult | null = null;

  constructor(connector = "mock", kind = "mock.write") {
    this.manifest = {
      contractVersion: CONTRACT_VERSION,
      connector,
      dryRun: true,
      capabilities: [{
        kind,
        nativeIdempotency: true,
        query: "by_idempotency_key",
        automaticRetry: false,
        risk: "reversible",
        constraints: {},
      }],
    };
  }

  async dispatch(action: ActionSnapshot): Promise<{ status: "confirmed"; externalRef: string }> {
    if (!this.dispatched.includes(action.id)) this.dispatched.push(action.id);
    if (this.failAfterEffect) {
      this.failAfterEffect = false;
      throw new Error("injected connector crash after side effect");
    }
    return { status: "confirmed", externalRef: `mock:${action.id}` };
  }

  async query(action: ActionSnapshot): Promise<ConnectorQueryResult> {
    return this.queryResult ?? (this.dispatched.includes(action.id)
      ? { status: "confirmed", externalRef: `mock:${action.id}` }
      : { status: "failed" });
  }
}
