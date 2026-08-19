import { controlStream, wakeStream, type ActionSnapshot, type EventRecord, type JsonValue, type Ledger } from "goah-ledger-contract";
import { spawn } from "node:child_process";
import type { Supervisor } from "./index.js";

export interface VerificationFinding {
  actionId: string;
  body: JsonValue;
  evidence: number[];
  riskWeight: number;
}

export interface VerificationResult { findings: VerificationFinding[]; tokensUsed: number }
export interface VerifierModel {
  verifySession(input: { wakeId: string; handoff: JsonValue | null; trace: EventRecord[]; actions: ActionSnapshot[] }): Promise<VerificationResult>;
  blindAudit(facts: EventRecord[]): Promise<VerificationResult>;
  reasonAudit(input: { facts: EventRecord[]; reasons: Array<{ actionId: string; reason: string; evidence: number[] }> }): Promise<VerificationResult>;
}

export interface VerifierProcessSpec { command: string; args: string[]; env?: Record<string, string>; timeoutMs?: number }

export class ProcessVerifierModel implements VerifierModel {
  constructor(readonly spec: VerifierProcessSpec) {}
  verifySession(input: { wakeId: string; handoff: JsonValue | null; trace: EventRecord[]; actions: ActionSnapshot[] }): Promise<VerificationResult> { return this.#call("verify_session", input); }
  blindAudit(facts: EventRecord[]): Promise<VerificationResult> { return this.#call("blind_audit", { facts }); }
  reasonAudit(input: { facts: EventRecord[]; reasons: Array<{ actionId: string; reason: string; evidence: number[] }> }): Promise<VerificationResult> { return this.#call("reason_audit", input); }

  async #call(operation: string, input: unknown): Promise<VerificationResult> {
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT"]) if (process.env[name] !== undefined) env[name] = process.env[name];
    const child = spawn(this.spec.command, this.spec.args, { detached: process.platform !== "win32", env: { ...env, ...this.spec.env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.stdin.end(`${JSON.stringify({ operation, input })}\n`);
    const timer = setTimeout(() => { timedOut = true; if (child.pid) { try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch {} } }, this.spec.timeoutMs ?? 60_000);
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    clearTimeout(timer);
    if (code !== 0) throw new Error(timedOut ? "verifier process timed out" : stderr.trim() || `verifier exited ${code}`);
    return JSON.parse(stdout) as VerificationResult;
  }
}

export class VerificationPlane {
  constructor(readonly ledger: Ledger, readonly supervisor: Supervisor, readonly model: VerifierModel) {}

  async verifySession(wakeId: string): Promise<VerificationResult> {
    const trace = this.ledger.eventsForWake(wakeId);
    const handoff = trace.findLast((event) => event.type === "handoff.recorded")?.data ?? null;
    const seqs = new Set(trace.map((event) => event.seq));
    const actions = this.ledger.actions().filter((action) => action.evidence.some((seq) => seqs.has(seq)));
    const result = await this.model.verifySession({ wakeId, handoff, trace, actions });
    this.#apply(result, "verifier", wakeId);
    this.ledger.appendEvent({ streamId: wakeStream(wakeId), ts: this.supervisor.clock.now().toISOString(), actor: "verifier", type: "verification.completed", data: { wakeId, findings: result.findings.length, tokensUsed: result.tokensUsed } });
    return result;
  }

  async auditGlobal(sinceSeq = 0): Promise<{ blind: VerificationResult; reasoned: VerificationResult }> {
    const facts = this.ledger.eventsSince(sinceSeq).filter((event) => !["handoff.recorded", "runner.note"].includes(event.type)).map(blindFact);
    const blind = await this.model.blindAudit(facts);
    const reasons = this.ledger.actions().map((action) => ({ actionId: action.id, reason: action.reason, evidence: action.evidence }));
    const reasoned = await this.model.reasonAudit({ facts, reasons });
    this.#apply(blind, "audit");
    this.#apply(reasoned, "audit");
    this.ledger.appendEvent({ streamId: controlStream("audit"), ts: this.supervisor.clock.now().toISOString(), actor: "audit", type: "audit.completed", data: { sinceSeq, blindFindings: blind.findings.length, reasonedFindings: reasoned.findings.length, tokensUsed: blind.tokensUsed + reasoned.tokensUsed } });
    return { blind, reasoned };
  }

  #apply(result: VerificationResult, by: "verifier" | "audit", wakeId?: string): void {
    for (const finding of result.findings) {
      if (!this.ledger.action(finding.actionId)) continue;
      this.supervisor.putAuditAdvice(finding.actionId, { by, body: finding.body, evidence: finding.evidence }, wakeId);
    }
  }
}

export interface VerificationLabel { id: string; shouldFlag: boolean; riskWeight: number }
export interface ScoredPrediction { id: string; score: number }
export function evaluateVerification(labels: VerificationLabel[], predictedIds: string[]): { precision: number; riskWeightedRecall: number } {
  const predicted = new Set(predictedIds);
  const positives = labels.filter((label) => label.shouldFlag);
  const truePositives = positives.filter((label) => predicted.has(label.id));
  const falsePositives = labels.filter((label) => !label.shouldFlag && predicted.has(label.id));
  const precision = truePositives.length + falsePositives.length === 0 ? 1 : truePositives.length / (truePositives.length + falsePositives.length);
  const totalRisk = positives.reduce((sum, label) => sum + label.riskWeight, 0);
  const recalledRisk = truePositives.reduce((sum, label) => sum + label.riskWeight, 0);
  return { precision, riskWeightedRecall: totalRisk === 0 ? 1 : recalledRisk / totalRisk };
}

export function calibrateVerificationThreshold(labels: VerificationLabel[], predictions: ScoredPrediction[], minimumPrecision: number): number {
  const candidates = [...new Set(predictions.map((prediction) => prediction.score))].sort((a, b) => a - b);
  let selected = 1;
  let bestRecall = -1;
  for (const threshold of candidates) {
    const metrics = evaluateVerification(labels, predictions.filter((prediction) => prediction.score >= threshold).map((prediction) => prediction.id));
    if (metrics.precision >= minimumPrecision && metrics.riskWeightedRecall > bestRecall) { selected = threshold; bestRecall = metrics.riskWeightedRecall; }
  }
  return selected;
}

function blindFact(event: EventRecord): EventRecord {
  if (!event.type.startsWith("action.")) return event;
  const data = structuredClone(event.data) as Record<string, unknown>;
  const snapshot = data.snapshot as Record<string, unknown> | undefined;
  if (snapshot) { delete snapshot.reason; delete snapshot.evidence; delete snapshot.auditAdvice; }
  delete data.reason;
  delete data.evidence;
  return { ...event, data: data as JsonValue };
}
