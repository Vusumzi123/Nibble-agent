import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  applyWake,
  backoffMultiplier,
  buildSleepLine,
  buildWakeLine,
  createSleepStore,
  defaultSleepState,
  durationToMs,
  readSleepState,
  reconcileSleep,
  sleepDirective,
} from "./sleep.ts"
import { DEFAULT_SLEEP_PROMPTS } from "./sleep-prompts.ts"

const MIN = 60_000
const HOUR = 3_600_000
const T0 = Date.parse("2026-10-14T23:00:00.000Z")

test("defaultSleepState: fresh state is awake, never ticked", () => {
  const s = defaultSleepState("2026-10-14T10:00:00.000Z")
  assert.equal(s.version, 1)
  assert.equal(s.status, "awake")
  assert.equal(s.since, "2026-10-14T10:00:00.000Z")
  assert.equal(s.woken_at, null)
  assert.equal(s.window_opened_at, null)
  assert.equal(s.dreams_tonight, 0)
  assert.equal(s.last_tick, 0)
  assert.equal(s.ticks, 0)
})

test("readSleepState: missing and garbage files yield the defaults; bad fields repaired", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sleep-test-"))
  assert.equal((await readSleepState(join(dir, "nope.json"))).status, "awake")

  const file = join(dir, "sleep.json")
  const { writeFile } = await import("node:fs/promises")
  await writeFile(file, "{ not json", "utf8")
  assert.equal((await readSleepState(file)).status, "awake")

  await writeFile(
    file,
    JSON.stringify({ status: "hibernating", last_tick: "NaN", dreams_tonight: -3 }),
    "utf8",
  )
  const s = await readSleepState(file)
  assert.equal(s.status, "awake")
  assert.equal(s.last_tick, 0)
  assert.equal(s.dreams_tonight, 0)
})

test("createSleepStore: round-trips through <state>/sleep.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sleep-store-"))
  const store = createSleepStore(dir)
  const next = await store.update((s) => ({ ...s, status: "dreaming", ticks: 4 }))
  assert.equal(next.status, "dreaming")
  const fresh = createSleepStore(dir)
  assert.equal((await fresh.read()).ticks, 4)
})

// --- applyWake (sleep-hook writer class, §17.1/§17.7) -----------------------

test("applyWake: dreaming → woken stamps woken_at, emits woken", () => {
  const state = { ...defaultSleepState("2026-10-14T22:59:00.000Z"), status: "dreaming" as const }
  const t = applyWake(state, T0 + 3 * HOUR)
  assert.equal(t.changed, true)
  assert.equal(t.state.status, "woken")
  assert.equal(t.state.since, new Date(T0 + 3 * HOUR).toISOString())
  assert.equal(t.state.woken_at, new Date(T0 + 3 * HOUR).toISOString())
  assert.deepEqual(t.mood_events, ["woken"])
})

test("applyWake: woken → woken refreshes activity (since) without an event", () => {
  const state = { ...defaultSleepState(), status: "woken" as const, since: "2026-10-14T01:00:00.000Z" }
  const t = applyWake(state, T0)
  assert.equal(t.changed, true)
  assert.equal(t.state.since, new Date(T0).toISOString(), "cooldown measures from last activity")
  assert.equal(t.state.woken_at, state.woken_at)
  assert.deepEqual(t.mood_events, [])
  // Same-ms refresh → no write at all.
  const again = applyWake(t.state, T0)
  assert.equal(again.changed, false)
})

test("applyWake: a turn while awake is not a wake", () => {
  const t = applyWake(defaultSleepState(), T0)
  assert.equal(t.changed, false)
  assert.equal(t.state.status, "awake")
  assert.deepEqual(t.mood_events, [])
})

// --- reconcileSleep (heartbeat writer class, §17.1/§17.7) -------------------

test("reconcileSleep: window start flips awake → dreaming, resets counters, feeds fell_asleep", () => {
  const state = { ...defaultSleepState(), dreams_tonight: 2 }
  const t = reconcileSleep(state, { nowMs: T0, quiet: true, resumeCooldownMs: 60 * MIN })
  assert.equal(t.changed, true)
  assert.equal(t.state.status, "dreaming")
  assert.equal(t.state.window_opened_at, new Date(T0).toISOString())
  assert.equal(t.state.dreams_tonight, 0, "window start resets the nightly count")
  assert.deepEqual(t.mood_events, ["fell_asleep"])
})

test("reconcileSleep: window end from dreaming → awake + well_rested (only from dreaming)", () => {
  const dreaming = { ...defaultSleepState(), status: "dreaming" as const, window_opened_at: "2026-10-14T23:00:00.000Z" }
  const t = reconcileSleep(dreaming, { nowMs: T0, quiet: false, resumeCooldownMs: 60 * MIN })
  assert.equal(t.state.status, "awake")
  assert.equal(t.state.window_opened_at, null)
  assert.deepEqual(t.mood_events, ["well_rested"], "§17.7: well_rested only when slept through")

  const woken = { ...defaultSleepState(), status: "woken" as const, woken_at: "2026-10-15T02:00:00.000Z" }
  const t2 = reconcileSleep(woken, { nowMs: T0, quiet: false, resumeCooldownMs: 60 * MIN })
  assert.equal(t2.state.status, "awake")
  assert.deepEqual(t2.mood_events, [], "a night chatting is not a night slept")
})

test("reconcileSleep: woken → dreaming only after resume_cooldown silence", () => {
  const base = { ...defaultSleepState(), status: "woken" as const, since: new Date(T0 - 10 * MIN).toISOString() }
  const early = reconcileSleep(base, { nowMs: T0, quiet: true, resumeCooldownMs: 60 * MIN })
  assert.equal(early.changed, false, "cooldown not elapsed → stays woken")
  const late = reconcileSleep(base, { nowMs: T0 + 55 * MIN, quiet: true, resumeCooldownMs: 60 * MIN })
  assert.equal(late.changed, true)
  assert.equal(late.state.status, "dreaming")
  assert.deepEqual(late.mood_events, [])
})

test("reconcileSleep: stable states never change (no write churn)", () => {
  const dreaming = { ...defaultSleepState(), status: "dreaming" as const }
  assert.equal(reconcileSleep(dreaming, { nowMs: T0, quiet: true, resumeCooldownMs: 60 * MIN }).changed, false)
  const awake = defaultSleepState()
  assert.equal(reconcileSleep(awake, { nowMs: T0, quiet: false, resumeCooldownMs: 60 * MIN }).changed, false)
})

// --- wake line (§17.7) ------------------------------------------------------

test("buildWakeLine: carries since + mood snapshot", () => {
  const line = buildWakeLine("2026-10-14T23:01:00.000Z", "[mood] serene (valence 0.98, arousal 0.17)", "2026-10-15T03:00:00.000Z")
  assert.ok(line.startsWith("[wake]"))
  assert.ok(line.includes("dreaming since 2026-10-14T23:01:00.000Z"))
  assert.ok(line.includes("the user's message woke you"))
  assert.ok(line.includes("[mood] serene"))
  assert.ok(!line.includes("dream timer"), "the dream timer no longer exists")
})

// --- [sleepState] directive (§17.7) -----------------------------------------

test("buildSleepLine: clock wins over a stale status", () => {
  assert.ok(buildSleepLine("awake", false).startsWith("[sleepState] awake"))
  assert.ok(buildSleepLine("dreaming", false).startsWith("[sleepState] awake"))
  assert.ok(buildSleepLine("dreaming", true).startsWith("[sleepState] dreaming"))
  assert.ok(buildSleepLine("awake", true).startsWith("[sleepState] quiet window just opened"))
})

test("buildSleepLine: woken states the wake, the mood shift, and the guardrail", () => {
  const line = buildSleepLine("woken", true)
  assert.ok(line.startsWith("[sleepState] woken"))
  assert.ok(line.includes("woken from sleep"))
  assert.ok(line.includes("groggy"))
  assert.ok(line.includes("mood"))
  assert.ok(line.includes("Dreams are paused"))
  assert.ok(line.includes("correctness"))
})

test("sleepDirective: uses the supplied prompt file values", () => {
  const prompts = { ...DEFAULT_SLEEP_PROMPTS, woken: "SENTINEL-WOKEN" }
  assert.equal(sleepDirective("woken", true, prompts), "SENTINEL-WOKEN")
  assert.equal(sleepDirective("awake", false, prompts), DEFAULT_SLEEP_PROMPTS.awake)
})

// --- shared backoff ladder --------------------------------------------------

test("backoffMultiplier: steps after 2 no-ops (1,1,2,4,4)", () => {
  assert.equal(backoffMultiplier(0), 1)
  assert.equal(backoffMultiplier(1), 1)
  assert.equal(backoffMultiplier(2), 2, "acceptance: steps the cadence after 2 no-ops")
  assert.equal(backoffMultiplier(3), 4)
  assert.equal(backoffMultiplier(9), 4, "ladder capped at ×4")
})

test("durationToMs: 30m/2h parse; garbage and zero fall back", () => {
  assert.equal(durationToMs("30m", 1), 30 * MIN)
  assert.equal(durationToMs("2h", 1), 2 * HOUR)
  assert.equal(durationToMs("soon", 7), 7)
  assert.equal(durationToMs("0m", 7), 7)
  assert.equal(durationToMs("", 7), 7)
})
