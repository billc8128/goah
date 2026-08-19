import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTRACT_VERSION,
  type Clock,
  type ConnectorManifest,
  type ConnectorProcessSpec,
  type JsonValue,
  type Ledger,
  type RunRequest,
  type WakeOutput,
} from "goah-ledger-contract";
import { SqliteLedger, type SqliteLedgerOptions } from "goah-ledger-sqlite";
import type { PiDriver, PiSession } from "goah-runner-pi";

export class SimulatedClock implements Clock {
  #value: Date;
  constructor(value = "2026-08-18T00:00:00.000Z") { this.#value = new Date(value); }
  now(): Date { return new Date(this.#value); }
  advance(ms: number): void { this.#value = new Date(this.#value.getTime() + ms); }
  set(value: string): void { this.#value = new Date(value); }
}

export function createMemoryLedger(options: SqliteLedgerOptions = {}): SqliteLedger { return new SqliteLedger(":memory:", options); }

export interface FauxStep {
  advanceMs?: number;
  trace?: Array<{ kind: string; data: JsonValue }>;
  write?: { path: string; content: string };
  handoff?: WakeOutput;
  stop?: boolean;
  crash?: string;
  effect?: (request: RunRequest) => void;
}

export class FauxPiDriver implements PiDriver {
  readonly requests: RunRequest[] = [];
  #sessions: FauxStep[][];
  constructor(readonly clock: SimulatedClock, sessions: FauxStep[][], readonly directory = process.cwd()) { this.#sessions = sessions.map((steps) => [...steps]); }
  async createSession(request: RunRequest): Promise<PiSession> {
    this.requests.push(request);
    const steps = this.#sessions.shift() ?? [];
    return {
      step: async () => {
        const step = steps.shift();
        if (!step) return { stopped: true };
        if (step.advanceMs) this.clock.advance(step.advanceMs);
        if (step.write) {
          const path = join(this.directory, step.write.path);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, step.write.content);
        }
        step.effect?.(request);
        if (step.crash) throw new Error(step.crash);
        return { ...(step.trace ? { trace: step.trace } : {}), ...(step.handoff ? { handoff: step.handoff } : {}), ...(step.stop ? { stopped: true } : {}) };
      },
      close: async () => undefined,
    };
  }
}

interface MockState { dispatched: string[]; failAfterEffect: boolean }

export class MockConnector {
  readonly statePath = join(tmpdir(), `goah-mock-connector-${crypto.randomUUID()}.json`);
  readonly manifest: ConnectorManifest;
  readonly spec: ConnectorProcessSpec;
  constructor(connector = "mock", kind = "mock.write") {
    this.manifest = {
      contractVersion: CONTRACT_VERSION,
      connector,
      dryRun: true,
      capabilities: [{ kind, nativeIdempotency: true, query: "by_idempotency_key", automaticRetry: false, risk: "reversible" }],
    };
    writeFileSync(this.statePath, JSON.stringify({ dispatched: [], failAfterEffect: false } satisfies MockState));
    this.spec = { manifest: this.manifest, command: process.execPath, args: [mockConnectorWorkerPath()], env: { GOAH_MOCK_CONNECTOR_STATE: this.statePath }, timeoutMs: 2_000 };
  }
  get dispatched(): string[] { return this.#state().dispatched; }
  set failAfterEffect(value: boolean) { const state = this.#state(); state.failAfterEffect = value; writeFileSync(this.statePath, JSON.stringify(state)); }
  #state(): MockState { return JSON.parse(readFileSync(this.statePath, "utf8")) as MockState; }
}

export function mockConnectorWorkerPath(): string { return fileURLToPath(new URL("./mock-connector-worker.js", import.meta.url)); }
export function fauxRunnerWorkerPath(): string { return fileURLToPath(new URL("./faux-runner-worker.js", import.meta.url)); }

export interface LedgerConformanceFactory { (clock: Clock): Ledger }

/** Public, storage-independent contract checks for third-party Ledger implementations. */
export function assertLedgerConformance(create: LedgerConformanceFactory): void {
  const clock = new SimulatedClock("2030-01-01T00:00:00.000Z");
  const ledger = create(clock);
  const metric = { source: "test", window: "1h", direction: "at_least" as const, target: 1, freshnessMs: 1_000, onMissing: "abnormal" as const, onStale: "wake_owner" as const };
  ledger.putGoal({ id: "root", parentId: null, objective: "test", metric, target: 1, owner: "a", phase: "active", revision: 0 }, "human");
  const first = ledger.enqueueWake({ id: "z", agent: "a", triggerRef: "first", status: "queued", leaseUntil: null, attempt: 0, startedAt: null, endedAt: null, enqueuedSeq: 0, leaseToken: null, runnerPid: null }, "supervisor");
  ledger.enqueueWake({ id: "a", agent: "b", triggerRef: "second", status: "queued", leaseUntil: null, attempt: 0, startedAt: null, endedAt: null, enqueuedSeq: 0, leaseToken: null, runnerPid: null }, "supervisor");
  const claimed = ledger.claimNextWake(clock.now().toISOString(), "2030-01-01T00:01:00.000Z", "lease");
  if (claimed?.id !== "z") throw new Error("ledger conformance: wakes are not FIFO");
  if (first.event.ts !== clock.now().toISOString()) throw new Error("ledger conformance: injected clock was ignored");
  let rejected = false;
  try {
    ledger.requestAction({ id: "bad", agent: "a", kind: "mock", connector: "mock", payload: {}, reason: "bad", evidence: [999_999], gated: false, status: "requested", reconciledAt: null, externalRef: null, auditAdvice: null, adviceAcked: false }, "a");
  } catch { rejected = true; }
  if (!rejected) throw new Error("ledger conformance: nonexistent evidence was accepted");
  const before = JSON.stringify({ goals: ledger.goals(), wakes: ledger.wakes() });
  ledger.rebuildProjections();
  if (JSON.stringify({ goals: ledger.goals(), wakes: ledger.wakes() }) !== before) throw new Error("ledger conformance: projection replay changed state");
  ledger.close();
}
