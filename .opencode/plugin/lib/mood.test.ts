import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_BASELINE,
  MOOD_VERSION,
  adaptBaseline,
  applyEvent,
  buildMoodLine,
  clampArousal,
  clampValence,
  createMoodFeed,
  decay,
  defaultMoodState,
  describe,
  halfLifeMs,
  readMoodState,
  writeMoodState,
} from "./mood.ts"

const T0 = "2026-10-12T00:00:00.000Z"
const t0ms = Date.parse(T0)

test("clampValence bounds to [-1,1] and NaN to 0", () => {
  assert.equal(clampValence(0.5), 0.5)
  assert.equal(clampValence(2), 1)
  assert.equal(clampValence(-3), -1)
  assert.equal(clampValence(Number.NaN), 0)
})

test("clampArousal bounds to [0,1] and NaN to 0", () => {
  assert.equal(clampArousal(0.4), 0.4)
  assert.equal(clampArousal(1.5), 1)
  assert.equal(clampArousal(-0.5), 0)
  assert.equal(clampArousal(Number.NaN), 0)
})

test("defaultMoodState is neutral with the default baseline", () => {
  const s = defaultMoodState(T0)
  assert.equal(s.valence, 0)
  assert.equal(s.arousal, 0.3)
  assert.equal(s.label, "neutral")
  assert.deepEqual(s.baseline, DEFAULT_BASELINE)
  assert.equal(s.since, T0)
  assert.equal(s.version, MOOD_VERSION)
})

test("describe maps the valence/arousal quadrants", () => {
  assert.equal(describe(0, 0.3), "neutral")
  assert.equal(describe(0.4, 0.8), "excited")
  assert.equal(describe(0.4, 0.1), "content")
  assert.equal(describe(0.4, 0.4), "pleased")
  assert.equal(describe(-0.4, 0.8), "on-edge")
  assert.equal(describe(-0.4, 0.1), "deflated")
  assert.equal(describe(-0.4, 0.4), "down")
  assert.equal(describe(0, 0.8), "restless")
  assert.equal(describe(0, 0.1), "flat")
})

test("describe adds the outer valence bands", () => {
  assert.equal(describe(0.7, 0.1), "serene")
  assert.equal(describe(0.7, 0.4), "happy")
  assert.equal(describe(0.7, 0.8), "elated")
  assert.equal(describe(-0.7, 0.1), "despondent")
  assert.equal(describe(-0.7, 0.4), "miserable")
  assert.equal(describe(-0.7, 0.8), "furious")
})

test("describe band edges resolve to the higher band", () => {
  assert.equal(describe(0.2, 0.4), "pleased")
  assert.equal(describe(0.5, 0.4), "happy")
  assert.equal(describe(-0.2, 0.4), "down")
  assert.equal(describe(-0.5, 0.4), "miserable")
})

test("applyEvent applies the deterministic delta", () => {
  const s = applyEvent(defaultMoodState(T0), "engaged", T0)
  assert.ok(s.valence > 0, "engagement raises valence")
  assert.equal(s.arousal, 0.3, "engagement leaves arousal at rest")
  assert.equal(s.since, T0)
})

test("applyEvent clamps and keeps the state within bounds", () => {
  let s = defaultMoodState(T0)
  for (let i = 0; i < 100; i++) s = applyEvent(s, "approval_granted", T0)
  assert.ok(s.valence <= 1 && s.valence >= -1)
  assert.ok(s.arousal <= 1 && s.arousal >= 0)
})

test("well_rested resets the baseline to neutral", () => {
  let s = defaultMoodState(T0)
  s = applyEvent(s, "woken", T0)
  s = applyEvent(s, "dream_anxious", T0)
  assert.notDeepEqual(s.baseline, DEFAULT_BASELINE)
  const rested = applyEvent(s, "well_rested", T0)
  assert.deepEqual(rested.baseline, DEFAULT_BASELINE)
  assert.equal(rested.valence, DEFAULT_BASELINE.valence)
  assert.equal(rested.arousal, DEFAULT_BASELINE.arousal)
})

test("fell_asleep is a no-op marker that leaves the baseline alone", () => {
  const s = defaultMoodState(T0)
  const asleep = applyEvent(s, "fell_asleep", T0)
  assert.equal(asleep.valence, s.valence)
  assert.equal(asleep.arousal, s.arousal)
  assert.deepEqual(asleep.baseline, s.baseline)
})

test("adaptBaseline nudges the resting point slowly and stays bounded", () => {
  const base = adaptBaseline({ valence: 0, arousal: 0.3 }, 1, 0)
  assert.ok(base.valence > 0 && base.valence < 0.05, "single nudge is tiny")
  // Repeated nudges should move the baseline materially but stay bounded.
  let b = { valence: 0, arousal: 0.3 }
  for (let i = 0; i < 1000; i++) b = adaptBaseline(b, 1, 1)
  assert.ok(b.valence <= 1 && b.arousal <= 1)
})

test("decay drifts toward the baseline exponentially", () => {
  // Half-life 6h: after exactly 6h the offset from baseline halves.
  const s = { ...defaultMoodState(T0), valence: 0.9, arousal: 0.9 }
  const hl = 6 * 3600 * 1000
  const d = decay(s, t0ms + hl, hl)
  assert.ok(Math.abs(d.valence - 0.45) < 1e-6, `valence ~0.45 got ${d.valence}`)
  assert.ok(Math.abs(d.arousal - (0.3 + 0.6 * 0.5)) < 1e-6, `arousal decayed toward baseline`)
})

test("decay asleep halves the arousal half-life only", () => {
  const s = { ...defaultMoodState(T0), valence: 0.9, arousal: 0.9 }
  const hl = 6 * 3600 * 1000
  const awake = decay(s, t0ms + hl, hl)
  const asleep = decay(s, t0ms + hl, hl, { asleep: true })
  assert.equal(awake.valence, asleep.valence, "valence decay unaffected by sleep")
  assert.ok(asleep.arousal < awake.arousal, "arousal decays faster while asleep")
})

test("decay never overshoots the baseline", () => {
  const s = { ...defaultMoodState(T0), valence: -0.5, arousal: 0.1 }
  const d = decay(s, t0ms + 100 * 3600 * 1000, 6 * 3600 * 1000)
  assert.ok(Math.abs(d.valence - DEFAULT_BASELINE.valence) < 1e-4)
  assert.ok(Math.abs(d.arousal - DEFAULT_BASELINE.arousal) < 1e-4)
})

test("halfLifeMs parses hours/minutes and falls back to 6h", () => {
  assert.equal(halfLifeMs("6h"), 6 * 3600 * 1000)
  assert.equal(halfLifeMs("30m"), 30 * 60 * 1000)
  assert.equal(halfLifeMs("bogus"), 6 * 3600 * 1000)
  assert.equal(halfLifeMs(""), 6 * 3600 * 1000)
})

test("buildMoodLine renders a compact [mood] directive", () => {
  const line = buildMoodLine(defaultMoodState(T0))
  assert.ok(line.startsWith("[mood] neutral"))
  assert.match(line, /valence 0\.00/)
  assert.match(line, /arousal 0\.30/)
})

test("readMoodState falls back to a default on a missing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mood-"))
  const s = await readMoodState(join(dir, "nope.json"))
  const d = defaultMoodState()
  // `since` is stamped from the clock per call — compare it for shape, not
  // equality, so a 1ms tick between the two `nowIso()` calls can't flake.
  assert.deepEqual({ ...s, since: "(clock)" }, { ...d, since: "(clock)" })
  assert.match(s.since, /^\d{4}-\d{2}-\d{2}T/)
  await rm(dir, { recursive: true, force: true })
})

test("writeMoodState/readMoodState round-trips clamped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mood-"))
  const file = join(dir, "mood.json")
  const s = { ...defaultMoodState(T0), valence: 0.7, arousal: 0.8 }
  await writeMoodState(file, s)
  const raw = JSON.parse(await readFile(file, "utf8"))
  assert.equal(raw.valence, 0.7)
  const read = await readMoodState(file)
  assert.equal(read.valence, 0.7)
  assert.equal(read.arousal, 0.8)
  assert.equal(read.label, "elated")
  await rm(dir, { recursive: true, force: true })
})

test("readMoodState clamps out-of-range persisted values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mood-"))
  const file = join(dir, "mood.json")
  await writeFile(file, JSON.stringify({ valence: 5, arousal: -2, version: 1 }), "utf8")
  const read = await readMoodState(file)
  assert.equal(read.valence, 1)
  assert.equal(read.arousal, 0)
  await rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// createMoodFeed — the shared apply entry point (card E, missions-plan §7)

test("createMoodFeed: apply decays, applies, persists and journals before/after", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moodfeed-"))
  const file = join(dir, "mood.json")
  const entries: any[] = []
  const feed = await createMoodFeed({
    file,
    halfLife: "6h",
    logger: { append: async (e) => void entries.push(e) },
  })

  await feed.apply("mission_failure")
  const onDisk = JSON.parse(await readFile(file, "utf8"))
  assert.ok(onDisk.valence < 0) // 0 → -0.08
  assert.equal(feed.get().valence, onDisk.valence)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].event, "mission_failure")
  assert.equal(entries[0].valence_before, 0)
  assert.ok(entries[0].valence_after < 0)
  assert.equal(typeof entries[0].ts, "string")
  assert.equal(typeof entries[0].label_after, "string")

  await feed.apply("engaged")
  assert.equal(entries.length, 2)
  await rm(dir, { recursive: true, force: true })
})

test("createMoodFeed: realizeDecay persists without journaling; get/view never mutate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moodfeed-"))
  const file = join(dir, "mood.json")
  const entries: any[] = []
  const feed = await createMoodFeed({
    file,
    halfLife: "6h",
    logger: { append: async (e) => void entries.push(e) },
  })

  const before = feed.get().arousal
  const view = feed.view()
  assert.equal(feed.get().arousal, before) // view is read-only
  assert.equal(entries.length, 0)

  await feed.realizeDecay()
  assert.equal(entries.length, 0) // no event, no journal line
  const onDisk = JSON.parse(await readFile(file, "utf8"))
  assert.equal(typeof onDisk.arousal, "number")
  await rm(dir, { recursive: true, force: true })
})

test("createMoodFeed: a journal failure reaches onError and never throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moodfeed-"))
  const file = join(dir, "mood.json")
  const errors: unknown[] = []
  const feed = await createMoodFeed({
    file,
    halfLife: "6h",
    logger: {
      append: async () => {
        throw new Error("journal down")
      },
    },
    onError: (err) => void errors.push(err),
  })
  await feed.apply("engaged") // resolves despite the journal throw
  assert.equal(errors.length, 1)
  assert.match(String((errors[0] as Error).message), /journal down/)
  // The state write happened before the journal — the mood still landed.
  const onDisk = JSON.parse(await readFile(file, "utf8"))
  assert.ok(onDisk.valence > 0)
  await rm(dir, { recursive: true, force: true })
})

test("createMoodFeed: concurrent applies serialize through the queue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moodfeed-"))
  const file = join(dir, "mood.json")
  const entries: any[] = []
  const feed = await createMoodFeed({
    file,
    halfLife: "6h",
    logger: { append: async (e) => void entries.push(e) },
  })
  await Promise.all([feed.apply("engaged"), feed.apply("engaged"), feed.apply("engaged")])
  assert.equal(entries.length, 3) // no lost update, no interleaving
  const onDisk = JSON.parse(await readFile(file, "utf8"))
  assert.ok(onDisk.valence > 0)
  await rm(dir, { recursive: true, force: true })
})
