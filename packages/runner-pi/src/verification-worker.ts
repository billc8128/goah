import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { createPiModel, providerApiKey } from "./model-provider.js";
interface VerificationResult { findings: Array<{ actionId: string; body: unknown; evidence: number[]; riskWeight: number }>; tokensUsed: number }

export async function runVerificationWorker(): Promise<void> {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const request = JSON.parse(line) as { operation: "verify_session" | "blind_audit" | "reason_audit"; input: unknown };
    const provider = process.env.GOAH_PI_PROVIDER ?? "anthropic";
    const modelId = process.env.GOAH_PI_MODEL;
    if (!modelId) throw new Error("GOAH_PI_MODEL is required");
    const configured = createPiModel(provider, modelId);
    const { models, model } = configured;
    if (provider === "faux") {
      const faux = configured.faux!;
      const findings = JSON.parse(process.env.GOAH_VERIFIER_FAUX_FINDINGS ?? "[]");
      faux.setResponses([fauxAssistantMessage(fauxToolCall("report_findings", { findings }), { stopReason: "toolUse" })]);
    }

    let result: VerificationResult | null = null;
    let tokensUsed = 0;
    const tool: AgentTool<any> = {
      name: "report_findings", label: "Report findings", description: "Return evidence-backed verification findings.",
      parameters: Type.Object({ findings: Type.Array(Type.Object({ actionId: Type.String(), body: Type.Any(), evidence: Type.Array(Type.Number()), riskWeight: Type.Number() })) }),
      execute: async (_id, params) => { const input = params as { findings: VerificationResult["findings"] }; result = { findings: input.findings, tokensUsed }; return { content: [{ type: "text", text: "findings recorded" }], details: result, terminate: true }; },
    };
    const systemPrompt = request.operation === "blind_audit"
      ? "Independently audit facts. Handoffs, notes, reasons, and claimed evidence are unavailable by design. Report only evidence-backed findings."
      : request.operation === "reason_audit"
        ? "Compare already-audited facts against revealed action reasons. Identify unsupported claims or omitted counterevidence."
        : "Verify the handoff against trace facts and action evidence. Never trust self-report without support.";
    const agent = new Agent({ initialState: { systemPrompt: `${systemPrompt} You must call report_findings exactly once.`, model, tools: [tool] }, streamFn: models.streamSimple.bind(models), getApiKey: providerApiKey, shouldStopAfterTurn: () => result !== null });
    agent.subscribe((event) => { if (event.type === "message_end" && event.message.role === "assistant") tokensUsed += event.message.usage.totalTokens; });
    await agent.prompt(JSON.stringify(request.input));
    const finalResult = result as VerificationResult | null;
    if (!finalResult) throw new Error("verifier exited without findings");
    finalResult.tokensUsed = tokensUsed;
    process.stdout.write(JSON.stringify(finalResult));
    return;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await runVerificationWorker();
