import assert from "node:assert/strict"
import { test } from "node:test"

// Cron schedules use local wall time; pin a zone so the assertions are stable.
process.env.TZ = "Europe/Berlin"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createChron } from "./chron.ts"
import { readChronState } from "./store.ts"
import { tempDir, writeSection } from "../test-utils.ts"
import type { FireEvent, HandlerResult } from "./types.ts"

const HOUR = 3_600_000

async function setup() {
  const dir = await tempDir("chron-core-")
  const stateDir = join(dir, ".opencode", "state")
  const logDir = join(dir, ".opencode", "logs")
  return { dir, stateDir, logDir }
}

function makeChron(dirs: Awaited<ReturnType<typeof setup>>) {
  return createChron({
    directory: dirs.dir,
    stateDir: dirs.stateDir,
    logDir: dirs.logDir,
  })
}

test("an interval fires once per occurrence after first sight", async () => {
  const dirs = await setup()
  const chron = makeChron(dirs)
  const calls: FireEvent[] = []
  assert.deepEqual(
    chron.register({
      id: "tick",
      schedule: "every 1h",
      handler: (event) => {
        calls.push(event)
      },
    }),
    { ok: true },
  )

  const t0 = Date.parse("2026-11-01T09:00:00Z")
  assert.equal((await chron.tick({ nowMs: t0 })).status, "idle")
  assert.equal(calls.length, 0)
  await chron.tick({ nowMs: t0 + 59 * 60_000 })
  assert.equal(calls.length, 0)
  await chron.tick({ nowMs: t0 + HOUR })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].occurrence_ms, t0 + HOUR)
  assert.equal(calls[0].late, false)
  await chron.tick({ nowMs: t0 + HOUR })
  assert.equal(calls.length, 1)
  await chron.tick({ nowMs: t0 + 2 * HOUR })
  assert.equal(calls.length, 2)
})

test("a cron job coalesces missed occurrences to one late fire", async () => {
  const dirs = await setup()
  const chron = makeChron(dirs)
  const calls: FireEvent[] = []
  chron.register({ id: "daily", schedule: "0 9 * * *", handler: (event) => calls.push(event) })

  await chron.tick({ nowMs: Date.parse("2026-11-01T10:00:00+01:00") })
  await chron.tick({ nowMs: Date.parse("2026-11-03T10:00:00+01:00") })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].occurrence_ms, Date.parse("2026-11-03T09:00:00+01:00"))
  assert.equal(calls[0].late, true)
})

test("defer retries the same occurrence without advancing it", async () => {
  const dirs = await setup()
  const chron = makeChron(dirs)
  let attempts = 0
  let result: HandlerResult = { defer: true }
  chron.register({
    id: "retry",
    schedule: "every 1h",
    handler: () => {
      attempts++
      return result
    },
  })
  const t0 = Date.parse("2026-11-01T09:00:00Z")
  await chron.tick({ nowMs: t0 })
  await chron.tick({ nowMs: t0 + HOUR })
  assert.equal(attempts, 1)
  let state = await readChronState(join(dirs.stateDir, "chron.json"))
  assert.equal(state.jobs.retry.last_fired_ms, t0)
  assert.equal(state.jobs.retry.first_deferred_ms, t0 + HOUR)

  result = undefined
  await chron.tick({ nowMs: t0 + HOUR + 1_000 })
  assert.equal(attempts, 2)
  state = await readChronState(join(dirs.stateDir, "chron.json"))
  assert.equal(state.jobs.retry.last_fired_ms, t0 + HOUR)
  assert.equal(state.jobs.retry.first_deferred_ms, null)
})

test("a defer older than the ttl is dropped and the occurrence advances", async () => {
  const dirs = await setup()
  await writeSection(dirs.dir, "chron", ["defer_ttl_hours: 1"])
  const chron = makeChron(dirs)
  let attempts = 0
  chron.register({
    id: "stuck",
    schedule: "every 1h",
    handler: () => {
      attempts++
      return { defer: true }
    },
  })
  const t0 = Date.parse("2026-11-01T09:00:00Z")
  await chron.tick({ nowMs: t0 })
  await chron.tick({ nowMs: t0 + HOUR })
  assert.equal(attempts, 1)
  await chron.tick({ nowMs: t0 + 3 * HOUR })
  assert.equal(attempts, 2)
  const state = await readChronState(join(dirs.stateDir, "chron.json"))
  assert.equal(state.jobs.stuck.last_fired_ms, t0 + HOUR)
  assert.equal(state.jobs.stuck.first_deferred_ms, null)
})

test("duplicate ids keep the first registration", async () => {
  const dirs = await setup()
  const chron = makeChron(dirs)
  let first = 0
  let second = 0
  chron.register({ id: "dup", schedule: "every 1h", handler: () => void first++ })
  const again = chron.register({ id: "dup", schedule: "every 1h", handler: () => void second++ })
  assert.equal(again.ok, false)
  const t0 = Date.parse("2026-11-01T09:00:00Z")
  await chron.tick({ nowMs: t0 })
  await chron.tick({ nowMs: t0 + HOUR })
  assert.equal(first, 1)
  assert.equal(second, 0)
})

test("invalid schedules fail closed", async () => {
  const dirs = await setup()
  const chron = makeChron(dirs)
  assert.equal(
    chron.register({ id: "bad", schedule: "nonsense", handler: () => {} }).ok,
    false,
  )
})

test("manual jobs never fire on time and emit runs the handler", async () => {
  const dirs = await setup()
  const chron = makeChron(dirs)
  let runs = 0
  chron.register({ id: "push", schedule: "manual", handler: () => void runs++ })
  const t0 = Date.parse("2026-11-01T09:00:00Z")
  await chron.tick({ nowMs: t0 })
  await chron.tick({ nowMs: t0 + 10 * HOUR })
  assert.equal(runs, 0)
  await chron.emit("push")
  assert.equal(runs, 1)
})

test("one-shot fires exactly once", async () => {
  const dirs = await setup()
  const chron = makeChron(dirs)
  let runs = 0
  chron.register({
    id: "once",
    schedule: "at 2026-11-02T09:00:00Z",
    handler: () => void runs++,
  })
  await chron.tick({ nowMs: Date.parse("2026-11-02T08:00:00Z") })
  await chron.tick({ nowMs: Date.parse("2026-11-02T08:59:00Z") })
  assert.equal(runs, 0)
  await chron.tick({ nowMs: Date.parse("2026-11-02T09:00:00Z") })
  assert.equal(runs, 1)
  await chron.tick({ nowMs: Date.parse("2026-11-02T10:00:00Z") })
  assert.equal(runs, 1)
})

test("disabled config stops the tick", async () => {
  const dirs = await setup()
  await writeSection(dirs.dir, "chron", ["enabled: false"])
  const chron = makeChron(dirs)
  let runs = 0
  chron.register({ id: "job", schedule: "every 1h", handler: () => void runs++ })
  const result = await chron.tick({ nowMs: Date.parse("2026-11-01T09:00:00Z") })
  assert.equal(result.status, "disabled")
  assert.equal(runs, 0)
})

test("two instances: only the lease holder fires", async () => {
  const dirs = await setup()
  const a = makeChron(dirs)
  const b = makeChron(dirs)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let bRuns = 0
  a.register({
    id: "slow",
    schedule: "every 1h",
    handler: async () => {
      entered()
      await gate
    },
  })
  b.register({ id: "slow", schedule: "every 1h", handler: () => void bRuns++ })

  const t0 = Date.parse("2026-11-01T09:00:00Z")
  await a.tick({ nowMs: t0 })
  await b.tick({ nowMs: t0 })
  const first = a.tick({ nowMs: t0 + HOUR })
  await started
  const second = await b.tick({ nowMs: t0 + HOUR })
  assert.equal(second.status, "lock-held")
  release()
  assert.equal((await first).status, "fired")
  assert.equal(bRuns, 0)
})

test("list reports file and code jobs with state", async () => {
  const dirs = await setup()
  const scheduleDir = join(dirs.dir, ".opencode", "schedule")
  await mkdir(scheduleDir, { recursive: true })
  await writeFile(
    join(scheduleDir, "disk.md"),
    "---\nid: disk-check\nschedule: daily 09:00\n---\nCheck disk.\n",
    "utf8",
  )
  const chron = makeChron(dirs)
  chron.register({ id: "tick", schedule: "every 1h", handler: () => {} })
  const now = Date.parse("2026-11-01T10:00:00+01:00")
  await chron.tick({ nowMs: now })

  const list = await chron.list()
  assert.deepEqual(
    list.map((job) => [job.id, job.source, job.schedule]),
    [
      ["disk-check", "file", "daily 09:00"],
      ["tick", "code", "every 1h"],
    ],
  )
  assert.equal(list[0].next_due_ms, Date.parse("2026-11-02T09:00:00+01:00"))
  assert.equal(list[1].last_fired_ms, now)
  assert.equal(list[1].deferred, false)
})

test("a persisted old drain fire runs on the first one-minute clock tick", async () => {
  const dirs = await setup()
  const t0 = Date.parse("2026-11-01T09:00:00Z")
  await mkdir(dirs.stateDir, { recursive: true })
  await writeFile(
    join(dirs.stateDir, "chron.json"),
    JSON.stringify({
      version: 1,
      jobs: {
        drain: {
          last_fired_ms: t0 - 5 * 60_000,
          next_due_ms: t0 + 10 * 60_000,
          first_deferred_ms: null,
        },
      },
    }),
    "utf8",
  )
  const chron = makeChron(dirs)
  let runs = 0
  chron.register({ id: "drain", schedule: "every 1m", handler: () => void runs++ })

  const result = await chron.tick({ nowMs: t0 })
  assert.deepEqual(result.fired, ["drain"])
  assert.equal(runs, 1)
})

test("a recent drain fire waits for the one-minute boundary", async () => {
  const dirs = await setup()
  const t0 = Date.parse("2026-11-01T09:00:00Z")
  await mkdir(dirs.stateDir, { recursive: true })
  await writeFile(
    join(dirs.stateDir, "chron.json"),
    JSON.stringify({
      version: 1,
      jobs: {
        drain: {
          last_fired_ms: t0 - 10_000,
          next_due_ms: t0 + 10 * 60_000,
          first_deferred_ms: null,
        },
      },
    }),
    "utf8",
  )
  const chron = makeChron(dirs)
  let runs = 0
  chron.register({ id: "drain", schedule: "every 1m", handler: () => void runs++ })

  assert.equal((await chron.tick({ nowMs: t0 })).fired.length, 0)
  assert.equal(runs, 0)
  assert.deepEqual((await chron.tick({ nowMs: t0 + 50_000 })).fired, ["drain"])
  assert.equal(runs, 1)
})

test("a fire line records the handler outcome, duration, lag, and info", async () => {
  const dirs = await setup()
  const entries: Array<Record<string, any>> = []
  const chron = createChron({
    directory: dirs.dir,
    stateDir: dirs.stateDir,
    logDir: dirs.logDir,
    log: { event: (entry) => entries.push(entry), warn: () => {} },
  })
  chron.register({
    id: "probe",
    schedule: "every 1h",
    handler: async () => ({ info: { reason: "below-trigger", pending: 3 } }),
  })

  const t0 = Date.parse("2026-11-01T09:00:00Z")
  await chron.tick({ nowMs: t0 }) // first sight: seeds the next occurrence
  await chron.tick({ nowMs: t0 + HOUR })

  const fire = entries.find((entry) => entry.event === "fire" && entry.id === "probe")
  assert.ok(fire)
  assert.equal(fire.outcome, "fired")
  assert.deepEqual(fire.info, { reason: "below-trigger", pending: 3 })
  assert.equal(typeof fire.duration_ms, "number")
  assert.equal(fire.lag_ms, 0)
  assert.equal(typeof fire.next_due_ms, "number")
})

test("a deferred handler logs defer and keeps the same occurrence", async () => {
  const dirs = await setup()
  const entries: Array<Record<string, any>> = []
  const chron = createChron({
    directory: dirs.dir,
    stateDir: dirs.stateDir,
    logDir: dirs.logDir,
    log: { event: (entry) => entries.push(entry), warn: () => {} },
  })
  chron.register({
    id: "probe",
    schedule: "every 1h",
    handler: async () => ({ defer: true, info: { reason: "cap" } }),
  })

  const t0 = Date.parse("2026-11-01T09:00:00Z")
  await chron.tick({ nowMs: t0 })
  await chron.tick({ nowMs: t0 + HOUR })

  const fire = entries.find((entry) => entry.event === "fire" && entry.id === "probe")
  assert.ok(fire)
  assert.equal(fire.outcome, "defer")
  assert.equal(fire.deferred, true)
  assert.equal(fire.info.reason, "cap")
  assert.equal(fire.next_due_ms, t0 + HOUR)
})
