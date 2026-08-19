import type { ActionSnapshot, AgentRole, EventRecord, GoalSnapshot, JsonValue, MailSnapshot, WakeSnapshot } from "goah-ledger-contract";

export interface ActiveContextView {
  role: AgentRole;
  systemPrompt: string;
  text: string;
  sourceSeqs: number[];
}

export interface ActiveContextInput {
  role: AgentRole;
  systemPrompt: string;
  wake: WakeSnapshot;
  goals: GoalSnapshot[];
  mail: MailSnapshot[];
  actions: ActionSnapshot[];
  lastHandoff: EventRecord | null;
  teamHandoffs: EventRecord[];
  recoveryEvents: EventRecord[];
}

/** Deterministically render structured projections into the model's short working set. */
export function composeActiveContext(input: ActiveContextInput): ActiveContextView {
  const handoff = input.lastHandoff?.data as { observations?: unknown; results?: unknown; nextSteps?: unknown; blocker?: unknown } | undefined;
  const sourceSeqs = new Set<number>();
  if (input.lastHandoff) sourceSeqs.add(input.lastHandoff.seq);
  for (const event of input.recoveryEvents) sourceSeqs.add(event.seq);
  for (const action of input.actions) for (const seq of action.evidence) sourceSeqs.add(seq);

  const sections: Array<[string, string[]]> = [
    ["Objective", input.goals.map((goal) => `- [${goal.id}] ${goal.objective} (owner: ${goal.owner}, phase: ${goal.phase}, revision: ${goal.revision})`)],
    ["Wake", [`- Trigger: ${input.wake.triggerRef}`, `- Attempt: ${input.wake.attempt}`]],
    ["Current state", lines(handoff?.observations)],
    ["Verified", lines(handoff?.results).map((line) => `${line}${input.lastHandoff ? ` [event:${input.lastHandoff.seq}]` : ""}`)],
    ["Open", [
      ...(typeof handoff?.blocker === "string" && handoff.blocker ? [`- ${handoff.blocker}`] : []),
      ...input.actions.filter((action) => action.status === "unknown").map((action) => `- Action ${action.id} has unknown external outcome; reconcile before retrying.`),
      ...input.actions.filter((action) => action.auditAdvice && !action.adviceAcked).map((action) => `- Audit advice for ${action.id}: ${render(action.auditAdvice!.body)}`),
    ]],
    ["Next", lines(handoff?.nextSteps)],
    ["Incoming", input.mail.map((mail) => `- [${mail.level}] from ${mail.from}: ${render(mail.body)}`)],
    ["External actions", input.actions.filter((action) => !["confirmed", "failed"].includes(action.status)).map((action) => `- ${action.id}: ${action.kind} — ${action.status}`)],
    ["Team handoffs", input.teamHandoffs.map((event) => `- ${event.actor}: ${render(event.data)} [event:${event.seq}]`)],
    ["Recovery", input.recoveryEvents.map((event) => `- ${event.type}: ${render(event.data)} [event:${event.seq}]`)],
  ];
  const text = sections.filter(([, values]) => values.length > 0).map(([title, values]) => `# ${title}\n\n${values.join("\n")}`).join("\n\n");
  return { role: input.role, systemPrompt: input.systemPrompt, text, sourceSeqs: [...sourceSeqs].sort((a, b) => a - b) };
}

function lines(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => `- ${item}`) : []; }
function render(value: JsonValue): string { return typeof value === "string" ? value : JSON.stringify(value); }
