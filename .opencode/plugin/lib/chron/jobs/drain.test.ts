import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  DRAIN_PRODUCER_STATE_FILE,
  decideDrainProduction,
  effectiveLastEmitted,
  normalizeIntervalMs,
  readDrainProducerState,
  runDrainScan,
  saveDrainProducerState,
  type DrainDecisionInput,
} from "./drain.ts"
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

test("normalizeIntervalMs coerces invalid input to the shipped default", () => {
  assert.equal(normalizeIntervalMs(15), 15 * 60_000)
  assert.equal(normalizeIntervalMs(1), 60_000)
  assert.equal(normalizeIntervalMs(15.9), 15 * 60_000)
  assert.equal(normalizeIntervalMs(0), 15 * 60_000)
  assert.equal(normalizeIntervalMs(-3), 15 * 60_000)
  assert.equal(normalizeIntervalMs(Number.NaN), 15 * 60_000)
  assert.equal(normalizeIntervalMs(Number.POSITIVE_INFINITY), 15 * 60_000)
})

function decisionInput(overrides: Partial<DrainDecisionInput> = {}): DrainDecisionInput {
  return {
    now_ms: 1_000_000,
    interval_ms: 60_000,
    last_emitted_ms: 0,
    enabled: true,
    queued: false,
    intent_pending: false,
    due: true,
    pending: 20,
    oldest_age_ms: 0,
    ...overrides,
  }
}

test("decideDrainProduction applies the gates in order", () => {
  assert.deepEqual(
    decideDrainProduction(decisionInput({ enabled: false })),
    { emit: false, reason: "disabled" },
  )
  assert.deepEqual(
    decideDrainProduction(decisionInput({ last_emitted_ms: 1_000_000 - 59_999 })),
    { emit: false, reason: "cooldown" },
  )
  assert.deepEqual(
    decideDrainProduction(decisionInput({ queued: true, last_emitted_ms: 0 })),
    { emit: false, reason: "queued" },
  )
  assert.deepEqual(
    decideDrainProduction(decisionInput({ intent_pending: true, last_emitted_ms: 0 })),
    { emit: false, reason: "pending-intent" },
  )
  assert.deepEqual(
    decideDrainProduction(decisionInput({ due: false, pending: null, oldest_age_ms: null })),
    { emit: false, reason: "unavailable" },
  )
  assert.deepEqual(
    decideDrainProduction(decisionInput({ due: false, pending: 0, oldest_age_ms: null })),
    { emit: false, reason: "empty" },
  )
  assert.deepEqual(
    decideDrainProduction(decisionInput({ due: false, pending: 5, oldest_age_ms: 1 })),
    { emit: false, reason: "below-trigger" },
  )
  assert.deepEqual(decideDrainProduction(decisionInput()), { emit: true, reason: "emitted" })
})

test("decideDrainProduction treats the cooldown boundary as inclusive", () => {
  assert.equal(
    decideDrainProduction(decisionInput({ last_emitted_ms: 1_000_000 - 60_000 })).emit,
    true,
  )
  assert.equal(
    decideDrainProduction(decisionInput({ last_emitted_ms: 1_000_000 - 60_001 })).emit,
    true,
  )
})

test("decideDrainProduction lets a zero last_emitted_ms emit immediately", () => {
  assert.equal(decideDrainProduction(decisionInput({ last_emitted_ms: 0 })).emit, true)
})

test("readDrainProducerState reads a valid state file", async () => {
  const dirs = await setup()
  await writeFile(
    join(dirs.stateDir, DRAIN_PRODUCER_STATE_FILE),
    JSON.stringify({ version: 1, last_emitted_ms: 1234 }),
    "utf8",
  )
  assert.deepEqual(await readDrainProducerState(dirs.stateDir), {
    version: 1,
    last_emitted_ms: 1234,
  })
})

test("readDrainProducerState treats missing, corrupt, and wrong-version files as empty", async () => {
  const dirs = await setup()
  assert.deepEqual(await readDrainProducerState(dirs.stateDir), {
    version: 1,
    last_emitted_ms: 0,
  })
  await writeFile(join(dirs.stateDir, DRAIN_PRODUCER_STATE_FILE), "{nope", "utf8")
  assert.deepEqual(await readDrainProducerState(dirs.stateDir), {
    version: 1,
    last_emitted_ms: 0,
  })
  await writeFile(
    join(dirs.stateDir, DRAIN_PRODUCER_STATE_FILE),
    JSON.stringify({ version: 2, last_emitted_ms: 1234 }),
    "utf8",
  )
  assert.deepEqual(await readDrainProducerState(dirs.stateDir), {
    version: 1,
    last_emitted_ms: 0,
  })
})

test("saveDrainProducerState creates a missing state directory", async () => {
  const dir = await tempDir("chron-drain-state-")
  const stateDir = join(dir, "nested", "state")
  assert.equal(await saveDrainProducerState(stateDir, { version: 1, last_emitted_ms: 42 }), true)
  assert.deepEqual(await readDrainProducerState(stateDir), {
    version: 1,
    last_emitted_ms: 42,
  })
})

test("saveDrainProducerState reports failure without throwing", async () => {
  const dir = await tempDir("chron-drain-state-")
  const notADir = join(dir, "state-file")
  await writeFile(notADir, "x", "utf8")
  assert.equal(await saveDrainProducerState(notADir, { version: 1, last_emitted_ms: 42 }), false)
})

test("effectiveLastEmitted clamps future and invalid timestamps to zero", () => {
  const now = 1_000_000
  assert.equal(effectiveLastEmitted(500, now, 60_000), 500)
  assert.equal(effectiveLastEmitted(0, now, 60_000), 0)
  assert.equal(effectiveLastEmitted(now + 1, now, 60_000), 0)
  assert.equal(effectiveLastEmitted(-1, now, 60_000), 0)
  assert.equal(effectiveLastEmitted(Number.NaN, now, 60_000), 0)
})
