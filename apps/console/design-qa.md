# Goah Console design QA

- Selected reference: `/Users/bcc/.codex/generated_images/01a013f3-7223-7721-ab82-e95dd34fdcbc/exec-59978198-16b6-4a12-8c44-279e50762927.png`
- Trajectory granularity reference: `/var/folders/gq/tm7_y1js0nd03vjg61sb_66c0000gn/T/codex-clipboard-2a50b714-c422-4fe4-ae6d-5490bc849ef4.png`
- Implementation screenshot: `/tmp/goah-console-final.png`
- Trajectory screenshot: `/tmp/goah-console-trajectory-final.png`
- Work Ledger screenshot: `/tmp/goah-console-work-ledger-final.png`
- Polished Overview: `/tmp/goah-console-audit/05-overview-polished.png`
- Polished Trajectory: `/tmp/goah-console-audit/06-trajectory-polished.png`
- Polished Work Ledger: `/tmp/goah-console-audit/07-ledger-polished.png`
- Polished Agents: `/tmp/goah-console-audit/08-agents-polished.png`
- Side-by-side comparison: `/tmp/goah-console-design-comparison.png`
- Trajectory comparison: `/tmp/goah-trajectory-reference-comparison.png`
- Verification URL: `http://127.0.0.1:65489/?demo=1`
- Desktop viewport: 1440 × 1024 CSS px
- Mobile viewport: 390 × 844 CSS px

## Fidelity evidence

- Preserves the goal-first Overview while reducing it to two stable regions: persistent navigation and one goal-and-organization content column.
- Preserves the four primary views: Overview, Trajectory, Ledger with current seq, and Agents with roster count. Settings remains secondary.
- Uses the supplied Goah orbital mark rather than approximating the identity.
- Matches the warm off-white base, restrained cobalt accent, near-black type, fine separators, and low-elevation surface treatment.
- Keeps display type at product UI scale; body copy remains 12–16px and the root goal stays below 34px.
- Organization trajectory uses readable narratives with immutable Ledger seq provenance.

## Product behavior evidence

- Overview renders from a real redacted Supervisor snapshot.
- Trajectory navigation opens one selected wake/session at turn-level granularity: prepared context, user/model messages, tool call/result pairs, compaction, and handoff.
- Trajectory exposes session selection, duration, turn count, call count, search, and Input / Model / Tools activity lanes matching the supplied reference hierarchy.
- Work Ledger defaults to Agent-authored `handoff.recorded` work records with Observed / Completed / Next / Blocked sections; Raw Events is an explicit advanced mode with event-type filtering and search.
- Agents navigation and per-agent selection update owned goals, sessions, and Agent-authored work records; selecting a session opens its Trajectory.
- Talk to CEO opens a functional composer and POSTs through the Supervisor; an empty organization starts a root goal, while an existing organization receives decision mail.
- Real empty-ledger state and populated demo state both render without console warnings or errors.

## Responsive and accessibility evidence

- Desktop at 1440 × 1024 has no horizontal overflow.
- Mobile at 390 × 844 has no horizontal overflow and moves the four primary views into a persistent bottom navigation.
- Controls have keyboard focus treatment; navigation and dialogs expose semantic button/dialog roles.
- Event data returned to the browser is redacted by default.

## Comparison history

1. The legacy dashboard was a dark monospace JSON table and did not express organization motion or product hierarchy.
2. The selected A direction established a goal-first cockpit with an organization tree and attention rail.
3. The revised direction added the explicit Overview / Trajectory / Ledger / Agents information architecture and Ledger seq provenance.
4. The implementation keeps the selected topology while allowing real data, empty states, live refresh, filters, and interaction.
5. The initial Trajectory duplicated the semantic organization summary. It was replaced by the supplied per-session trace granularity, while semantic work summaries moved into Work Ledger.
6. Cross-page polish removed repeated metadata, empty turn spacer rows, expanded-by-default work records, healthy recovery noise, and nested record cards.
7. The wide horizontal tree and right attention rail were removed after real viewport testing exposed brittle scaling. Overview now uses a compact vertical CEO-to-agent tree; approvals sit inline with the goal, next wakes sit on their owning agents, and Talk to CEO sits in the goal header.

## Follow-up polish

- P3: approvals are currently informational in Overview; approval controls still belong to the future action-detail flow.

final result: passed
