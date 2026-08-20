import { useEffect, useState, type ReactNode } from "react"
import {
  Activity,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  Database,
  House,
  MessageCircle,
  RefreshCcw,
  Route,
  Search,
  Send,
  Settings,
  Users,
  X,
} from "lucide-react"

import { Accordion, Collapsible, Dialog, ScrollArea, Select, Tabs } from "./components/ui/primitives"
import { demoSnapshot } from "./demo"
import type { ConsoleSnapshot, EventView, GoalView, SessionView, TeamView, TrajectoryItemView, TrajectoryPageView } from "./types"

type View = "overview" | "trajectory" | "session" | "ledger" | "agents" | "settings"

const searchParams = new URLSearchParams(window.location.search)
const isDemo = searchParams.has("demo")
const requestedView = searchParams.get("view")
const initialView: View = requestedView && ["overview", "trajectory", "session", "ledger", "agents", "settings"].includes(requestedView) ? requestedView as View : "overview"

export function App() {
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot | null>(isDemo ? demoSnapshot : null)
  const [view, setView] = useState<View>(initialView)
  const [selectedAgent, setSelectedAgent] = useState("growth")
  const [selectedWakeId, setSelectedWakeId] = useState<string | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)
  const [connection, setConnection] = useState<"loading" | "live" | "error">(isDemo ? "live" : "loading")

  useEffect(() => {
    if (isDemo) return
    let active = true
    const load = async () => {
      try {
        const response = await fetch("/api/snapshot", { cache: "no-store" })
        if (!response.ok) throw new Error(`snapshot request failed (${response.status})`)
        const next = await response.json() as ConsoleSnapshot
        if (active) { setSnapshot(next); setConnection("live") }
      } catch {
        if (active) setConnection("error")
      }
    }
    void load()
    const timer = window.setInterval(load, 2_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  if (!snapshot) return <LoadingState connection={connection} />

  const root = snapshot.goals.find((goal) => goal.parentId === null) ?? snapshot.goals[0] ?? null
  const openSession = (wakeId: string) => { setSelectedWakeId(wakeId); setView("session") }
  return (
    <div className="console-shell">
      <Sidebar view={view} onView={setView} />
      <main className="console-main">
        {connection === "error" && <div className="connection-banner">Live refresh paused. Retrying the local Supervisor…</div>}
        {view === "overview" && <Overview snapshot={snapshot} root={root} onView={setView} onTalk={() => setComposerOpen(true)} />}
        {view === "trajectory" && <OrganizationTrajectory snapshot={snapshot} onOpenSession={openSession} />}
        {view === "session" && <SessionTrace snapshot={snapshot} selectedWakeId={selectedWakeId} onSelectWake={setSelectedWakeId} onBack={() => setView("trajectory")} />}
        {view === "ledger" && <Ledger snapshot={snapshot} />}
        {view === "agents" && <Agents snapshot={snapshot} selected={selectedAgent} onSelect={setSelectedAgent} onOpenSession={openSession} />}
        {view === "settings" && <SettingsView snapshot={snapshot} />}
      </main>
      {composerOpen && <CeoComposer onClose={() => setComposerOpen(false)} />}
    </div>
  )
}

function Sidebar({ view, onView }: { view: View; onView(view: View): void }) {
  const items: Array<{ id: View; label: string; icon: typeof House }> = [
    { id: "overview", label: "Overview", icon: House },
    { id: "trajectory", label: "Trajectory", icon: Route },
    { id: "ledger", label: "Ledger", icon: Database },
    { id: "agents", label: "Agents", icon: Users },
  ]
  return (
    <aside className="sidebar">
      <div className="brand"><img src="/goah-orbital-mark.png" alt="" /><span>Goah Console</span></div>
      <nav aria-label="Console views">
        {items.map(({ id, label, icon: Icon }) => (
          <button key={id} className={view === id || id === "trajectory" && view === "session" ? "nav-item active" : "nav-item"} onClick={() => onView(id)}>
            <Icon aria-hidden="true" /><span>{label}</span>
          </button>
        ))}
      </nav>
      <button className={view === "settings" ? "nav-item settings active" : "nav-item settings"} onClick={() => onView("settings")}>
        <Settings aria-hidden="true" /><span>Settings</span>
      </button>
      <div className="sidebar-status">
        <p><i className="health-dot" /> System healthy</p>
      </div>
    </aside>
  )
}

function Overview({ snapshot, root, onView, onTalk }: { snapshot: ConsoleSnapshot; root: GoalView | null; onView(view: View): void; onTalk(): void }) {
  const children = snapshot.goals.filter((goal) => goal.parentId === root?.id)
  const ceo = snapshot.team.find((member) => member.agent === "ceo")
  const attention = snapshot.actions.filter((action) => ["requested", "unknown"].includes(action.status))
  const recovery = snapshot.wakes.filter((wake) => ["abnormal", "merge_blocked"].includes(wake.status))
  const trajectory = trajectoryEvents(snapshot.events).slice(-3).reverse()
  return (
    <div className="overview-layout">
      <section className="overview-content">
        <header className="goal-header">
          <p>Top-level goal</p>
          <div className="goal-header-row">
            <div className="goal-title-row">
              <h1>{root?.objective ?? "No active root goal"}</h1>
              {root && <><Status status={root.phase} /><span className="metadata">Rev {root.revision}</span></>}
            </div>
            <button className="header-action" onClick={onTalk}><MessageCircle /> Talk to CEO</button>
          </div>
          <p className="observation"><strong>Observation:</strong> {root?.observationMethod ?? "Waiting for the CEO to propose an observation method."}</p>
          {(attention[0] || recovery[0]) && <div className="attention-strip">
            {attention[0] && <span><CircleAlert /> Approval needed: <strong>{attention[0].kind}</strong></span>}
            {recovery[0] && <span className="danger"><RefreshCcw /> Recovery needed: <strong>{displayAgent(recovery[0].agent)}</strong></span>}
          </div>}
        </header>

        <section className="organization" aria-labelledby="organization-title">
          <h2 id="organization-title" className="sr-only">Organization motion</h2>
          <div className="org-tree">
            <article className="tree-root">
              <img src="/goah-orbital-mark.png" alt="" />
              <div><strong>CEO</strong><span>{root?.objective ?? "Waiting for a root goal"}</span></div>
              <Status status={ceo?.status ?? "waiting"} />
            </article>
            <div className="tree-children">
              {children.map((goal) => <AgentTreeRow key={goal.id} goal={goal} member={snapshot.team.find((item) => item.agent === goal.owner)} now={snapshot.now} />)}
              {children.length === 0 && <Empty text="The CEO has not delegated child goals yet." />}
            </div>
          </div>
        </section>

        <section className="trajectory-preview">
          <div className="section-heading"><h2>Organization trajectory</h2><button onClick={() => onView("trajectory")}>View all</button></div>
          <div className="trajectory-list">
            {trajectory.map((event) => (
              <button key={event.seq} className="trajectory-row" onClick={() => onView("trajectory")}>
                <i className={`event-dot ${eventTone(event)}`} /><time>{formatTime(event.ts)}</time><span className="actor">{displayAgent(event.actor)}</span><strong>{eventNarrative(event)}</strong><small>Seq #{event.seq}</small>
              </button>
            ))}
          </div>
        </section>
      </section>
    </div>
  )
}

function AgentTreeRow({ goal, member, now }: { goal: GoalView; member?: TeamView; now: string }) {
  return (
    <article className="tree-agent">
      <Bot />
      <div><strong>{displayAgent(goal.owner)}</strong><span>{goal.objective}</span></div>
      <Status status={member?.status ?? goal.phase} />
      <small>{member?.nextWakeAt ? `Next ${formatTime(member.nextWakeAt)} · ${relativeTime(member.nextWakeAt, now)}` : ""}</small>
    </article>
  )
}

function OrganizationTrajectory({ snapshot, onOpenSession }: { snapshot: ConsoleSnapshot; onOpenSession(wakeId: string): void }) {
  const [agent, setAgent] = useState("all")
  const [category, setCategory] = useState("all")
  const [remote, setRemote] = useState<TrajectoryPageView | null>(null)
  const [loading, setLoading] = useState(false)
  const local = organizationItems(snapshot).filter((item) => (agent === "all" || item.agent === agent) && (category === "all" || item.event.type.startsWith(`${category}.`)))

  useEffect(() => {
    if (isDemo) return
    let active = true
    setLoading(true)
    const params = new URLSearchParams({ limit: "100" })
    if (agent !== "all") params.set("agent", agent)
    if (category !== "all") params.set("type", category)
    void fetch(`/api/trajectory?${params}`, { cache: "no-store" }).then((response) => {
      if (!response.ok) throw new Error(`trajectory request failed (${response.status})`)
      return response.json() as Promise<TrajectoryPageView>
    }).then((page) => { if (active) setRemote(page) }).catch(() => { if (active) setRemote(null) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [agent, category])

  const items = isDemo ? local : remote?.items ?? local
  const loadOlder = async () => {
    if (!remote?.nextBeforeSeq || loading) return
    setLoading(true)
    const params = new URLSearchParams({ limit: "100", beforeSeq: String(remote.nextBeforeSeq) })
    if (agent !== "all") params.set("agent", agent)
    if (category !== "all") params.set("type", category)
    try {
      const response = await fetch(`/api/trajectory?${params}`, { cache: "no-store" })
      if (!response.ok) throw new Error(`trajectory request failed (${response.status})`)
      const page = await response.json() as TrajectoryPageView
      setRemote({ items: [...remote.items, ...page.items], nextBeforeSeq: page.nextBeforeSeq })
    } finally { setLoading(false) }
  }

  return <Page title="Organization trajectory" description="Goal, wake, handoff, mail, action, and observation milestones across every agent."><div className="org-trajectory-toolbar"><TrajectorySelect label="Agent" value={agent} onValueChange={setAgent} options={[{ value: "all", label: "All agents" }, ...snapshot.team.map((member) => ({ value: member.agent, label: displayAgent(member.agent) }))]} /><TrajectorySelect label="Event" value={category} onValueChange={setCategory} options={[{ value: "all", label: "All milestones" }, ...["goal", "delegation", "wake", "handoff", "mail", "schedule", "action", "metric"].map((value) => ({ value, label: capitalize(value) }))]} /></div><div className="org-event-list">{items.map((item) => <OrganizationEvent key={item.event.seq} item={item} wake={item.wakeId ? snapshot.wakes.find((wake) => wake.id === item.wakeId) : undefined} onOpenSession={onOpenSession} />)}{!items.length && <Empty text="No organization milestones match these filters." />}</div>{remote?.nextBeforeSeq && <button className="load-older" disabled={loading} onClick={loadOlder}>{loading ? "Loading…" : "Load older events"}</button>}</Page>
}

function TrajectorySelect({ label, value, onValueChange, options }: { label: string; value: string; onValueChange(value: string): void; options: Array<{ value: string; label: string }> }) {
  return <div className="trajectory-filter"><span>{label}</span><Select.Root value={value} onValueChange={onValueChange}><Select.Trigger aria-label={label}><Select.Value /><Select.Icon><ChevronDown /></Select.Icon></Select.Trigger><Select.Portal><Select.Content className="session-select-content" position="popper" sideOffset={6}><Select.Viewport>{options.map((option) => <Select.Item className="session-select-item" value={option.value} key={option.value}><Select.ItemText>{option.label}</Select.ItemText><Select.ItemIndicator className="session-check"><Check /></Select.ItemIndicator></Select.Item>)}</Select.Viewport></Select.Content></Select.Portal></Select.Root></div>
}

function OrganizationEvent({ item, wake, onOpenSession }: { item: TrajectoryItemView; wake?: ConsoleSnapshot["wakes"][number]; onOpenSession(wakeId: string): void }) {
  return <article className="org-event"><time>{formatDateTime(item.event.ts)}</time><i className={`event-dot ${eventTone(item.event)}`} /><div><header><strong>{displayAgent(item.agent)}</strong><span>{item.event.type}</span></header><p>{eventNarrative(item.event, item.agent)}</p><small>Seq #{item.event.seq}</small></div>{wake && item.wakeId && <button onClick={() => onOpenSession(item.wakeId!)}>Session<ChevronRight /></button>}{wake && <Status status={wake.status} />}</article>
}

function SessionTrace({ snapshot, selectedWakeId, onSelectWake, onBack }: { snapshot: ConsoleSnapshot; selectedWakeId: string | null; onSelectWake(wakeId: string): void; onBack(): void }) {
  const sessions = snapshot.wakes
  const selected = sessions.find((wake) => wake.id === selectedWakeId) ?? sessions.find((wake) => wake.status === "running") ?? sessions[0]
  const [query, setQuery] = useState("")
  const [remoteSession, setRemoteSession] = useState<SessionView | null>(null)
  useEffect(() => {
    if (isDemo || !selected) return
    let active = true
    const load = async () => {
      const response = await fetch(`/api/sessions/${encodeURIComponent(selected.id)}`, { cache: "no-store" })
      if (!response.ok) return
      const session = await response.json() as SessionView
      if (active) setRemoteSession(session)
    }
    void load()
    const timer = window.setInterval(load, 2_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [selected?.id])
  const wakeEvents = !isDemo && remoteSession?.wake.id === selected?.id ? remoteSession.events : snapshot.events.filter((event) => event.streamId === `wake:${selected?.id}`)
  const sessionEvents = wakeEvents.filter(isTraceEvent)
  const visibleEvents = sessionEvents.filter((event) => `${event.type} ${JSON.stringify(event.data)}`.toLowerCase().includes(query.toLowerCase()))
  const rows = traceRows(visibleEvents)
  const turns = traceRows(sessionEvents).at(-1)?.turn ?? 0
  const calls = sessionEvents.filter((event) => event.type === "tool.called").length
  const selectSession = (wakeId: string) => { setQuery(""); onSelectWake(wakeId) }
  return (
    <Page title="Session" description="One wake, turn by turn.">
      <button className="back-to-trajectory" onClick={onBack}><ArrowLeft /> Organization trajectory</button>
      <div className="trace-toolbar">
        <div className="session-field"><span>Session</span><Select.Root value={selected?.id ?? ""} onValueChange={selectSession}><Select.Trigger className="session-select" aria-label="Session"><Select.Value /><Select.Icon><ChevronDown /></Select.Icon></Select.Trigger><Select.Portal><Select.Content className="session-select-content" position="popper" sideOffset={6}><Select.Viewport>{sessions.map((wake) => <Select.Item className="session-select-item" value={wake.id} key={wake.id}><Select.ItemText>{displayAgent(wake.agent)} · {wake.id} · {wake.status}</Select.ItemText><Select.ItemIndicator className="session-check"><Check /></Select.ItemIndicator></Select.Item>)}</Select.Viewport></Select.Content></Select.Portal></Select.Root></div>
        <div className="trace-stats"><span><Clock3 /> {traceDuration(sessionEvents)}</span><span><Route /> {turns} turns</span><span><Activity /> {calls} calls</span></div>
        <label className="trace-search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search this session" /></label>
      </div>
      {sessionEvents.length === 0 ? <TraceEmptyState wake={selected} /> : <section className="trace-surface"><TraceMap events={sessionEvents} />{visibleEvents.length === 0 ? <TraceNoResults query={query} /> : <TraceEventList rows={rows} />}</section>}
    </Page>
  )
}

function TraceEventList({ rows }: { rows: ReturnType<typeof traceRows> }) {
  return <ScrollArea.Root className="trace-scroll"><ScrollArea.Viewport><div className="trace-list">{rows.map(({ event, turnStart, turn }) => <TraceRow key={event.seq} event={event} turnStart={turnStart} turn={turn} />)}</div></ScrollArea.Viewport><ScrollArea.Scrollbar className="trace-scrollbar" orientation="vertical"><ScrollArea.Thumb /></ScrollArea.Scrollbar></ScrollArea.Root>
}

function TraceEmptyState({ wake }: { wake: ConsoleSnapshot["wakes"][number] | undefined }) {
  const queued = wake?.status === "queued"
  return <section className="trace-empty-state"><Activity /><h2>{queued ? "Trace begins when this wake runs" : "No session trace yet"}</h2><p>{queued ? `${displayAgent(wake.agent)} is queued. Input, model, and tool events will appear after the Supervisor starts this wake.` : "The Supervisor has not recorded any input, model, or tool events for this wake."}</p>{wake && <Status status={wake.status} />}</section>
}

function TraceNoResults({ query }: { query: string }) {
  return <section className="trace-no-results"><Search /><p>No events match “{query}”.</p></section>
}

function Ledger({ snapshot }: { snapshot: ConsoleSnapshot }) {
  const [mode, setMode] = useState<"work" | "raw">("work")
  const [filter, setFilter] = useState("all")
  const [query, setQuery] = useState("")
  const records = snapshot.events.filter((event) => event.type === "handoff.recorded" && `${event.actor} ${JSON.stringify(event.data)}`.toLowerCase().includes(query.toLowerCase())).reverse()
  const filtered = snapshot.events.filter((event) => (filter === "all" || event.type.startsWith(`${filter}.`)) && `${event.actor} ${event.type} ${event.streamId} ${JSON.stringify(event.data)}`.toLowerCase().includes(query.toLowerCase())).reverse()
  return (
    <Page title="Work Ledger" description="Agent-authored records. Raw events remain available for audit.">
      <Tabs.Root value={mode} onValueChange={(value) => setMode(value as "work" | "raw")}>
        <div className="ledger-mode"><Tabs.List aria-label="Ledger view"><Tabs.Trigger value="work">Work records</Tabs.Trigger><Tabs.Trigger value="raw">Raw events</Tabs.Trigger></Tabs.List><label><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={mode === "work" ? "Search work records" : "Search events"} /></label></div>
        <Tabs.Content value="work"><div className="work-ledger">{records.map((event) => <WorkRecord key={event.seq} event={event} onRaw={() => setMode("raw")} />)}{!records.length && <Empty text="No agent-authored work records yet." />}</div></Tabs.Content>
        <Tabs.Content value="raw"><div className="ledger-toolbar"><div>{["all", "goal", "wake", "mail", "action", "session"].map((item) => <button className={filter === item ? "selected" : ""} key={item} onClick={() => setFilter(item)}>{capitalize(item)}</button>)}</div></div><div className="ledger-table" role="table"><div className="ledger-head" role="row"><span>Seq</span><span>Local time</span><span>Stream</span><span>Actor</span><span>Event</span><span>Fact</span></div>{filtered.map((event) => <div className="ledger-row" role="row" key={event.seq}><code>{event.seq}</code><time>{formatTime(event.ts)}</time><code>{event.streamId}</code><span>{displayAgent(event.actor)}</span><strong>{event.type}</strong><span>{summarize(event.data)}</span></div>)}{!filtered.length && <Empty text="No matching events." />}</div></Tabs.Content>
      </Tabs.Root>
    </Page>
  )
}

function Agents({ snapshot, selected, onSelect, onOpenSession }: { snapshot: ConsoleSnapshot; selected: string; onSelect(agent: string): void; onOpenSession(wakeId: string): void }) {
  const member = snapshot.team.find((item) => item.agent === selected) ?? snapshot.team[0]
  const goals = snapshot.goals.filter((goal) => goal.owner === member?.agent)
  const sessions = snapshot.wakes.filter((wake) => wake.agent === member?.agent).sort((a, b) => b.enqueuedSeq - a.enqueuedSeq)
  const workRecords = snapshot.events.filter((event) => event.actor === member?.agent && event.type === "handoff.recorded").reverse()
  return (
    <Page title="Agents">
      <div className="agents-workbench">
        <div className="agent-roster">{snapshot.team.map((item) => <button key={item.agent} className={item.agent === member?.agent ? "selected" : ""} onClick={() => onSelect(item.agent)}><Bot /><span><strong>{displayAgent(item.agent)}</strong><small>{snapshot.goals.find((goal) => goal.owner === item.agent)?.objective ?? "No owned goal"}</small></span><Status status={item.status} /></button>)}</div>
        {member && <div className="agent-detail"><div className="agent-detail-head"><Bot /><div><h2>{displayAgent(member.agent)}</h2><Status status={member.status} /></div></div><section><h3>Owned goals</h3>{goals.map((goal) => <div className="owned-goal" key={goal.id}><strong>{goal.objective}</strong><span>{goal.observationMethod ?? "Observation method pending"}</span></div>)}</section><section><h3>Sessions</h3><div className="session-list">{sessions.map((wake) => <button key={wake.id} onClick={() => onOpenSession(wake.id)}><span><strong>{wake.id}</strong><small>{wake.triggerRef}</small></span><Status status={wake.status} /><ChevronRight /></button>)}{!sessions.length && <Empty text="No sessions for this agent yet." />}</div></section><section><h3>Work records</h3>{workRecords.map((event) => <WorkRecord key={event.seq} event={event} compact onOpen={() => onOpenSession(event.streamId.replace("wake:", ""))} />)}{!workRecords.length && <Empty text="No agent-authored work records yet." />}</section></div>}
      </div>
    </Page>
  )
}

function TraceMap({ events }: { events: EventView[] }) {
  return <section className="trace-map" aria-label="Session activity map"><div className="trace-labels"><span>Input</span><span>Model</span><span>Tools</span></div><div className="trace-lanes">{["input", "model", "tool"].map((lane) => <div className={`trace-lane ${lane}`} key={lane}>{events.map((event) => <i key={`${lane}-${event.seq}`} className={traceLane(event) === lane ? "filled" : ""} />)}</div>)}</div></section>
}

function TraceRow({ event, turnStart, turn }: { event: EventView; turnStart: boolean; turn: number }) {
  const label = traceLabel(event)
  const isTool = ["tool.called", "tool.completed"].includes(event.type)
  const row = <><span className="trace-rail-cell">{turnStart && <span className="turn-label">Turn {turn}</span>}<i className="trace-node" /></span><span className={`trace-kind trace-${label.toLowerCase()}`}>{label}</span><div className="trace-content"><strong>{traceText(event)}</strong></div><time>{formatTime(event.ts)}</time><code className="trace-seq">#{event.seq}</code></>
  if (!isTool) return <div className={turnStart ? "trace-row turn-start" : "trace-row"}>{row}</div>
  return <Collapsible.Root className={turnStart ? "trace-collapsible turn-start" : "trace-collapsible"}><Collapsible.Trigger className="trace-row trace-row-trigger" aria-label={`Show payload for ${traceText(event)}`}>{row}<ChevronRight className="trace-expand" /></Collapsible.Trigger><Collapsible.Content className="trace-payload"><TracePayload value={event.data} /></Collapsible.Content></Collapsible.Root>
}

function TracePayload({ value }: { value: unknown }) {
  const [copied, setCopied] = useState(false)
  const text = formatPayload(value)
  const copy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_200)
  }
  return <div className="trace-payload-inner"><header><span>Full payload</span><button onClick={copy}>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy"}</button></header><pre><code>{text}</code></pre></div>
}

function WorkRecord({ event, compact = false, onOpen, onRaw }: { event: EventView; compact?: boolean; onOpen?: () => void; onRaw?: () => void }) {
  const data = record(event.data)
  const observations = stringArray(data.observations)
  const results = stringArray(data.results)
  const nextSteps = stringArray(data.nextSteps)
  const blocker = typeof data.blocker === "string" ? data.blocker : null
  const summary = results[0] ?? observations[0] ?? "Work recorded"
  return <Accordion.Root className={compact ? "work-record compact" : "work-record"} type="single" collapsible><Accordion.Item value={`record-${event.seq}`}><Accordion.Header><Accordion.Trigger className="work-record-summary"><Bot /><span className="record-agent"><strong>{displayAgent(event.actor)}</strong><small>{formatDateTime(event.ts)} · #{event.seq}</small></span><span className="record-outcome">{summary}</span>{nextSteps[0] && <span className="record-next">Next: {nextSteps[0]}</span>}<ChevronRight /></Accordion.Trigger></Accordion.Header><Accordion.Content className="work-record-content"><div className="work-record-body"><RecordSection title="Observed" values={observations} /><RecordSection title="Completed" values={results} /><RecordSection title="Next" values={nextSteps} />{blocker && <RecordSection title="Blocked" values={[blocker]} tone="danger" />}</div>{(onOpen || onRaw) && <footer>{onOpen && <button onClick={onOpen}>Open session</button>}{onRaw && <button onClick={onRaw}>Raw events</button>}</footer>}</Accordion.Content></Accordion.Item></Accordion.Root>
}

function RecordSection({ title, values, tone }: { title: string; values: string[]; tone?: string }) {
  if (!values.length) return null
  return <section className={tone === "danger" ? "record-section danger" : "record-section"}><h3>{title}</h3>{values.map((value) => <p key={value}>{value}</p>)}</section>
}

function SettingsView({ snapshot }: { snapshot: ConsoleSnapshot }) {
  return <Page title="Settings" description="Local Console runtime details. Agent and connector configuration remains authoritative in goah.config.json."><div className="settings-list"><div><span>Mode</span><strong>Local, loopback only</strong></div><div><span>Refresh</span><strong>Every 2 seconds</strong></div><div><span>Latest event</span><strong>Seq #{snapshot.seq}</strong></div><div><span>Event payloads</span><strong>Redacted by default</strong></div></div></Page>
}

function CeoComposer({ onClose }: { onClose(): void }) {
  const [message, setMessage] = useState("")
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle")
  const submit = async () => {
    if (!message.trim()) return
    setState("sending")
    try {
      const response = await fetch("/api/ceo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) })
      if (!response.ok) throw new Error("send failed")
      setState("sent")
      window.setTimeout(onClose, 700)
    } catch { setState("error") }
  }
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}><Dialog.Portal><Dialog.Overlay className="modal-backdrop" /><Dialog.Content className="composer"><Dialog.Close className="close" aria-label="Close"><X /></Dialog.Close><p>CEO</p><Dialog.Title id="composer-title">Give the organization new context</Dialog.Title><Dialog.Description className="sr-only">Send durable context or a goal change to the CEO agent.</Dialog.Description><textarea autoFocus value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Change the goal, report a constraint, or ask what happens next…" /><div><span>{state === "error" ? "Could not reach the Supervisor." : state === "sent" ? "Delivered to CEO." : "This becomes durable decision mail."}</span><button className="primary" disabled={!message.trim() || state === "sending"} onClick={submit}><Send /> {state === "sending" ? "Sending…" : "Send to CEO"}</button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
  )
}

function Page({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section className="page"><header><h1>{title}</h1>{description && <span>{description}</span>}</header>{children}</section>
}

function Status({ status }: { status: string }) { return <span className={`status status-${status}`}><i />{capitalize(status.replaceAll("_", " "))}</span> }
function Empty({ text }: { text: string }) { return <p className="empty">{text}</p> }

function LoadingState({ connection }: { connection: string }) { return <main className="loading"><img src="/goah-orbital-mark.png" alt="" /><h1>Goah Console</h1><p>{connection === "error" ? "Could not reach the local Supervisor." : "Connecting to the local Supervisor…"}</p></main> }
function trajectoryEvents(events: EventView[]): EventView[] { return events.filter((event) => isOrganizationEvent(event.type)) }
function organizationItems(snapshot: ConsoleSnapshot): TrajectoryItemView[] {
  const wakeAgents = new Map(snapshot.wakes.map((wake) => [wake.id, wake.agent]))
  return trajectoryEvents(snapshot.events).slice().reverse().map((event) => {
    const wakeId = event.streamId.startsWith("wake:") ? event.streamId.slice("wake:".length) : null
    return { event, wakeId, agent: wakeId ? wakeAgents.get(wakeId) ?? event.actor : event.actor }
  })
}
function isOrganizationEvent(type: string): boolean { if (["wake.lease_renewed", "wake.runner_attached"].includes(type)) return false; return ["goal.", "delegation.", "handoff.", "wake.", "mail.", "schedule.", "action.", "metric.", "observation.", "ceo.", "human."].some((prefix) => type.startsWith(prefix)) }
function eventNarrative(event: EventView, resolvedAgent = event.actor): string {
  const data = record(event.data)
  if (event.type === "handoff.recorded") return `Handoff: ${firstString(data.results) || firstString(data.observations) || "work recorded"}`
  if (event.type === "goal.delegated") return `CEO delegated: ${String(data.reason ?? data.goalId ?? "child goal")}`
  if (event.type === "delegation.created") return `Delegated a child goal: ${String(data.reason ?? data.goalId ?? "new responsibility")}`
  if (event.type === "goal.put") { const snapshot = record(data.snapshot); return `Goal ${String(snapshot.phase ?? "updated")}: ${String(snapshot.objective ?? "goal state changed")}` }
  if (event.type === "goal.reassigned") return `Reassigned goal from ${displayAgent(String(data.oldOwner ?? "unknown"))} to ${displayAgent(String(data.newOwner ?? "unknown"))}`
  if (event.type === "metric.evaluated" || event.type === "observation.confirmed") return `Observation confirmed: ${String(data.summary ?? data.status ?? "evidence recorded")}`
  if (event.type === "action.requested") return `Action awaiting approval: ${String(data.kind ?? "external action")}`
  if (event.type === "wake.enqueued") return "Wake queued"
  if (event.type === "wake.running") return "Wake started"
  if (event.type === "wake.done") return "Wake completed"
  if (event.type === "wake.abnormal" || event.type === "wake.expired_abnormal" || event.type === "wake.abnormal_reason") return "Wake became abnormal"
  if (event.type === "schedule.put") { const snapshot = record(data.snapshot); return `Next wake scheduled for ${formatDateTime(String(snapshot.nextWakeAt ?? ""))}: ${String(snapshot.reason ?? "scheduled work")}` }
  if (event.type === "mail.put") { const snapshot = record(data.snapshot); return `Mail from ${displayAgent(String(snapshot.from ?? event.actor))} to ${displayAgent(String(snapshot.to ?? "unknown"))}` }
  if (event.type === "mail.sent" || event.type === "mail.delivered") return `Mail delivered: ${String(data.summary ?? data.level ?? "message")}`
  return `${event.type.replaceAll(".", " ")}: ${summarize(event.data)}`
}
function eventTone(event: EventView): string { if (event.type.includes("abnormal") || event.type.includes("failed")) return "danger"; if (event.type.startsWith("action.")) return "attention-tone"; if (event.type.startsWith("metric.") || event.type.includes("confirmed")) return "success"; return "active-tone" }
function displayAgent(value: string): string { if (value === "ceo") return "CEO"; if (value === "human") return "Human"; if (value === "supervisor") return "Supervisor"; return `${capitalize(value.replaceAll("-", " "))} Agent` }
function capitalize(value: string): string { return value ? value[0]!.toUpperCase() + value.slice(1) : value }
function formatTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) }
function formatDateTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) }
function relativeTime(value: string, from = new Date().toISOString()): string { const minutes = Math.round((new Date(value).getTime() - new Date(from).getTime()) / 60_000); return minutes > 0 ? `in ${minutes}m` : minutes === 0 ? "now" : `${Math.abs(minutes)}m ago` }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function firstString(value: unknown): string { return Array.isArray(value) && typeof value[0] === "string" ? value[0] : "" }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [] }
function isTraceEvent(event: EventView): boolean { return ["session.started", "request.prepared", "turn.started", "message.user", "message.assistant.completed", "tool.called", "tool.completed", "context.compacted", "turn.completed", "handoff.recorded", "session.completed", "session.interrupted"].includes(event.type) }
function traceLane(event: EventView): "input" | "model" | "tool" | "none" { if (["message.user", "request.prepared", "context.compacted"].includes(event.type)) return "input"; if (event.type.startsWith("message.assistant")) return "model"; if (event.type.startsWith("tool.")) return "tool"; return "none" }
function traceLabel(event: EventView): string { if (event.type === "message.user") return "User"; if (event.type === "message.assistant.completed") return "Assistant"; if (event.type === "request.prepared") return "Context"; if (event.type === "context.compacted") return "Compact"; if (event.type.startsWith("tool.")) return "Tool"; if (event.type === "handoff.recorded") return "Handoff"; return "System" }
function traceText(event: EventView): string {
  const data = record(event.data)
  if (event.type === "message.user" || event.type === "message.assistant.completed") return messageContent(data.message)
  if (event.type === "request.prepared") return typeof data.activeContext === "string" ? data.activeContext : "Model request prepared from Active Context"
  if (event.type === "context.compacted") return typeof data.summary === "string" ? data.summary : "Earlier messages compacted into a summary"
  if (event.type === "tool.called") return `${String(data.name ?? "tool")} called`
  if (event.type === "tool.completed") return `${String(data.name ?? "tool")} completed${data.isError ? " with error" : ""}`
  if (event.type === "handoff.recorded") return `Work record: ${firstString(data.results) || firstString(data.observations) || "handoff recorded"}`
  return event.type.replaceAll(".", " ")
}
function messageContent(value: unknown): string { const message = record(value); const content = message.content; if (typeof content === "string") return content; if (!Array.isArray(content)) return "Message recorded"; return content.map((item) => typeof item === "string" ? item : typeof item === "object" && item !== null && "text" in item ? String((item as { text?: unknown }).text ?? "") : "").filter(Boolean).join(" ") }
function traceRows(events: EventView[]): Array<{ event: EventView; turnStart: boolean; turn: number }> { let turn = 0; return events.map((event, index) => { const turnStart = event.type === "message.user" || event.type === "turn.started" || turn === 0 && index === 0; if (turnStart) turn += 1; return { event, turnStart, turn: Math.max(turn, 1) } }) }
function traceDuration(events: EventView[]): string { if (events.length < 2) return "0s"; const milliseconds = new Date(events.at(-1)!.ts).getTime() - new Date(events[0]!.ts).getTime(); const seconds = Math.max(0, Math.round(milliseconds / 1_000)); return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s` }
function summarize(value: unknown): string { const text = typeof value === "string" ? value : JSON.stringify(value); return text.length > 110 ? `${text.slice(0, 107)}…` : text }
function formatPayload(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value, null, 2) }
