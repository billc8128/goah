import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import type { JsonValue, Ledger } from "goah-ledger-contract"
import type { Supervisor } from "goah-supervisor"
import { redactValue } from "./inspect.js"

export interface ConsoleMetadata { url: string; host: string; port: number; pid: number; token: string }
export interface TrajectoryItem { event: JsonValue; agent: string; wakeId: string | null }
export interface TrajectoryPage { items: TrajectoryItem[]; nextBeforeSeq: number | null }

const assetsDirectory = fileURLToPath(new URL("./console/", import.meta.url))

export function consoleMetadataPath(stateDir: string): string { return join(stateDir, "console.json") }

export function readConsoleMetadata(stateDir: string): ConsoleMetadata | null {
  const path = consoleMetadataPath(stateDir)
  if (!existsSync(path)) return null
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as ConsoleMetadata
    if (!value.url || !Number.isInteger(value.port) || !value.token) return null
    return value
  } catch { return null }
}

export function consoleSnapshot(ledger: Ledger, supervisor: Supervisor, now = new Date().toISOString()): JsonValue {
  const events = ledger.events().slice(-300).map((event) => redactValue(event))
  return redactValue({
    seq: ledger.events().at(-1)?.seq ?? 0,
    now,
    goals: ledger.goals(),
    team: supervisor.teamList(now),
    wakes: ledger.wakes(),
    actions: ledger.actions(),
    schedules: ledger.schedules(),
    mailbox: ledger.mailbox(),
    events,
  }) as JsonValue
}

export function organizationTrajectory(ledger: Ledger, options: { beforeSeq?: number; limit?: number; agent?: string; type?: string } = {}): TrajectoryPage {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200)
  const beforeSeq = options.beforeSeq ?? Number.MAX_SAFE_INTEGER
  const wakeAgents = new Map(ledger.wakes().map((wake) => [wake.id, wake.agent]))
  const candidates = ledger.events().filter((event) => {
    if (event.seq >= beforeSeq || !isTrajectoryEvent(event.type)) return false
    const wakeId = event.streamId.startsWith("wake:") ? event.streamId.slice("wake:".length) : null
    const agent = wakeId ? wakeAgents.get(wakeId) ?? event.actor : event.actor
    if (options.agent && agent !== options.agent) return false
    if (options.type && !event.type.startsWith(`${options.type}.`)) return false
    return true
  }).reverse()
  const page = candidates.slice(0, limit)
  return {
    items: page.map((event) => {
      const wakeId = event.streamId.startsWith("wake:") ? event.streamId.slice("wake:".length) : null
      return { event: redactValue(event) as JsonValue, agent: wakeId ? wakeAgents.get(wakeId) ?? event.actor : event.actor, wakeId }
    }),
    nextBeforeSeq: candidates.length > limit ? page.at(-1)?.seq ?? null : null,
  }
}

export async function runWebConsole(
  supervisor: Supervisor,
  ledger: Ledger,
  stateDir: string,
  signal: AbortSignal,
  options: { host?: string; port?: number; onListening?: (metadata: ConsoleMetadata) => void } = {},
): Promise<void> {
  const host = options.host ?? "127.0.0.1"
  const token = randomUUID()
  const server = createServer((request, response) => { void route(request, response, supervisor, ledger, token) })
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 0, host, resolve) })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("console server did not bind a TCP port")
  const metadata: ConsoleMetadata = { url: `http://${host}:${address.port}/`, host, port: address.port, pid: process.pid, token }
  const metadataPath = consoleMetadataPath(stateDir)
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 })
  if (process.platform !== "win32") chmodSync(metadataPath, 0o600)
  options.onListening?.(metadata)
  await new Promise<void>((resolve) => {
    const stop = () => server.close(() => resolve())
    if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true })
  })
  rmSync(metadataPath, { force: true })
}

async function route(request: IncomingMessage, response: ServerResponse, supervisor: Supervisor, ledger: Ledger, token: string): Promise<void> {
  setHeaders(response)
  const url = new URL(request.url ?? "/", "http://127.0.0.1")
  if (url.pathname.startsWith("/api/")) {
    if (!authorized(request, url, token)) { sendJson(response, 403, { error: "console authorization failed" }); return }
    if (request.method === "GET" && url.pathname === "/api/snapshot") { sendJson(response, 200, consoleSnapshot(ledger, supervisor)); return }
    if (request.method === "GET" && url.pathname === "/api/trajectory") {
      const options: { beforeSeq?: number; limit?: number; agent?: string; type?: string } = {}
      const beforeSeq = positiveInteger(url.searchParams.get("beforeSeq")); if (beforeSeq) options.beforeSeq = beforeSeq
      const limit = positiveInteger(url.searchParams.get("limit")); if (limit) options.limit = limit
      const agent = nonEmpty(url.searchParams.get("agent")); if (agent) options.agent = agent
      const type = nonEmpty(url.searchParams.get("type")); if (type) options.type = type
      sendJson(response, 200, organizationTrajectory(ledger, options))
      return
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
      const wakeId = decodeURIComponent(url.pathname.slice("/api/sessions/".length))
      const wake = ledger.wake(wakeId)
      if (!wake) { sendJson(response, 404, { error: "wake not found" }); return }
      sendJson(response, 200, redactValue({ wake, events: ledger.eventsForWake(wakeId) }))
      return
    }
    if (request.method === "POST" && url.pathname === "/api/ceo") {
      const body = await readBody(request)
      const message = typeof body.message === "string" ? body.message.trim() : ""
      if (!message) { sendJson(response, 400, { error: "message is required" }); return }
      const root = ledger.goals().find((goal) => goal.parentId === null && goal.owner === "ceo" && goal.phase !== "complete")
      sendJson(response, 202, root ? supervisor.sendToCeo({ message }) : supervisor.startGoal(message))
      return
    }
    sendJson(response, 404, { error: "not found" }); return
  }

  if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405); response.end(); return }
  const relative = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^\/+/, "")
  if (relative === "index.html") response.setHeader("set-cookie", `goah_console=${token}; Path=/; HttpOnly; SameSite=Strict`)
  const path = join(assetsDirectory, relative)
  if (!path.startsWith(assetsDirectory) || !existsSync(path) || !statSync(path).isFile()) {
    const fallback = join(assetsDirectory, "index.html")
    if (!existsSync(fallback)) { response.writeHead(503); response.end("Console assets are not built. Run npm run build."); return }
    serveFile(response, fallback, request.method === "HEAD")
    return
  }
  serveFile(response, path, request.method === "HEAD")
}

function isTrajectoryEvent(type: string): boolean {
  if (["wake.lease_renewed", "wake.runner_attached"].includes(type)) return false
  return ["goal.", "delegation.", "handoff.", "wake.", "mail.", "schedule.", "action.", "metric.", "observation.", "ceo.", "human."].some((prefix) => type.startsWith(prefix))
}

function positiveInteger(value: string | null): number | undefined { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined }
function nonEmpty(value: string | null): string | undefined { const result = value?.trim(); return result ? result : undefined }

function authorized(request: IncomingMessage, url: URL, token: string): boolean {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token")
  if (supplied === token) return true
  const cookieToken = request.headers.cookie?.split(";").map((value) => value.trim()).find((value) => value.startsWith("goah_console="))?.slice("goah_console=".length)
  if (cookieToken === token) return true
  const referer = request.headers.referer
  return Boolean(referer && referer.startsWith(`http://${request.headers.host}/`))
}

function serveFile(response: ServerResponse, path: string, head: boolean): void {
  const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".map": "application/json" }
  response.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream", "cache-control": extname(path) === ".html" ? "no-store" : "public, max-age=31536000, immutable" })
  response.end(head ? undefined : readFileSync(path))
}

function setHeaders(response: ServerResponse): void {
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
  response.setHeader("referrer-policy", "no-referrer")
  response.setHeader("x-content-type-options", "nosniff")
  response.setHeader("x-frame-options", "DENY")
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  response.end(`${JSON.stringify(value)}\n`)
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = ""
  for await (const chunk of request) {
    body += chunk.toString()
    if (body.length > 65_536) throw new Error("request body is too large")
  }
  const parsed = JSON.parse(body || "{}")
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}
