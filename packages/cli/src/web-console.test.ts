import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createRuntime, defaultConfig, loadConfig } from "./index.js"
import { consoleMetadataPath, readConsoleMetadata, runWebConsole } from "./web-console.js"

test("local Console serves assets, redacted snapshots, and CEO control through Supervisor", async () => {
  const root = mkdtempSync(join(tmpdir(), "goah-console-"))
  const configPath = join(root, "goah.config.json")
  const config = { ...defaultConfig(root, { provider: "faux" }), stateDir: join(root, "state") }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  const runtime = createRuntime(loadConfig(configPath))
  runtime.ledger.putMail({ id: "secret-mail", to: "ceo", from: "human", level: "decision", body: { apiKey: "sk-do-not-expose-123456789" }, readAt: null }, "human")

  const controller = new AbortController()
  let resolveListening!: () => void
  const listening = new Promise<void>((resolve) => { resolveListening = resolve })
  const server = runWebConsole(runtime.supervisor, runtime.ledger, config.stateDir, controller.signal, { onListening: resolveListening })
  await listening
  const metadata = readConsoleMetadata(config.stateDir)
  assert.ok(metadata)

  const page = await fetch(metadata.url)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /Goah Console/)

  const ceoResponse = await fetch(`${metadata.url}api/ceo?token=${metadata.token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Launch a profitable store" }),
  })
  assert.equal(ceoResponse.status, 202)
  assert.equal(runtime.ledger.goals()[0]?.objective, "Launch a profitable store")

  const snapshotResponse = await fetch(`${metadata.url}api/snapshot?token=${metadata.token}`)
  assert.equal(snapshotResponse.status, 200)
  const snapshotText = await snapshotResponse.text()
  assert.match(snapshotText, /Launch a profitable store/)
  assert.doesNotMatch(snapshotText, /sk-do-not-expose/)
  assert.match(snapshotText, /\[REDACTED\]/)

  const trajectoryResponse = await fetch(`${metadata.url}api/trajectory?limit=2&token=${metadata.token}`)
  assert.equal(trajectoryResponse.status, 200)
  const trajectory = await trajectoryResponse.json() as { items: Array<{ event: { seq: number; type: string }; agent: string; wakeId: string | null }> }
  assert.ok(trajectory.items.length > 0)
  assert.ok(trajectory.items.every((item, index, items) => index === 0 || items[index - 1]!.event.seq > item.event.seq))

  const wakeId = runtime.ledger.wakes()[0]!.id
  const sessionResponse = await fetch(`${metadata.url}api/sessions/${encodeURIComponent(wakeId)}?token=${metadata.token}`)
  assert.equal(sessionResponse.status, 200)
  const session = await sessionResponse.json() as { wake: { id: string }; events: Array<{ streamId: string }> }
  assert.equal(session.wake.id, wakeId)
  assert.ok(session.events.every((event) => event.streamId === `wake:${wakeId}`))

  controller.abort()
  await server
  assert.equal(readConsoleMetadata(config.stateDir), null)
  assert.equal(consoleMetadataPath(config.stateDir), join(config.stateDir, "console.json"))
  runtime.ledger.close()
})
