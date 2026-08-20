export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export interface GoalView {
  id: string
  parentId: string | null
  objective: string
  observationMethod: string | null
  owner: string
  phase: "active" | "paused" | "blocked" | "complete"
  revision: number
}

export interface TeamView {
  agent: string
  goalIds: string[]
  status: "running" | "queued" | "scheduled" | "waiting" | "blocked" | "idle_unplanned" | "retired"
  lastHandoffSeq: number | null
  lastWakeStatus: string | null
  nextWakeAt: string | null
}

export interface WakeView {
  id: string
  agent: string
  triggerRef: string
  status: string
  leaseUntil: string | null
  startedAt: string | null
  endedAt: string | null
  runnerPid: number | null
  enqueuedSeq: number
}

export interface ActionView {
  id: string
  agent: string
  kind: string
  connector: string
  reason: string
  status: string
  gated: boolean
  evidence: number[]
}

export interface ScheduleView { id: string; agent: string; nextWakeAt: string; reason: string; setBy: string }
export interface MailView { id: string; to: string; from: string; level: string; body: JsonValue; readAt: string | null }
export interface EventView { seq: number; streamId: string; streamSeq: number; ts: string; actor: string; type: string; data: JsonValue }
export interface TrajectoryItemView { event: EventView; agent: string; wakeId: string | null }
export interface TrajectoryPageView { items: TrajectoryItemView[]; nextBeforeSeq: number | null }
export interface SessionView { wake: WakeView; events: EventView[] }

export interface ConsoleSnapshot {
  seq: number
  now: string
  goals: GoalView[]
  team: TeamView[]
  wakes: WakeView[]
  actions: ActionView[]
  schedules: ScheduleView[]
  mailbox: MailView[]
  events: EventView[]
}
