import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

// The producer uses local wall time for menus/quiet windows; pin UTC.
process.env.TZ = "UTC"

const { MISSIONS_STATE_FILE, createMissionScan, runMissionScan } = await import("./missions.ts")
const { readIntents } = await import("./intents.ts")
const {
  clearMissionProducers,
  getMissionProducer,
  registerMissionProducer,
} = await import("./registry.ts")
const { loadWorkQueueState, saveWorkQueueState, emptyScheduler, WORK_QUEUE_FILE } = await import(
  "../work-queue.ts"
)
const { tempDir } = await import("../test-utils.ts")
import type { ChronLog } from "../chron/types.ts"

const T0 = Date.parse("2026-11-01T12:00:00Z")
const HOUR = 3_600_000

const silentLog: ChronLog = { event: () => {}, warn: () => {} }

type Dirs = { dir: string; stateDir: string; logDir: string }

async function setup(
  missions: Record<string, string>,
  config: string[] = ["autonomy:", "  level: 3"],
): Promise<Dirs> {
  const dir = await tempDir("production-missions-")
  const missionsDir = join(dir, ".opencode", "missions")
  await mkdir(missionsDir, { recursive: true })
  for (const [name, body] of Object.entries(missions)) {
    await writeFile(join(missionsDir, name), body, "utf8")
  }
  await writeFile(join(dir, ".opencode", "sysop-config.yaml"), [...config, ""].join("\n"), "utf8")
  return {
    dir,
    stateDir: join(dir, ".opencode", "state"),
    logDir: join(dir, ".opencode", "logs"),
  }
}

function missionBody(
  id: string,
  over: Record<string, string | number | boolean> = {},
): string {
  const fields: Record<string, string | number | boolean> = {
    id,
    title: id,
    schedule: "every 1h",
    priority: 5,
    menus: "[day, night]",
    min_level: 1,
    candidacy: "always",
    producer: "generic",
    enabled: true,
    ...over,
  }
  return [
    "---",
    ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`),
    "---",
    `Do the ${id} thing.`,
    "",
  ].join("\n")
}

function scanAt(dirs: Dirs, nowMs: number, deps: { random?: () => number } = {}) {
  return runMissionScan({
    directory: dirs.dir,
    stateDir: dirs.stateDir,
    log: silentLog,
    now: () => nowMs,
    ...deps,
  })
}

/** First scan seeds; the second falls on the next occurrence. */
async function seedThenScan(dirs: Dirs, over: { random?: () => number } = {}) {
  await scanAt(dirs, T0 - HOUR)
  return scanAt(dirs, T0, over)
}

test("an interval mission emits one intent at its occurrence", async () => {
  const dirs = await setup({ "research.md": missionBody("research") })
  const first = await scanAt(dirs, T0 - HOUR)
  assert.deepEqual(first.emitted, [])
  const second = await scanAt(dirs, T0)
  assert.deepEqual(second.emitted, ["research"])

  const { intents } = await readIntents(dirs.stateDir)
  assert.equal(intents.length, 1)
  assert.equal(intents[0].intent.id, "mission:research")
  assert.equal(intents[0].intent.kind, "mission")
  assert.equal(intents[0].intent.priority, 5)
  assert.equal(intents[0].intent.producer, "chron:missions")

  const state = JSON.parse(
    await (await import("node:fs/promises")).readFile(
      join(dirs.stateDir, MISSIONS_STATE_FILE),
      "utf8",
    ),
  )
  assert.equal(state.missions.research.last_evaluated_ms, T0)
})

test("a failed gate consumes the occurrence exactly once", async () => {
  const dirs = await setup({ "night-only.md": missionBody("night-only", { menus: "[night]" }) })
  const first = await seedThenScan(dirs)
  assert.deepEqual(first.emitted, [])
  assert.ok(first.evaluated.includes("night-only"))

  const second = await scanAt(dirs, T0 + 1_000)
  assert.deepEqual(second.evaluated, [])
  assert.deepEqual((await readIntents(dirs.stateDir)).intents, [])
})

test("priority orders the scan and max_per_scan leaves the rest for later", async () => {
  const dirs = await setup(
    {
      "low.md": missionBody("low", { priority: 2 }),
      "high.md": missionBody("high", { priority: 7 }),
      "mid.md": missionBody("mid", { priority: 5 }),
    },
    ["autonomy:", "  level: 3", "chron:", "  mission_max_per_scan: 2"],
  )
  const report = await seedThenScan(dirs)
  assert.deepEqual(report.emitted, ["high", "mid"])
  assert.deepEqual(report.overflow, ["low"])
  const ids = (await readIntents(dirs.stateDir)).intents.map((r) => r.intent.id).sort()
  assert.deepEqual(ids, ["mission:high", "mission:mid"])

  // The overflow occurrence is not consumed; the next scan emits it.
  const next = await scanAt(dirs, T0 + 1_000)
  assert.deepEqual(next.emitted, ["low"])
})

test("an already queued mission is deduped and its occurrence consumed", async () => {
  const dirs = await setup({ "research.md": missionBody("research") })
  const queueFile = join(dirs.stateDir, WORK_QUEUE_FILE)
  await mkdir(dirs.stateDir, { recursive: true })
  await saveWorkQueueState(
    queueFile,
    [
      {
        id: "mission:research",
        kind: "mission",
        producer: "chron:missions",
        enqueued_ms: T0 - 2 * HOUR,
        requeue_count: 0,
      },
    ],
    emptyScheduler(),
  )
  const report = await seedThenScan(dirs)
  assert.deepEqual(report.emitted, [])
  assert.ok(report.evaluated.includes("research"))
  assert.deepEqual((await readIntents(dirs.stateDir)).intents, [])
})

test("brain-stale candidacy emits the staleness kind", async () => {
  const dirs = await setup({
    "staleness.md": missionBody("staleness", { candidacy: "brain-stale:720" }),
  })
  await mkdir(join(dirs.dir, "Brain"), { recursive: true })
  await writeFile(
    join(dirs.dir, "Brain", "Old.md"),
    ["---", "title: Old", "type: reference", "updated: 2020-01-01", "---", "body", ""].join("\n"),
    "utf8",
  )
  const report = await seedThenScan(dirs)
  assert.deepEqual(report.emitted, ["staleness"])
  const { intents } = await readIntents(dirs.stateDir)
  assert.equal(intents[0].intent.kind, "staleness")
})

test("enqueue: item and custom-producer missions are skipped by the generic scan", async () => {
  clearMissionProducers()
  registerMissionProducer({ id: "nightly-report", produce: () => [] })
  const dirs = await setup({
    "user-task.md": missionBody("user-task", { enqueue: "item" }),
    "custom.md": missionBody("custom", { producer: "nightly-report" }),
  })
  const report = await seedThenScan(dirs)
  assert.deepEqual(report.emitted, [])
  assert.deepEqual((await readIntents(dirs.stateDir)).intents, [])
  assert.ok(getMissionProducer("nightly-report"))
  clearMissionProducers()
})

test("an unknown producer warns once and never produces", async () => {
  const dirs = await setup({ "ghost.md": missionBody("ghost", { producer: "ghost-producer" }) })
  const warnings: string[] = []
  const scan = createMissionScan({
    directory: dirs.dir,
    stateDir: dirs.stateDir,
    log: { event: () => {}, warn: (message) => warnings.push(message) },
    now: () => T0,
  })
  await scan()
  await scan()
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /unknown producer/)
  assert.deepEqual((await readIntents(dirs.stateDir)).intents, [])
})

test("a mission without a schedule warns once and never produces", async () => {
  const dirs = await setup({ "bare.md": missionBody("bare", { schedule: "" }) })
  const warnings: string[] = []
  const scan = createMissionScan({
    directory: dirs.dir,
    stateDir: dirs.stateDir,
    log: { event: () => {}, warn: (message) => warnings.push(message) },
    now: () => T0,
  })
  await scan()
  await scan()
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /missing schedule/)
})

test("disabled missions and level 0 produce nothing", async () => {
  const dirs = await setup({ "off.md": missionBody("off", { enabled: false }) })
  const report = await seedThenScan(dirs)
  assert.deepEqual(report.emitted, [])

  const low = await setup({ "any.md": missionBody("any") }, ["autonomy:", "  level: 0"])
  const lowReport = await seedThenScan(low)
  assert.deepEqual(lowReport, { evaluated: [], emitted: [], overflow: [], skipped: [] })
})

test("the work queue is never written by the producer", async () => {
  const dirs = await setup({ "research.md": missionBody("research") })
  await seedThenScan(dirs)
  const queue = await loadWorkQueueState(join(dirs.stateDir, WORK_QUEUE_FILE))
  assert.deepEqual(queue.items, [])
})
