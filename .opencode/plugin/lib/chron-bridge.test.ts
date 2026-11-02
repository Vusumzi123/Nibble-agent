import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { registerChronBridge } from "./chron-bridge.ts"
import { createChron } from "./chron/chron.ts"
import { readChronState } from "./chron/store.ts"
import type { ChronLog } from "./chron/types.ts"
import { createTask, listPendingTasks } from "./user-tasks.ts"
import { tempDir, writeSection } from "./test-utils.ts"

const HOUR = 3_600_000
const T0 = Date.parse("2026-11-01T09:00:00Z")

const silentLog: ChronLog = { event: () => {}, warn: () => {} }

async function setup(): Promise<{ dir: string; stateDir: string; logDir: string; scheduleDir: string }> {
  const dir = await tempDir("chron-bridge-")
  const scheduleDir = join(dir, ".opencode", "schedule")
  await mkdir(scheduleDir, { recursive: true })
  return {
    dir,
    stateDir: join(dir, ".opencode", "state"),
    logDir: join(dir, ".opencode", "logs"),
    scheduleDir,
  }
}

async function writeJob(scheduleDir: string, name: string, body: string): Promise<void> {
  await writeFile(join(scheduleDir, name), body, "utf8")
}

const JOB = `---
id: smoke
schedule: every 1m
agent: chat
---
Write the word smoke to the log.
`

test("a file-job fire writes one task with dedupe, ttl, and agent", async () => {
  const dirs = await setup()
  await writeJob(dirs.scheduleDir, "smoke.md", JOB)
  const chron = createChron({ directory: dirs.dir, stateDir: dirs.stateDir, logDir: dirs.logDir })
  registerChronBridge(chron, { directory: dirs.dir, stateDir: dirs.stateDir, log: silentLog })

  await chron.tick({ nowMs: T0 })
  await chron.tick({ nowMs: T0 + 60_000 })

  const pending = await listPendingTasks(dirs.stateDir)
  assert.equal(pending.length, 1)
  const task = pending[0]
  assert.equal(task.title, "[chron] Write the word smoke to the log.")
  assert.equal(task.requested_by, "chron")
  assert.equal(task.dedupe_key, "chron:smoke")
  assert.equal(task.agent, "chat")
  assert.equal(task.priority, 5)
  assert.equal(task.created_ms, T0 + 60_000)
  assert.equal(task.expires_ms, T0 + 60_000 + 24 * HOUR)
  assert.match(task.context, /source: .*smoke\.md/)
  assert.match(task.context, /occurrence: 2026-11-01T09:01:00\.000Z/)
})

test("a second fire while the task is pending does not create a duplicate", async () => {
  const dirs = await setup()
  await writeJob(dirs.scheduleDir, "smoke.md", JOB)
  const chron = createChron({ directory: dirs.dir, stateDir: dirs.stateDir, logDir: dirs.logDir })
  registerChronBridge(chron, { directory: dirs.dir, stateDir: dirs.stateDir, log: silentLog })

  await chron.tick({ nowMs: T0 })
  await chron.tick({ nowMs: T0 + 60_000 })
  await chron.tick({ nowMs: T0 + 120_000 })
  assert.equal((await listPendingTasks(dirs.stateDir)).length, 1)
})

test("a full task store returns defer and leaves the occurrence unadvanced", async () => {
  const dirs = await setup()
  for (let i = 0; i < 50; i++) {
    const created = await createTask(dirs.stateDir, { title: `filler ${i}`, prompt: "p" })
    assert.ok(created.ok)
  }
  await writeJob(dirs.scheduleDir, "smoke.md", JOB)
  const chron = createChron({ directory: dirs.dir, stateDir: dirs.stateDir, logDir: dirs.logDir })
  registerChronBridge(chron, { directory: dirs.dir, stateDir: dirs.stateDir, log: silentLog })

  await chron.tick({ nowMs: T0 })
  const result = await chron.tick({ nowMs: T0 + 60_000 })
  assert.deepEqual(result.deferred, ["smoke"])
  assert.equal((await listPendingTasks(dirs.stateDir)).length, 50)

  const state = await readChronState(join(dirs.stateDir, "chron.json"))
  assert.equal(state.jobs.smoke.last_fired_ms, T0)
  assert.equal(state.jobs.smoke.first_deferred_ms, T0 + 60_000)
})

test("level 0 consumes the occurrence without writing a task", async () => {
  const dirs = await setup()
  await writeSection(dirs.dir, "autonomy", ["level: 0"])
  await writeJob(dirs.scheduleDir, "smoke.md", JOB)
  const chron = createChron({ directory: dirs.dir, stateDir: dirs.stateDir, logDir: dirs.logDir })
  registerChronBridge(chron, { directory: dirs.dir, stateDir: dirs.stateDir, log: silentLog })

  await chron.tick({ nowMs: T0 })
  await chron.tick({ nowMs: T0 + 60_000 })
  assert.equal((await listPendingTasks(dirs.stateDir)).length, 0)
  const state = await readChronState(join(dirs.stateDir, "chron.json"))
  assert.equal(state.jobs.smoke.last_fired_ms, T0 + 60_000)
})

test("code-job fires are ignored by the bridge", async () => {
  const dirs = await setup()
  const chron = createChron({ directory: dirs.dir, stateDir: dirs.stateDir, logDir: dirs.logDir })
  registerChronBridge(chron, { directory: dirs.dir, stateDir: dirs.stateDir, log: silentLog })
  let codeRuns = 0
  chron.register({ id: "code", schedule: "every 1m", handler: () => void codeRuns++ })

  await chron.tick({ nowMs: T0 })
  await chron.tick({ nowMs: T0 + 60_000 })
  assert.equal(codeRuns, 1)
  assert.equal((await listPendingTasks(dirs.stateDir)).length, 0)
})
