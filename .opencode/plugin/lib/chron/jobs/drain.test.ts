import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { runDrainScan } from "./drain.ts"
import { readIntents } from "../../production/intents.ts"
import { emptyScheduler, saveWorkQueueState, WORK_QUEUE_FILE } from "../../work-queue.ts"
import { tempDir } from "../../test-utils.ts"
import type { ChronLog } from "../types.ts"

const silentLog: ChronLog = { event: () => {}, warn: () => {} }

async function setup(): Promise<{ dir: string; stateDir: string }> {
  const dir = await tempDir("chron-drain-")
  const stateDir = join(dir, ".opencode", "state")
  await mkdir(stateDir, { recursive: true })
  return { dir, stateDir }
}

async function config(dir: string, lines: string[]): Promise<void> {
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(join(dir, ".opencode", "sysop-config.yaml"), [...lines, ""].join("\n"), "utf8")
}

test("a due window emits exactly one drain-pass intent", async () => {
  const dirs = await setup()
  const first = await runDrainScan({
    directory: dirs.dir,
    stateDir: dirs.stateDir,
    log: silentLog,
    due: async () => ({ due: true }),
  })
  assert.deepEqual(first, { emitted: true, reason: "emitted" })

  const { intents } = await readIntents(dirs.stateDir)
  assert.equal(intents.length, 1)
  assert.equal(intents[0].intent.id, "drain-pass")
  assert.equal(intents[0].intent.kind, "drain-pass")
  assert.equal(intents[0].intent.priority, 3)

  const second = await runDrainScan({
    directory: dirs.dir,
    stateDir: dirs.stateDir,
    log: silentLog,
    due: async () => ({ due: true }),
  })
  assert.deepEqual(second, { emitted: false, reason: "pending-intent" })
  assert.equal((await readIntents(dirs.stateDir)).intents.length, 1)
})

test("no intent below the trigger", async () => {
  const dirs = await setup()
  const report = await runDrainScan({
    directory: dirs.dir,
    stateDir: dirs.stateDir,
    log: silentLog,
    due: async () => ({ due: false }),
  })
  assert.deepEqual(report, { emitted: false, reason: "not-due" })
  assert.deepEqual((await readIntents(dirs.stateDir)).intents, [])
})

test("a queued drain-pass suppresses a second intent", async () => {
  const dirs = await setup()
  await saveWorkQueueState(
    join(dirs.stateDir, WORK_QUEUE_FILE),
    [
      {
        id: "drain-pass",
        kind: "drain-pass",
        producer: "chron:drain",
        enqueued_ms: 1,
        requeue_count: 0,
      },
    ],
    emptyScheduler(),
  )
  const report = await runDrainScan({
    directory: dirs.dir,
    stateDir: dirs.stateDir,
    log: silentLog,
    due: async () => ({ due: true }),
  })
  assert.deepEqual(report, { emitted: false, reason: "queued" })
  assert.deepEqual((await readIntents(dirs.stateDir)).intents, [])
})

test("drain.enabled false skips the due check", async () => {
  const dirs = await setup()
  await config(dirs.dir, ["drain:", "  enabled: false"])
  let checked = false
  const report = await runDrainScan({
    directory: dirs.dir,
    stateDir: dirs.stateDir,
    log: silentLog,
    due: async () => {
      checked = true
      return { due: true }
    },
  })
  assert.deepEqual(report, { emitted: false, reason: "disabled" })
  assert.equal(checked, false)
})

test("a due-check failure is logged and never emits", async () => {
  const dirs = await setup()
  const warnings: string[] = []
  const report = await runDrainScan({
    directory: dirs.dir,
    stateDir: dirs.stateDir,
    log: { event: () => {}, warn: (message) => warnings.push(message) },
    due: async () => {
      throw new Error("boom")
    },
  })
  assert.deepEqual(report, { emitted: false, reason: "due-check-failed" })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /due check failed/)
})
