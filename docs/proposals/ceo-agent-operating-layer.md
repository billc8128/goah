# Goah CEO Agent Operating Layer

Status: implemented through Milestones A–C and E; deterministic Milestone D canary
Version: 0.4
Date: 2026-08-20

Rendered document: [`../../Goah-CEO-Agent-Operating-Layer.html`](../../Goah-CEO-Agent-Operating-Layer.html)

Implementation note: the contracts, atomic SQLite transactions, CEO tool surface and policy, interactive `goah` shell, resident Supervisor control socket, universal Pi coding tools, durable Goal observation methods, derived roster, motion/revision validation, recovery injection, and deterministic two-child canary are implemented for `0.5.0`. A long-running real-model Milestone D canary remains operational validation rather than an architectural dependency.

## 1. Decision summary

CEO Agent is the sole user-facing Agent identity in Goah. Users give goals, corrections, approvals, and questions to CEO; they do not coordinate child Agents directly. CEO translates human intent into a durable Goal tree, delegates bounded ownership to short-lived child Agents, observes evidence and handoffs, restructures the team when needed, and recommends root completion back to the human.

CEO is not a resident process. It is a durable identity reconstructed from the ledger on every wake:

```text
human intent
    ↓
CEO identity (short-lived process, durable ledger state)
    ↓ goal decomposition / delegation / review
child Agent identities (derived from active Goal ownership)
    ↓ facts, actions, handoffs
shared ledger
    ↓ bounded CEO Active Context
next CEO wake
```

This proposal completes the product promise:

> A user supplies one top-level goal. Goah forms and operates the Agent organization required to pursue it over time.

## 2. Scope and non-goals

### In scope

- One durable CEO identity as the only normal user interaction endpoint.
- A Codex/Claude Code-like interactive `goah` shell that starts or attaches to CEO in the current directory.
- The Pi coding baseline (`read`, `write`, `edit`, `bash`) for every CEO and child Agent, independent of organization role.
- A durable, textual observation method paired with every Goal so progress is evaluated consistently across wakes.
- Starting a root Goal and waking CEO automatically.
- Model-judged decomposition and team changes.
- Atomic delegation: Goal + message + wake, all or nothing.
- A derived team roster without a new authoritative Agent table.
- Child completion, blocking, abnormal exhaustion, and material results waking CEO.
- A default CEO Operating Policy that is usable without application-authored prompts.
- Mechanical checks that CEO cannot leave an unfinished organization motionless.
- Human control over root purpose and final completion.

### Out of scope

- A fixed organizational chart.
- Hard-coded rules such as “more than three tasks means create an Agent”.
- Long-lived Agent processes.
- A message queue or separate orchestration service.
- Framework-owned business metrics, budgets, or Git workspaces.
- A framework-defined metric schema for every Goal; an observation method may be a script, checklist, query, inspection protocol, or human confirmation.
- CEO overriding human root-goal authority.

## 3. Product interaction model

### 3.1 Normal user surface

The normal product entry is an interactive CEO session in the current directory:

```bash
goah
goah "Launch a profitable store"
goah --continue
```

The shell starts or attaches to the local Supervisor, streams CEO text and tool activity, accepts corrections and approvals, and may exit without stopping background organization work. Re-entering `goah` reconstructs the same CEO from Ledger state rather than provider thread identity.

Lower-level commands remain available for inspection, automation, and recovery:

```bash
goah goal start --objective "Launch a profitable store"
goah goal update <root-goal-id> --objective "..."
goah ceo status
goah ceo inbox
goah ceo approve <action-id> --reason "..." --evidence <seqs>
goah goal complete <root-goal-id>
```

The CLI and a later graphical control panel are clients of the same Supervisor-owned local control connection. They never open SQLite directly. This permits goal revisions and human messages while the resident Supervisor is running without creating another Ledger writer.

Users do not need to know child Agent names, schedules, or wake IDs. Those remain inspectable, not required interaction concepts.

### 3.2 Root-goal authority

- Human creates and may revise, pause, resume, or complete a root Goal.
- Root Goal `owner` is CEO, but root mutation authority remains human.
- CEO may create and mutate descendants through parent authority.
- CEO cannot mark the root complete. It emits a completion recommendation with evidence and asks the human to close it.
- A human correction becomes a durable CEO message and a root revision when it changes purpose.
- A material objective revision invalidates the previous observation method until the human reconfirms it; existing children require CEO review before new high-risk work.

### 3.3 CEO continuity

The user experiences one continuous CEO even though each wake is a new process. Continuity is derived from:

- root and child Goals;
- previous CEO handoff;
- team roster projection;
- unread human/child mail;
- recent child handoffs;
- unresolved actions, blockers, and audit advice;
- CEO schedule and recovery facts.

Provider thread identity is not the source of continuity.

### 3.4 Universal Agent work surface

Every Agent runs in a local or cloud computer working directory and receives the Pi coding baseline:

| Tool | Purpose |
|---|---|
| `read` | Read project files and existing operational material |
| `write` | Create complete files and artifacts |
| `edit` | Apply bounded changes without rewriting an entire file |
| `bash` | Inspect the directory, search, run scripts, tests, and ordinary local CLIs |

These four tools are infrastructure, not role capabilities. CEO and every child receive them. `handoff` and role-scoped Goah RPC tools are layered on top.

Discovery follows the same filesystem-first model as Codex: Agents inspect the current directory, `goah.config.json`, scripts, documentation, and non-secret connector manifests with Bash and file tools. Goah does not add `capability.list`, `connector.list`, or `metric.list` merely to mirror readable project configuration. Ledger queries and protected mutations still use RPC because Agents never receive a database connection or external credentials.

## 4. Team model without an Agent table

### 4.1 Agent existence

An Agent exists operationally when it owns at least one non-complete Goal.

```text
active / paused / blocked Goal with owner=research
    → research appears in team.list

all Goals owned by research become complete
    → research becomes retired
    → no future automatic wake is admitted
```

Historical owners remain discoverable from events and completed Goals.

This avoids a second authority that can disagree with the Goal tree. Goal ownership is the team roster source of truth.

### 4.2 Derived roster

`team.list` returns one entry per owner:

```ts
interface TeamMemberView {
  agent: string;
  goalIds: string[];
  status:
    | "running"
    | "queued"
    | "scheduled"
    | "waiting"
    | "blocked"
    | "idle_unplanned"
    | "retired";
  lastHandoffSeq: number | null;
  lastWakeStatus: WakeStatus | null;
  nextWakeAt: string | null;
}
```

Status is a pure projection:

1. running wake → `running`
2. queued/leased wake → `queued`
3. future schedule → `scheduled`
4. all owned Goals blocked → `blocked`
5. active Goal with an explicit external wait condition → `waiting`
6. active Goal with no wake, schedule, or wait → `idle_unplanned`
7. only complete Goals → `retired`

`idle_unplanned` is a CEO invariant violation, not a normal steady state.

### 4.3 Profiles

New owners use the default child profile unless configuration maps the owner to a named profile template. Dynamic arbitrary capability creation is deferred. CEO may choose ownership boundaries; deployment configuration decides which tool/capability templates are available.

## 5. Goal observation method

### 5.1 Purpose

An objective says what should become true. Its observation method says how an Agent must inspect reality to decide whether the objective is progressing or complete. Without this durable companion, separately reconstructed Sessions can silently change definitions, data sources, commands, or acceptance criteria.

The method is Markdown text, intentionally not a universal metric object. It behaves like a Goal-specific micro-skill and may describe a query, script, checklist, artifact inspection, external data source, or human confirmation.

```ts
interface GoalSnapshot {
  id: string;
  parentId: string | null;
  objective: string;
  observationMethod: string | null;
  owner: string;
  phase: GoalPhase;
  revision: number;
}
```

SQLite stores it as nullable `observation_method TEXT`. `null` has one meaning: the Goal has not yet acquired an authoritative observation method.

### 5.2 Root Goal onboarding

A new root starts with `observationMethod = null`. On its first wake CEO must:

1. inspect the current directory, project documentation, scripts, local CLIs, configured connectors, and existing Ledger evidence;
2. clarify the objective, constraints, current baseline, and meaning of success;
3. for quantitative or external outcomes, identify the source, calculation, freshness, cadence, time zone, sustain window, and missing-data behavior;
4. draft a textual observation method and list any required data access or permissions;
5. ask only for decisions or access that cannot be discovered locally;
6. continue safe, reversible exploration while waiting when useful;
7. present the method to the human for confirmation.

The draft remains a durable CEO message/event. CEO cannot authoritatively set the root method. Human confirmation writes the non-null value through root authority, increments Goal revision, and wakes CEO. No separate `confirmed` field is required: a non-null root value can only have been written by human authority.

Exploratory children are permitted before confirmation when their bounded purpose is to discover the root observation method. Those children still require their own non-empty methods.

### 5.3 Child Goal contract

CEO must write a non-empty observation method when delegating a child. Example:

```markdown
Run `npm test` and `npm run typecheck` from the project root.
Both commands must exit 0. Cite their tool-result event sequences.
If either command is unavailable, report the exact missing prerequisite instead of claiming completion.
```

Objective and observation method form one revisioned pair:

- creating a child requires both;
- changing a child objective requires a replacement method in the same revision;
- CEO may revise a child method through parent authority with reason and evidence;
- every child Active Context includes the exact current text;
- completion must cite Ledger evidence produced by following the method.

### 5.4 Root revision semantics

A material human revision to the root objective clears its previous observation method by default. CEO receives a high-priority revision wake, reviews all descendants, and proposes a new or explicitly reused method. Children derived from an older root revision may finish their current safe step, but cannot begin a new gated/high-risk action until CEO revalidates their objective/method pair.

This creates a revision barrier without killing useful local work or treating every wording edit as a destructive reset.

### 5.5 Examples

Revenue outcome:

```markdown
Use paid Shopify orders as the fact source. Net revenue is paid amount minus refunds,
excluding tax and shipping, grouped by Asia/Shanghai calendar month. Run
`scripts/revenue-report.ts` every six hours. Report order count, gross, refunds, and net.
Data older than twelve hours cannot support a progress or completion judgment.
```

Qualitative artifact:

```markdown
Inspect the home page at desktop and mobile widths against the approved message checklist.
Store screenshots and cite them in the handoff. Completion requires CEO review and human
confirmation; visual presence cannot be inferred from source code alone.
```

## 6. Atomic delegation

### 6.1 Why a high-level primitive is required

The current low-level sequence is unsafe as a product protocol:

```text
goal.put
mail.send
wake enqueue
```

If CEO omits or crashes between calls, a child Goal may exist without motion. The model should decide to delegate; deterministic code must make that decision effective atomically.

### 6.2 Contract

```ts
interface DelegationRequest {
  id: string;                 // idempotency key
  parentGoalId: string;
  childGoal: {
    id: string;
    objective: string;
    observationMethod: string;
    owner: string;
  };
  brief: JsonValue;
  reason: string;
  evidence: number[];
}

interface DelegationResult {
  delegationId: string;
  goal: GoalSnapshot;
  mail: MailSnapshot;
  wake: WakeSnapshot;
}
```

`delegate` commits in one SQLite transaction:

1. validate CEO owns the parent Goal;
2. validate evidence exists;
3. append `delegation.created`;
4. update the Goal projection with the objective/observation-method pair;
5. append a decision-level child mail containing both;
6. update mailbox projection;
7. append/enqueue the child wake;
8. update Wake projection.

Failure rolls back all eight effects. Duplicate `delegationId` returns the existing result.

### 6.3 Reassignment and retirement

`reassign` atomically:

- increments Goal revision;
- changes owner through parent authority;
- records why and evidence;
- notifies old and new owners;
- queues the new owner;
- prevents new work for the old owner on that Goal.

`complete_delegate` completes a child Goal, not an Agent record. If the owner has no remaining non-complete Goals, the roster derives `retired`.

## 7. CEO tool surface

All Agents first receive `read`, `write`, `edit`, `bash`, and `handoff`. The table below is the additional CEO organization surface enforced by Supervisor role capabilities.

The default CEO receives high-level tools:

| Tool | Purpose |
|---|---|
| `team_list` | Derived roster, current liveness, Goal ownership |
| `delegate` | Atomically create child Goal + mail + wake |
| `reassign_goal` | Move a Goal and wake the new owner atomically |
| `pause_goal` | Pause child Goal and suppress automatic motion |
| `resume_goal` | Resume child Goal and ensure motion |
| `complete_goal` | Complete a child Goal and notify CEO context |
| `send_message` | Durable non-delegation communication |
| `ledger_search` | Read facts/evidence on demand |
| `schedule_review` | Set CEO’s next review wake |
| `request_human` | Durable human decision/completion request |
| `submit_action` | Existing external-action protocol |

Low-level `goal.put` remains an internal/advanced capability, not the default CEO product tool.

Child Agents keep the smaller Goah control surface: owned Goal plus observation method, ledger search, mail, own schedule, actions, audit acknowledgement, and handoff. They still retain the four Pi coding tools. They cannot delegate unless a deployment explicitly grants that role.

## 8. Default CEO Operating Policy

The policy is a built-in skill/prompt protocol. Open-ended judgments belong to the model; state transitions belong to tools and Supervisor checks.

### 8.1 Wake loop

Every CEO wake follows six stages.

#### 1. Orient

Read:

- root Goal and revisions;
- descendant Goal tree;
- derived team roster;
- unread human/child mail;
- latest handoff per child;
- blockers, exhausted retries, unknown actions, and audit advice;
- previous CEO assessment and next review;
- each Goal's current observation method and the root revision on which child work was based.

When the root method is `null`, onboarding and operationalization take priority over ordinary execution. CEO inspects the working directory before asking questions and must not invent a data source, baseline, permission, or success criterion.

#### 2. Diagnose motion

For every non-complete child Goal, determine:

- Is meaningful work in progress?
- Is it queued, scheduled, or explicitly waiting?
- Is ownership still coherent?
- Is work duplicated across Agents?
- Did new evidence invalidate the decomposition?
- Is each Agent still using the authoritative observation method?

#### 3. Decide organization

CEO chooses among:

- keep the current team;
- delegate a new bounded Goal;
- revise an objective;
- reassign ownership;
- pause or complete a child Goal;
- merge responsibility by completing redundant children;
- escalate a decision to the human;
- propose or revise an observation method when the objective or available evidence changes.

No numerical split threshold is built in. The default reasoning guidance prefers delegation when work has an independent objective, evidence boundary, and result that can be reviewed without sharing the entire parent context.

#### 4. Apply decisions

Use high-level atomic tools. Do not emulate delegation with separate low-level calls.

#### 5. Ensure motion

Before handoff, every active child Goal must have exactly one defensible liveness explanation:

- an active/queued wake;
- a future schedule;
- an explicit external wait condition with a wake trigger;
- or a blocker already escalated to CEO/human.

Any `idle_unplanned` member must be repaired in this wake.

Any active child without a non-empty observation method is also invalid. A quantitative or external root without a human-confirmed observation method may remain in onboarding/exploration, but CEO cannot claim measurable progress or completion.

#### 6. Close the loop

CEO exits with one of:

- active child motion plus a declared CEO review trigger;
- an explicit waiting condition and trigger;
- a human request blocking further progress;
- a root-completion recommendation with evidence.

“No action, no schedule, no blocker” is invalid while the root Goal is active.

### 8.2 Re-plan triggers

CEO is woken by:

- root Goal create/revise/resume;
- child Goal completion;
- child blocked state;
- child abnormal after retry exhaustion;
- material child handoff;
- child request/decision mail;
- unknown/high-risk action;
- audit finding;
- CEO’s own scheduled review;
- heartbeat violation;
- root or child observation-method revision;
- stale, missing, or contradictory evidence under the current method.

Trigger deduplication and queued-wake coalescing use the existing Wake mechanism.

## 9. CEO Active Context

CEO receives a bounded organizational view, not raw team transcripts.

```markdown
# Root objective

# Root observation method
- paid orders minus refunds; source=Shopify; freshness=12h

# Goal tree
- growth / active / owner=research / observe=weekly experiment report
- launch / blocked / owner=operator / observe=deployment check + screenshot

# Team motion
- research: running
- operator: blocked — supplier approval

# Material results
- research: ... [event:182]

# Decisions required
- Reassign launch or request human approval

# Unknown external actions

# Previous CEO plan

# Wake trigger
```

Raw Session events remain accessible through `ledger_search` and Inspector. Recovery uses the same semantic filtering already applied to ordinary Agents.

## 10. Mechanical invariants

| ID | Invariant |
|---|---|
| C1 | Only human authority mutates or completes a root Goal |
| C2 | Delegation commits Goal + mail + wake atomically |
| C3 | Every active child Goal has an owner |
| C4 | Every active child Goal has a liveness route or explicit escalated blocker |
| C5 | CEO cannot hand off an active root with no motion, review trigger, wait, or blocker |
| C6 | Child complete/blocked/retry-exhausted events wake CEO |
| C7 | Complete Goals admit no new automatic wake |
| C8 | Team roster is derived from ledger facts and never model self-report |
| C9 | Duplicate delegation/reassignment IDs do not duplicate child work |
| C10 | CEO recommendations never acquire human root authority |
| C11 | Every delegated child Goal has a non-empty textual observation method |
| C12 | Root observation method is non-null only after human authority writes it |
| C13 | Changing an objective replaces or invalidates its observation method in the same revision |
| C14 | Goal completion cites Ledger evidence produced under the current observation method |
| C15 | Every Agent receives `read`, `write`, `edit`, and `bash`; organization role only changes Goah control tools |

## 11. Failure semantics

### CEO crash

- Before an atomic tool commit: no organizational change.
- After commit: Goal/mail/wake all exist and duplicate retry is idempotent.
- No valid CEO handoff: wake becomes abnormal and follows existing retry semantics.

### Child crash

- Existing Session/Wake recovery applies.
- Retry exhaustion emits a CEO trigger carrying abnormal reason and last durable handoff.

### Duplicate or conflicting delegation

- Same delegation ID returns the committed result.
- Same child Goal ID with a different payload fails revision/identity checks.
- Concurrent CEO wakes remain impossible because per-Agent concurrency is one.

### CEO policy failure

- Invariant failure rejects handoff and records `ceo.motion_invalid`.
- Supervisor may retry once with the violation injected.
- Repeated violation escalates to human rather than fabricating team motion.

## 12. Human controls

Human can always:

- revise/pause/resume the root Goal;
- answer CEO decision mail;
- approve/reject gated actions;
- inspect roster, Goals, wakes, handoffs, and evidence;
- force a CEO wake;
- complete or cancel the root Goal;
- stop the Supervisor process;
- confirm or replace the root observation method;
- revise the root objective, which forces observation-method review and descendant revalidation.

Child Agent messages are visible for inspection but normal replies route through CEO. Emergency safety notifications may bypass CEO and reach human directly.

## 13. Implementation plan

### Milestone A — contracts and atomic delegation (implemented)

- `TeamMemberView`
- `DelegationRequest/Result`
- `commitDelegation()` transaction
- delegation/reassignment idempotency
- Goal-complete/blocked/retry-exhausted CEO triggers
- fault injection at each mutation point

Acceptance: no probe can produce a child Goal without its decision mail and queued wake.

### Milestone B — CEO tools and Operating Policy (implemented)

- high-level tool schemas
- derived `team_list`
- default CEO system prompt/skill
- motion validation before handoff
- human request/completion recommendation events

Acceptance: CEO cannot finish an active root while leaving an `idle_unplanned` child.

### Milestone C — lower-level product flow (implemented)

- `goah goal start`
- `goah ceo send/status/inbox`
- default init creates CEO profile
- root creation automatically wakes CEO
- status/dashboard show CEO recommendation and team roster

Acceptance: root creation, CEO messaging, status, approval, and automatic wake are available through CLI contracts.

### Milestone D — real multi-Agent canary (deterministic canary implemented; real-model long run pending)

Run a goal requiring at least two independent child Agents:

1. human starts one root Goal;
2. CEO delegates at least two children;
3. both children wake and produce evidence-backed handoffs;
4. one child is killed and recovered;
5. one child is reassigned or retired;
6. CEO consolidates results and recommends completion;
7. human completes root.

Acceptance: no direct human-to-child coordination and no manually created child wake.

### Milestone E — interactive CEO and Goal observation methods (implemented)

- `goah` starts or attaches to an interactive streaming CEO in the current directory;
- the resident Supervisor owns a local control connection so interactive clients never contend for the SQLite lock;
- every Agent receives Pi `read`, `write`, `edit`, and `bash` plus role-scoped Goah tools;
- Goal schema and SQLite v8 add nullable `observation_method TEXT`;
- first-root wake runs the filesystem-first operationalization protocol;
- human confirmation writes the root method; CEO delegation requires a child method;
- objective revisions invalidate or atomically replace the method and wake CEO for descendant review;
- Active Context renders the method on every wake;
- completion records evidence under the current Goal revision and method.

Acceptance: one `goah` command starts a Codex-like CEO interaction; after process restarts, CEO and children use the exact confirmed observation methods and cannot silently drift to a different success definition.

## 14. Required tests

- top-level goal start automatically wakes CEO;
- delegation is all-or-nothing under fault injection;
- duplicate delegation is idempotent;
- new owner without explicit profile runs with default child profile;
- child handoff/complete/blocked/retry exhaustion wakes CEO;
- reassign notifies both owners and queues only the new owner;
- completed child cannot receive an automatic wake;
- roster detects `idle_unplanned` from ledger state;
- CEO invalid handoff is rejected and violation is injected on retry;
- CEO root-completion recommendation cannot mutate root phase;
- restart/replay derives the identical roster and pending CEO decisions;
- real-model canary completes without direct child orchestration by the test driver.
- every Agent request exposes `read`, `write`, `edit`, and `bash` regardless of role;
- a new root starts with a null method and CEO requests confirmation after inspecting the project;
- CEO cannot directly authoritatively set a root method;
- delegation without a child method rolls back without Goal, mail, or wake;
- changing a child objective without a replacement method is rejected;
- root objective revision invalidates the old method and queues CEO revalidation;
- restart/replay renders the identical observation method;
- completion without evidence under the current method is rejected;
- interactive CLI can revise a Goal while the resident Supervisor remains running.

## 15. Open questions

These do not block Milestones A–C:

1. Whether multiple root Goals share one CEO or each root receives a separate CEO identity. Initial assumption: one CEO may own multiple roots, and Active Context groups by root.
2. Whether child Agents may themselves delegate. Initial assumption: no; nested delegation is an optional later capability.
3. Whether profile templates become durable ledger state. Initial assumption: deployment configuration owns templates; the ledger records the resolved profile name used for each wake.
4. Whether every child handoff wakes CEO or only material/terminal ones. Initial assumption: terminal, blocked, decision-request, and retry-exhausted always wake; routine handoffs are coalesced into CEO’s scheduled review unless marked material.
5. Whether a root objective revision always clears its method or may explicitly preserve it. Initial assumption: clear by default; the authenticated human may reconfirm an unchanged method.
6. How interactive streaming clients reconnect to a running local Supervisor. Initial assumption: one local Unix socket (or platform equivalent) owned by the existing Supervisor process; no separate scheduling service.
