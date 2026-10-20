import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import {
  DEFAULT_HEARTBEAT_CONFIG,
  FREQUENCY_WEIGHTS,
  HEARTBEAT_FIXED_PROMPT,
  HEARTBEAT_LOCK_STALE_MS,
  HEARTBEAT_WAKE_CAP_MS,
  MOOD_BIAS_MAX,
  MOOD_BIAS_MIN,
  acquireHeartbeatLock,
  assembleMissionBrief,
  buildCandidates,
  buildDigestChoiceRequest,
  candidacyPasses,
  candidateWarrant,
  computeDigest,
  computeWakeDelayMs,
  digestHash,
  digestStateSummary,
  digestVerdictFromResult,
  digestVerdictFromValue,
  effectiveFrequencyMs,
  frequencyToMs,
  isAllQuiet,
  isHeartbeatLockStale,
  HEARTBEAT_CURRENT_FILE,
  idleHeartbeatCurrent,
  isQuietNow,
  missionContextHeader,
  moodDispatchBias,
  parseHeartbeatConfig,
  parseWindow,
  readHeartbeatConfig,
  readHeartbeatCurrent,
  releaseHeartbeatLock,
  soleDeterministicVerdict,
  staleCodeFiles,
  writeHeartbeatCurrent,
  type CandidacyContext,
  type DigestCandidate,
  type HeartbeatDigest,
  type HeartbeatSignals,
} from "./heartbeat.ts"
import type { DecisionResult } from "./decisions.ts"
import { applyEvent, defaultMoodState, type MoodState } from "./mood.ts"
import { parseMissionFile, type Mission } from "./missions.ts"

// ---------------------------------------------------------------------------
// Quiet-window predicate

test("missionContextHeader states a soft token budget only when numeric", () => {
  const ctx = {
    tick: 1,
    nowMs: Date.now(),
    level: 3,
    quiet: false,
    signals: {
      backlog_pending: 0,
      unconsumed_turns: 0,
      audit_failures: 0,
      staleness: {},
      quiet: false,
    },
    digestHash: "abc",
  }
  const text = missionContextHeader(ctx, { tokenBudget: 32000 })
  assert.ok(text.includes("~32000 tokens"))
  assert.ok(text.includes("soft"))
  assert.ok(text.includes("Never skip the result contract"))
  assert.ok(!missionContextHeader(ctx, { tokenBudget: "unlimited" }).includes("Token budget:"))
  assert.ok(!missionContextHeader(ctx, {}).includes("Token budget:"))
  const dream = missionContextHeader(ctx, { tokenBudget: 8000, resultContract: false })
  assert.ok(dream.includes("~8000 tokens"))
  assert.ok(!dream.includes("result contract"), "tool-free missions get no result-contract clause")
})

test("parseWindow parses HH:MM-HH:MM into minutes-of-day", () => {
  assert.deepEqual(parseWindow("23:00-08:00"), { startMin: 23 * 60, endMin: 8 * 60 })
  assert.deepEqual(parseWindow("07:30-09:05"), { startMin: 450, endMin: 545 })
})

test("parseWindow rejects malformed windows", () => {
  for (const bad of ["", "bogus", "25:00-09:00", "23:00", "23:00-08:60", "23-08"]) {
    assert.equal(parseWindow(bad), null, bad)
  }
})

function at(h: number, m: number): Date {
  const d = new Date(2026, 9, 13, h, m, 0, 0)
  return d
}

test("isQuietNow handles a same-day window", () => {
  // 07:00-09:00
  assert.equal(isQuietNow("07:00-09:00", at(7, 0)), true)
  assert.equal(isQuietNow("07:00-09:00", at(8, 59)), true)
  assert.equal(isQuietNow("07:00-09:00", at(9, 0)), false, "end is exclusive")
  assert.equal(isQuietNow("07:00-09:00", at(6, 59)), false)
  assert.equal(isQuietNow("07:00-09:00", at(12, 0)), false)
})

test("isQuietNow handles a midnight-wrap window", () => {
  // 23:00-08:00
  assert.equal(isQuietNow("23:00-08:00", at(23, 0)), true)
  assert.equal(isQuietNow("23:00-08:00", at(0, 0)), true)
  assert.equal(isQuietNow("23:00-08:00", at(7, 59)), true)
  assert.equal(isQuietNow("23:00-08:00", at(8, 0)), false, "end is exclusive")
  assert.equal(isQuietNow("23:00-08:00", at(12, 0)), false)
  assert.equal(isQuietNow("23:00-08:00", at(22, 59)), false)
})

test("isQuietNow never quiet on a malformed or zero-length window", () => {
  assert.equal(isQuietNow("bogus", at(0, 0)), false)
  assert.equal(isQuietNow("08:00-08:00", at(8, 0)), false)
})

// ---------------------------------------------------------------------------
// All-quiet detection

function signals(over: Partial<HeartbeatSignals> = {}): HeartbeatSignals {
  return {
    backlog_pending: 0,
    unconsumed_turns: 0,
    audit_failures: 0,
    staleness: {},
    quiet: false,
    ...over,
  }
}

test("isAllQuiet: empty signal set is quiet", () => {
  assert.equal(isAllQuiet(signals()), true)
})

test("isAllQuiet: any non-zero signal breaks quiet", () => {
  assert.equal(isAllQuiet(signals({ backlog_pending: 1 })), false)
  assert.equal(isAllQuiet(signals({ unconsumed_turns: 3 })), false)
  assert.equal(isAllQuiet(signals({ audit_failures: 1 })), false)
})

test("isAllQuiet: staleness under the threshold stays quiet; over it does not", () => {
  assert.equal(isAllQuiet(signals({ staleness: { "Agent.md": 10 } })), true)
  assert.equal(isAllQuiet(signals({ staleness: { "Agent.md": 72 } })), false)
  assert.equal(isAllQuiet(signals({ staleness: { "Agent.md": 10, "SETUP.md": 100 } })), false)
})

test("isAllQuiet: the quiet window alone is not a work signal", () => {
  assert.equal(isAllQuiet(signals({ quiet: true })), true)
})

// ---------------------------------------------------------------------------
// digest_hash stability

test("digestHash is stable for an identical signal set", () => {
  const a = signals({ backlog_pending: 2, unconsumed_turns: 5, quiet: true })
  const b = signals({ backlog_pending: 2, unconsumed_turns: 5, quiet: true })
  assert.equal(digestHash(a), digestHash(b))
})

test("digestHash changes when any signal changes", () => {
  const base = digestHash(signals({ backlog_pending: 1 }))
  assert.notEqual(base, digestHash(signals({ backlog_pending: 2 })))
  assert.notEqual(base, digestHash(signals({ backlog_pending: 1, unconsumed_turns: 1 })))
  assert.notEqual(base, digestHash(signals({ backlog_pending: 1, audit_failures: 1 })))
  assert.notEqual(base, digestHash(signals({ backlog_pending: 1, quiet: true })))
  assert.notEqual(base, digestHash(signals({ backlog_pending: 1, staleness: { "Agent.md": 80 } })))
})

test("digestHash buckets staleness to whole hours (stable within an hour)", () => {
  const a = digestHash(signals({ staleness: { "Agent.md": 10.2 } }))
  const b = digestHash(signals({ staleness: { "Agent.md": 10.8 } }))
  const c = digestHash(signals({ staleness: { "Agent.md": 11.0 } }))
  assert.equal(a, b, "same hour bucket -> same hash")
  assert.notEqual(a, c, "different hour bucket -> different hash")
})

test("digestHash ignores staleness key order", () => {
  const a = digestHash(signals({ staleness: { "Agent.md": 10, "User.md": 20 } }))
  const b = digestHash(signals({ staleness: { "User.md": 20, "Agent.md": 10 } }))
  assert.equal(a, b)
})

// ---------------------------------------------------------------------------
// Mood dispatch bias math

function mood(over: Partial<MoodState> = {}): MoodState {
  return { ...defaultMoodState("2026-10-13T00:00:00.000Z"), ...over }
}

test("moodDispatchBias: kill switch pins the term at 1.0 regardless of mood", () => {
  const sour = applyEvent(applyEvent(mood(), "conversation_closed_unanswered"), "mission_failure")
  assert.equal(moodDispatchBias(sour, false), 1)
  assert.equal(moodDispatchBias(mood({ valence: 1, arousal: 1 }), false), 1)
})

test("moodDispatchBias: rest state is 1.0", () => {
  assert.equal(moodDispatchBias(mood(), true), 1)
})

test("moodDispatchBias: positive valence raises the term, negative lowers it", () => {
  const glad = moodDispatchBias(mood({ valence: 0.8, arousal: 0.3 }), true)
  const sad = moodDispatchBias(mood({ valence: -0.8, arousal: 0.3 }), true)
  assert.ok(glad > 1, `glad=${glad}`)
  assert.ok(sad < 1, `sad=${sad}`)
})

test("moodDispatchBias: bounded to [MOOD_BIAS_MIN, MOOD_BIAS_MAX]", () => {
  const maxed = moodDispatchBias(mood({ valence: 1, arousal: 1 }), true)
  const minned = moodDispatchBias(mood({ valence: -1, arousal: 0 }), true)
  assert.ok(maxed > 1 && maxed <= MOOD_BIAS_MAX, `maxed=${maxed}`)
  assert.ok(minned < 1 && minned >= MOOD_BIAS_MIN, `minned=${minned}`)
  // The clamp bites on out-of-range input (defence in depth; clampState
  // normally keeps mood inside [-1,1]/[0,1]).
  assert.equal(moodDispatchBias(mood({ valence: 10, arousal: 10 }), true), MOOD_BIAS_MAX)
  assert.equal(moodDispatchBias(mood({ valence: -10, arousal: -1 }), true), MOOD_BIAS_MIN)
})

// ---------------------------------------------------------------------------
// Candidacy predicates (D-M8)

function mission(over: Partial<Mission> = {}): Mission {
  const { mission: base } = parseMissionFile(
    "---\nid: x\ntitle: X\nfrequency: mid\nmenus: [day]\nmin_level: 2\ncandidacy: digest\n---\nBody.\n",
    "x",
  )
  return { ...base, ...over }
}

const CAND: CandidacyContext = { backlogPending: 0, nowMs: 1_000_000 }

test("candidacy: digest and always always pass", () => {
  assert.equal(candidacyPasses(mission({ candidacy: "digest" }), CAND), true)
  assert.equal(candidacyPasses(mission({ candidacy: "always" }), CAND), true)
})

test("candidacy: backlog-pending passes only with pending work", () => {
  const m = mission({ candidacy: "backlog-pending" })
  assert.equal(candidacyPasses(m, CAND), false)
  assert.equal(candidacyPasses(m, { ...CAND, backlogPending: 1 }), true)
})

test("candidacy: min-gap passes when never ran or gap elapsed; holds otherwise", () => {
  const m = mission({ candidacy: "min-gap:last_refresh" })
  assert.equal(candidacyPasses(m, CAND), true, "never ran -> eligible")
  assert.equal(
    candidacyPasses(m, { ...CAND, gaps: { last_refresh: 900_000 }, minGapMs: { last_refresh: 60_000 } }),
    true,
    "gap elapsed -> eligible",
  )
  assert.equal(
    candidacyPasses(m, { ...CAND, gaps: { last_refresh: 999_000 }, minGapMs: { last_refresh: 60_000 } }),
    false,
    "gap active -> held",
  )
})

test("candidacy: roll passes iff the draw is under the chance", () => {
  const m = mission({ candidacy: "roll:0.5" })
  assert.equal(candidacyPasses(m, { ...CAND, random: () => 0.49 }), true)
  assert.equal(candidacyPasses(m, { ...CAND, random: () => 0.5 }), false)
  assert.equal(candidacyPasses(m, { ...CAND, random: () => 0.99 }), false)
})

test("candidacy: turns-pending passes only with unconsumed turns (§17.3 drain gate)", () => {
  const m = mission({ candidacy: "turns-pending" })
  assert.equal(candidacyPasses(m, CAND), false, "absent count = no turns")
  assert.equal(candidacyPasses(m, { ...CAND, unconsumedTurns: 0 }), false)
  assert.equal(candidacyPasses(m, { ...CAND, unconsumedTurns: 3 }), true)
})

test("candidacy: brain-stale gates on the oldest reference note age", () => {
  const note = (ageHours: number) => ({ path: "AI/Old.md", title: "Old", updated: "2026-08-01", ageHours })
  const m = mission({ candidacy: "brain-stale:720" })
  assert.equal(candidacyPasses(m, CAND), false, "absent signal fails closed")
  assert.equal(candidacyPasses(m, { ...CAND, brainOldest: note(719) }), false)
  assert.equal(candidacyPasses(m, { ...CAND, brainOldest: note(720) }), true)
  assert.equal(
    candidacyPasses(mission({ candidacy: "brain-stale" }), { ...CAND, brainOldest: note(720) }),
    true,
    "bare brain-stale defaults to 30 days",
  )
})

test("candidacy: dream-gate needs dreaming status, cap headroom and a passed roll (§17.3)", () => {
  const m = mission({ candidacy: "dream-gate" })
  const dreaming = { status: "dreaming" as const, chance: 0.5, dreamsTonight: 0, nightlyCap: 3 }
  // No sleep context at all → fail closed (the day digest never offers dream).
  assert.equal(candidacyPasses(m, CAND), false)
  // Status gate: only while dreaming — a heartbeat tick with status woken or
  // awake can never dispatch a dream (§17.7 wake semantics).
  assert.equal(candidacyPasses(m, { ...CAND, sleep: { ...dreaming, status: "woken" } }), false)
  assert.equal(candidacyPasses(m, { ...CAND, sleep: { ...dreaming, status: "awake" } }), false)
  // Nightly cap blocks BEFORE the roll is drawn (no randomness consumed).
  assert.equal(
    candidacyPasses(m, { ...CAND, sleep: { ...dreaming, dreamsTonight: 3 }, random: () => 0 }),
    false,
  )
  // Roll at chance 0.5.
  assert.equal(candidacyPasses(m, { ...CAND, sleep: dreaming, random: () => 0.49 }), true)
  assert.equal(candidacyPasses(m, { ...CAND, sleep: dreaming, random: () => 0.5 }), false)
})

test("candidacy: dream-gate journals the roll outcome through onDreamGate (§17.3)", () => {
  const m = mission({ candidacy: "dream-gate" })
  const events: Array<{ id: string; chance: number; passed: boolean; reason: string }> = []
  const sleep = { status: "dreaming" as const, chance: 0.5, dreamsTonight: 0, nightlyCap: 3 }
  assert.equal(candidacyPasses(m, { ...CAND, sleep, random: () => 0.9, onDreamGate: (e) => events.push(e) }), false)
  assert.equal(events.length, 1)
  assert.deepEqual(events[0], { id: m.id, chance: 0.5, passed: false, reason: "roll" })
  candidacyPasses(m, { ...CAND, sleep: { ...sleep, status: "woken" }, onDreamGate: (e) => events.push(e) })
  assert.equal(events[1].reason, "status")
})

// Card 7a (§17.10): the idea pair's candidacy + the sole-candidate shortcut.

test("candidacy: idea-roll passes only with day budget; absent context fails closed", () => {
  const m = mission({ candidacy: "idea-roll" })
  assert.equal(candidacyPasses(m, CAND), false, "no ideaDay (pipeline off) -> fail closed")
  assert.equal(candidacyPasses(m, { ...CAND, ideaDay: { target: 0, generated: 0 } }), false, "zero-draw day")
  assert.equal(candidacyPasses(m, { ...CAND, ideaDay: { target: 1, generated: 0 } }), true)
  assert.equal(candidacyPasses(m, { ...CAND, ideaDay: { target: 1, generated: 1 } }), false, "budget spent")
  assert.equal(candidacyPasses(m, { ...CAND, ideaDay: { target: 2, generated: 1 } }), true, "second slot left")
  assert.equal(candidacyPasses(m, { ...CAND, ideaDay: { target: 2, generated: 2 } }), false)
})

test("soleDeterministicVerdict: one min-gap candidate dispatches without a JEV call (§17.10)", () => {
  const cand = (id: string, candidacy: DigestCandidate["candidacy"]): DigestCandidate => ({
    id,
    title: id,
    frequency: "low",
    min_level: 1,
    menus: ["day"],
    candidacy,
    frequency_weight: 1,
    mood_bias: 1,
    weight: 1,
  })
  assert.deepEqual(
    soleDeterministicVerdict([cand("express", "min-gap:express")]),
    { kind: "mission", id: "express" },
    "sole deterministic candidate -> auto-dispatch",
  )
  assert.equal(soleDeterministicVerdict([]), null, "no candidates")
  assert.equal(
    soleDeterministicVerdict([cand("express", "min-gap:express"), cand("drain", "turns-pending")]),
    null,
    "two candidates -> the JEV digest decides",
  )
  assert.equal(
    soleDeterministicVerdict([cand("drain", "turns-pending")]),
    null,
    "sole signal-gated candidate still goes through JEV",
  )
  assert.equal(
    soleDeterministicVerdict([cand("idea-generate", "idea-roll")]),
    null,
    "the stochastic idea-roll is not a time gate",
  )
})

// ---------------------------------------------------------------------------
// Candidate-list filter matrix

function candidatesFor(missions: Mission[], over: Partial<Parameters<typeof buildCandidates>[1]> = {}) {
  return buildCandidates(missions, {
    level: 2,
    quiet: false,
    mood: mood(),
    dispatchInfluence: false,
    candidacy: CAND,
    ...over,
  })
}

test("buildCandidates: enabled ∧ menus ∧ min_level ∧ candidacy filter matrix", () => {
  const missions: Mission[] = [
    mission({ id: "pass", candidacy: "digest" }),
    mission({ id: "disabled", enabled: false }),
    mission({ id: "night-only", menus: ["night"] }),
    mission({ id: "too-high", min_level: 3 }),
    mission({ id: "no-pending", candidacy: "backlog-pending" }),
  ]
  const ids = candidatesFor(missions).map((c) => c.id)
  assert.deepEqual(ids, ["pass"])
})

test("buildCandidates: quiet window flips the menu filter to night", () => {
  const missions: Mission[] = [
    mission({ id: "day", menus: ["day"] }),
    mission({ id: "night", menus: ["night"] }),
    mission({ id: "both", menus: ["day", "night"] }),
  ]
  assert.deepEqual(candidatesFor(missions).map((c) => c.id), ["day", "both"])
  assert.deepEqual(candidatesFor(missions, { quiet: true }).map((c) => c.id), ["night", "both"])
})

test("buildCandidates: backlog-pending candidacy sees the pending count", () => {
  const missions = [mission({ id: "bp", candidacy: "backlog-pending" })]
  assert.deepEqual(candidatesFor(missions).map((c) => c.id), [])
  assert.deepEqual(candidatesFor(missions, { candidacy: { ...CAND, backlogPending: 2 } }).map((c) => c.id), ["bp"])
})

test("buildCandidates: weight = frequency_weight × mood_bias; kill switch zeroes the mood term", () => {
  const missions = [
    mission({ id: "h", frequency: "high" }),
    mission({ id: "m", frequency: "mid" }),
    mission({ id: "l", frequency: "low" }),
  ]
  const off = candidatesFor(missions, { dispatchInfluence: false })
  assert.deepEqual(off.map((c) => c.weight), [FREQUENCY_WEIGHTS.high, FREQUENCY_WEIGHTS.mid, FREQUENCY_WEIGHTS.low])
  assert.ok(off.every((c) => c.mood_bias === 1))

  const glad = mood({ valence: 0.8, arousal: 0.3 })
  const on = candidatesFor(missions, { dispatchInfluence: true, mood: glad })
  const bias = moodDispatchBias(glad, true)
  assert.ok(bias > 1)
  for (const c of on) {
    assert.equal(c.mood_bias, bias)
    assert.equal(c.weight, c.frequency_weight * bias)
  }
})

test("buildCandidates: min_level compares against the live level", () => {
  const missions = [mission({ id: "m3", min_level: 3 })]
  assert.deepEqual(candidatesFor(missions, { level: 2 }).map((c) => c.id), [])
  assert.deepEqual(candidatesFor(missions, { level: 3 }).map((c) => c.id), ["m3"])
})

// ---------------------------------------------------------------------------
// computeDigest — integration over a temp project (still zero LLM)

async function tmpProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "heartbeat-"))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    await mkdir(join(full, ".."), { recursive: true })
    await writeFile(full, content, "utf8")
  }
  return dir
}

/** Seed a fixture opencode DB with one top-level session and N text turns. */
function seedTurnsDb(dir: string, times: number[]): string {
  const file = join(dir, ".opencode/state/opencode.db")
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, time_updated INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '');
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX message_session_time_created_id_idx ON message(session_id, time_created, id);
  `)
  db.prepare("INSERT INTO session (id, parent_id, directory, time_updated) VALUES (?, ?, ?, ?)").run(
    "s1",
    null,
    dir,
    Math.max(...times, 1),
  )
  times.forEach((time, i) => {
    db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
      `m${i}`,
      "s1",
      time,
      JSON.stringify({ role: "user" }),
    )
    db.prepare("INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)").run(
      `m${i}-p`,
      `m${i}`,
      JSON.stringify({ type: "text", text: `turn ${i}` }),
    )
  })
  db.close()
  return file
}

function missingDb(dir: string): string {
  return join(dir, "missing-opencode.db")
}

test("computeDigest: no config, no state -> silent signals, all-quiet, shipped set filtered", async () => {
  const dir = await tmpProject({})
  const digest = await computeDigest(dir, { now: at(12, 0), dbFile: missingDb(dir) })
  assert.equal(digest.signals.backlog_pending, 0)
  assert.equal(digest.signals.unconsumed_turns, 0)
  assert.equal(digest.signals.audit_failures, 0)
  assert.equal(digest.signals.quiet, false)
  assert.equal(digest.all_quiet, true)
  assert.deepEqual(digest.candidates, [], "no missions dir -> no candidates")
  assert.equal(digest.digest_hash.length, 16)
  assert.equal(digest.bias.dispatch_influence, true, "default dial")
})

test("computeDigest: brain-stale candidacy follows the oldest reference note", async () => {
  const mission = [
    "---",
    "id: staleness",
    "title: Refresh stale notes",
    "menus: [day]",
    "min_level: 2",
    "candidacy: brain-stale:720",
    "enabled: true",
    "---",
    "Body.",
    "",
  ].join("\n")
  const ref = (title: string, updated: string): string =>
    `---\ntitle: ${title}\ntype: reference\nupdated: ${updated}\n---\n\nBody.\n`
  const dir = await tmpProject({
    ".opencode/sysop-config.yaml": 'autonomy:\n  level: 2\n  quiet:\n    window: "23:00-08:00"\n',
    ".opencode/missions/staleness.md": mission,
    "Brain/AI/Old.md": ref("Old", "2026-08-01"),
    "Brain/AI/Recent.md": ref("Recent", "2026-10-01"),
    "Brain/AI/Log.md": "---\ntitle: Log\ntype: log\nupdated: 2020-01-01\n---\n\nBody.\n",
  })

  const stale = await computeDigest(dir, { now: at(12, 0), dbFile: missingDb(dir) })
  assert.equal(stale.signals.brain_oldest?.path, "AI/Old.md")
  assert.equal(stale.all_quiet, false, "an old reference note is work")
  assert.deepEqual(stale.candidates.map((c) => c.id), ["staleness"])

  await rm(join(dir, "Brain/AI/Old.md"))
  const fresh = await computeDigest(dir, { now: at(12, 0), dbFile: missingDb(dir) })
  assert.equal(fresh.signals.brain_oldest?.path, "AI/Recent.md")
  assert.deepEqual(fresh.candidates, [], "newest reference note is under 30 days")
})

test("computeDigest: the last staleness run keeps staleness out of the next menu", async () => {
  const mission = (id: string, title: string): string =>
    ["---", `id: ${id}`, `title: ${title}`, "menus: [day]", "min_level: 2", "candidacy: digest", "enabled: true", "---", "Body.", ""].join("\n")
  const ref = `---\ntitle: Old\ntype: reference\nupdated: 2026-08-01\n---\n\nBody.\n`
  const dir = await tmpProject({
    ".opencode/sysop-config.yaml": 'autonomy:\n  level: 2\n  quiet:\n    window: "23:00-08:00"\n',
    ".opencode/missions/staleness.md": mission("staleness", "Stale"),
    ".opencode/missions/research.md": mission("research", "Research"),
    ".opencode/state/heartbeat.json": JSON.stringify({ last_mission: "staleness" }),
    "Brain/AI/Old.md": ref,
  })

  const digest = await computeDigest(dir, { now: at(12, 0), dbFile: missingDb(dir) })
  assert.deepEqual(digest.candidates.map((c) => c.id), ["research"])

  await writeFile(join(dir, ".opencode/state/heartbeat.json"), JSON.stringify({ last_mission: "research" }))
  const next = await computeDigest(dir, { now: at(12, 0), dbFile: missingDb(dir) })
  assert.ok(next.candidates.some((c) => c.id === "staleness"), "a different last mission frees staleness again")
})

test("computeDigest: reads backlog, memory, audit, quiet window and missions end to end", async () => {
  const dir = await tmpProject({
    ".opencode/sysop-config.yaml": [
      "autonomy:",
      "  level: 2",
      "  quiet:",
      '    window: "23:00-08:00"',
      "mood:",
      "  dispatch_influence: false",
      "drain:",
      "  initial_lookback_hours: 0",
      "",
    ].join("\n"),
    ".opencode/state/backlog.ndjson":
      JSON.stringify({
        id: "bl-1",
        created: "2026-10-13T00:00:00.000Z",
        updated: "2026-10-13T00:00:00.000Z",
        source: "conversation",
        kind: "task",
        payload: { title: "t", detail: "", commands: [], files: [] },
        level_required: 2,
        priority: 0,
        status: "pending",
        channel_notified: null,
        awaiting_reply: false,
        jev_decision: null,
        result: null,
        view_ref: null,
        links: [],
      }) + "\n",
    ".opencode/logs/audit.log":
      JSON.stringify({ ts: "2026-10-13T00:00:00.000Z", agent: "kael", cmd: "false", exit: 1, root: false, sandbox: "opencode", dry: false }) +
      "\n" +
      JSON.stringify({ ts: "2026-10-13T00:00:00.000Z", agent: "kael", cmd: "true", exit: 0, root: false, sandbox: "opencode", dry: false }) +
      "\n",
    ".opencode/missions/drain.md": [
      "---",
      "id: drain",
      "title: Drain",
      "frequency: high",
      "menus: [day, night]",
      "min_level: 2",
      "candidacy: digest",
      "enabled: true",
      "---",
      "Body.",
      "",
    ].join("\n"),
    ".opencode/missions/research.md": [
      "---",
      "id: research",
      "title: Research",
      "frequency: mid",
      "menus: [day]",
      "min_level: 2",
      "candidacy: digest",
      "enabled: true",
      "---",
      "Body.",
      "",
    ].join("\n"),
    ".opencode/missions/notify.md": [
      "---",
      "id: notify",
      "title: Notify",
      "frequency: high",
      "menus: [day]",
      "min_level: 1",
      "candidacy: digest",
      "enabled: false",
      "---",
      "Body.",
      "",
    ].join("\n"),
  })

  const dbFile = seedTurnsDb(dir, [Date.parse("2026-10-13T00:00:00.000Z")])

  const day = await computeDigest(dir, { now: at(12, 0), dbFile })
  assert.equal(day.level, 2)
  assert.equal(day.signals.backlog_pending, 1)
  assert.equal(day.signals.unconsumed_turns, 1)
  assert.equal(day.signals.audit_failures, 1)
  assert.equal(day.signals.quiet, false)
  assert.equal(day.all_quiet, false)
  assert.deepEqual(day.candidates.map((c) => c.id), ["drain", "research"], "notify is disabled")
  assert.equal(day.bias.dispatch_influence, false)
  assert.equal(day.bias.mood, 1, "kill switch pins the mood term")

  const night = await computeDigest(dir, { now: at(1, 0), dbFile })
  assert.equal(night.signals.quiet, true)
  assert.deepEqual(night.candidates.map((c) => c.id), ["drain"], "day-only missions vanish after dark")
  assert.notEqual(night.digest_hash, day.digest_hash, "quiet flips the hash")
})

test("computeDigest: a pending entry above the level does not count", async () => {
  const dir = await tmpProject({
    ".opencode/sysop-config.yaml": "autonomy:\n  level: 1\n",
    ".opencode/state/backlog.ndjson":
      JSON.stringify({
        id: "bl-3",
        created: "2026-10-13T00:00:00.000Z",
        updated: "2026-10-13T00:00:00.000Z",
        source: "conversation",
        kind: "task",
        payload: { title: "t", detail: "", commands: [], files: [] },
        level_required: 3,
        priority: 0,
        status: "pending",
        channel_notified: null,
        awaiting_reply: false,
        jev_decision: null,
        result: null,
        view_ref: null,
        links: [],
      }) + "\n",
  })
  const digest = await computeDigest(dir, { now: at(12, 0), dbFile: missingDb(dir) })
  assert.equal(digest.signals.backlog_pending, 0, "L3 entry invisible at L1")
  assert.equal(digest.all_quiet, true)
})

test("computeDigest: idea opts feed idea-roll and min-gap:express candidacy (card 7a)", async () => {
  const dir = await tmpProject({
    ".opencode/missions/idea-generate.md": [
      "---",
      "id: idea-generate",
      "title: Idea",
      "frequency: low",
      "menus: [day]",
      "min_level: 1",
      "candidacy: idea-roll",
      "enabled: true",
      "---",
      "Body.",
      "",
    ].join("\n"),
    ".opencode/missions/express.md": [
      "---",
      "id: express",
      "title: Express",
      "frequency: low",
      "menus: [day]",
      "min_level: 1",
      "candidacy: min-gap:express",
      "enabled: true",
      "---",
      "Body.",
      "",
    ].join("\n"),
  })
  const base = { now: at(12, 0), dbFile: missingDb(dir) }
  // idea pipeline off (no ideaDay) -> idea-roll fails closed, express free.
  const off = await computeDigest(dir, base)
  assert.deepEqual(off.candidates.map((c) => c.id), ["express"])
  // Day budget open (no gap recorded yet) -> both offered.
  const on = await computeDigest(dir, {
    ...base,
    ideaDay: { target: 1, generated: 0 },
    minGapMs: { express: 3_600_000 },
  })
  assert.deepEqual(on.candidates.map((c) => c.id).sort(), ["express", "idea-generate"])
  const spent = await computeDigest(dir, { ...base, ideaDay: { target: 1, generated: 1 } })
  assert.deepEqual(spent.candidates.map((c) => c.id), ["express"], "budget spent -> idea-roll gated out")
  const gapFresh = await computeDigest(dir, {
    ...base,
    ideaDay: { target: 1, generated: 0 },
    gaps: { express: Date.now() },
    minGapMs: { express: 86_400_000 },
  })
  assert.deepEqual(gapFresh.candidates.map((c) => c.id), ["idea-generate"], "gap active -> express held")
})

// ---------------------------------------------------------------------------
// JEV digest decision (card C) — typed verdict, request shape, brief assembly

function digestFixture(over: Partial<HeartbeatDigest> = {}): HeartbeatDigest {
  return {
    ts: "2026-10-13T12:00:00.000Z",
    level: 2,
    quiet: false,
    all_quiet: false,
    signals: signals({ backlog_pending: 1 }),
    candidates: candidatesFor([
      mission({ id: "drain", title: "Drain", frequency: "high" }),
      mission({ id: "research", title: "Research", frequency: "mid" }),
    ]),
    bias: { mood: 1, dispatch_influence: false },
    digest_hash: "abc123def4567890",
    ...over,
  }
}

function jevResult(over: Partial<DecisionResult> = {}): DecisionResult {
  return {
    kind: "choice",
    value: "no_reply",
    confidence: 0.9,
    probabilities: {},
    abstained: false,
    provider: "openjev",
    backend: "llamacpp",
    latencyMs: 10,
    ...over,
  }
}

test("digestVerdictFromValue: no_reply and mission:<id> parse to the typed verdict", () => {
  assert.deepEqual(digestVerdictFromValue("no_reply", ["drain"]), { kind: "no_reply" })
  assert.deepEqual(digestVerdictFromValue(" mission:drain ", ["drain", "research"]), { kind: "mission", id: "drain" })
  assert.deepEqual(digestVerdictFromValue("MISSION:RESEARCH", ["drain", "research"]), { kind: "mission", id: "research" })
})

test("digestVerdictFromValue: unknown ids and malformed values fail closed to no_reply", () => {
  const ids = ["drain"]
  assert.deepEqual(digestVerdictFromValue("mission:not-a-candidate", ids), { kind: "no_reply" })
  assert.deepEqual(digestVerdictFromValue("mission:", ids), { kind: "no_reply" })
  assert.deepEqual(digestVerdictFromValue("drain", ids), { kind: "no_reply" }, "bare id is not a verdict")
  assert.deepEqual(digestVerdictFromValue("", ids), { kind: "no_reply" })
  assert.deepEqual(digestVerdictFromValue(null, ids), { kind: "no_reply" })
  assert.deepEqual(digestVerdictFromValue(42, ids), { kind: "no_reply" })
  assert.deepEqual(digestVerdictFromValue(undefined, []), { kind: "no_reply" }, "no candidates -> no mission")
})

test("digestVerdictFromResult: error, abstain, and null results mean no_reply", () => {
  const ids = ["drain"]
  assert.deepEqual(digestVerdictFromResult(null, ids), { kind: "no_reply" })
  assert.deepEqual(digestVerdictFromResult(jevResult({ error: "bridge exploded" }), ids), { kind: "no_reply" })
  assert.deepEqual(digestVerdictFromResult(jevResult({ abstained: true, value: null }), ids), { kind: "no_reply" })
  assert.deepEqual(digestVerdictFromResult(jevResult({ value: "mission:drain" }), ids), { kind: "mission", id: "drain" })
  assert.deepEqual(digestVerdictFromResult(jevResult({ value: "no_reply" }), ids), { kind: "no_reply" })
})

test("buildDigestChoiceRequest: choice over no_reply + mission:<id>, capped state, criteria passthrough", () => {
  const digest = digestFixture()
  const req = buildDigestChoiceRequest(digest, "pick a mission")
  assert.equal(req.kind, "choice")
  assert.equal(req.criteria, "pick a mission")
  assert.equal(req.allow_abstain, false, "the digest has an explicit no_reply, so it must not abstain")
  assert.deepEqual(req.candidates, ["no_reply", "mission:drain", "mission:research"])
  const state = String(req.state)
  assert.ok(state.includes("drain"), "state carries candidate ids")
  assert.ok(state.includes("backlog_pending"), "state carries the signals")
  assert.equal(state, digestStateSummary(digest))
})

test("candidateWarrant: one line per candidacy predicate", () => {
  const base: DigestCandidate = {
    id: "x",
    title: "X",
    frequency: "mid",
    min_level: 2,
    menus: ["day"],
    candidacy: "digest",
    frequency_weight: 0.5,
    mood_bias: 1,
    weight: 0.5,
  }
  const sig = signals({ unconsumed_turns: 930, backlog_pending: 2 })
  const w = (candidacy: DigestCandidate["candidacy"]): string =>
    candidateWarrant({ ...base, candidacy }, sig)
  assert.equal(w("turns-pending"), "unconsumed_turns=930")
  assert.equal(w("backlog-pending"), "backlog_pending=2")
  assert.equal(w("dream-gate"), "dream gate passed")
  assert.equal(w("idea-roll"), "idea quota open")
  assert.equal(w("min-gap:express"), "min-gap express due")
  assert.equal(w("roll:0.5"), "roll 0.5 passed")
  assert.equal(w("digest"), "judgment")
  assert.equal(w("always"), "judgment")
})

test("digestStateSummary: warrants make overdue-ness legible to the JEV", () => {
  const digest = digestFixture({
    signals: signals({ unconsumed_turns: 930, backlog_pending: 2 }),
    candidates: candidatesFor(
      [
        mission({ id: "drain", title: "Drain", frequency: "high", candidacy: "turns-pending" }),
        mission({ id: "queue", title: "Queue", frequency: "mid", candidacy: "backlog-pending" }),
        mission({ id: "express", title: "Express", frequency: "mid", candidacy: "min-gap:express" }),
      ],
      { candidacy: { backlogPending: 2, unconsumedTurns: 930, nowMs: 1_000_000 } },
    ),
  })
  const parsed = JSON.parse(digestStateSummary(digest)) as {
    candidates: Array<{ id: string; warrant: string }>
  }
  assert.deepEqual(
    parsed.candidates.map((c) => [c.id, c.warrant]),
    [
      ["drain", "unconsumed_turns=930"],
      ["queue", "backlog_pending=2"],
      ["express", "min-gap express due"],
    ],
  )
})

test("digestStateSummary: caps oversized digests with an ellipsis", () => {
  const huge = digestFixture({
    candidates: Array.from({ length: 200 }, (_, i) => ({
      id: `m${i}`,
      title: `Mission ${i}`,
      frequency: "mid" as const,
      min_level: 2,
      menus: ["day"],
      candidacy: "digest" as const,
      frequency_weight: 0.5,
      mood_bias: 1,
      weight: 0.5,
    })),
  })
  const s = digestStateSummary(huge)
  assert.ok(s.length <= 1501, `len=${s.length}`)
  assert.ok(s.endsWith("…"))
})

test("assembleMissionBrief: fixed prompt + verdict + mission body, agent from D-M7", () => {
  const drain = mission({ id: "drain", title: "Drain", body: "Do the drain thing.", agent: "rag-brain" })
  const brief = assembleMissionBrief({ kind: "mission", id: "drain" }, drain)
  assert.ok(brief)
  assert.equal(brief.agent, "rag-brain", "agent: set -> child session pins that agent")
  assert.equal(brief.mission_id, "drain")
  assert.ok(brief.prompt.startsWith(HEARTBEAT_FIXED_PROMPT))
  assert.ok(brief.prompt.includes("Verdict: mission:drain — Drain"))
  assert.ok(brief.prompt.endsWith("Do the drain thing."))
})

test("assembleMissionBrief: empty agent means the default heartbeat agent", () => {
  const drain = mission({ id: "drain", agent: "" })
  const brief = assembleMissionBrief({ kind: "mission", id: "drain" }, drain)
  assert.ok(brief)
  assert.equal(brief.agent, "")
})

test("assembleMissionBrief: custom fixed prompt is honoured", () => {
  const m = mission({ id: "drain", body: "B." })
  const brief = assembleMissionBrief({ kind: "mission", id: "drain" }, m, "Fixed frame.")
  assert.ok(brief)
  assert.ok(brief.prompt.startsWith("Fixed frame."))
})

test("assembleMissionBrief: no_reply path -> null, no session to create", () => {
  const drain = mission({ id: "drain" })
  assert.equal(assembleMissionBrief({ kind: "no_reply" }, drain), null)
  assert.equal(assembleMissionBrief({ kind: "no_reply" }, undefined), null)
})

test("assembleMissionBrief: verdict/mission mismatch or missing mission -> null", () => {
  const drain = mission({ id: "drain" })
  assert.equal(assembleMissionBrief({ kind: "mission", id: "research" }, drain), null)
  assert.equal(assembleMissionBrief({ kind: "mission", id: "drain" }, undefined), null)
})

// ---------------------------------------------------------------------------
// Scheduler primitives (card D, plan §12.1): due math + the file lock

test("frequencyToMs parses the dial and fails closed on garbage", () => {
  assert.equal(frequencyToMs("12h"), 12 * 3_600_000)
  assert.equal(frequencyToMs("30m"), 30 * 60_000)
  assert.equal(frequencyToMs(" off "), null)
  for (const bad of ["", "bogus", "0h", "0m", "12H", "1d", "-5m", "12hm"]) {
    assert.equal(frequencyToMs(bad), null, bad)
  }
})

test("computeWakeDelayMs: L0 disables the loop regardless of frequency", () => {
  const now = 1_000_000_000_000
  for (const frequencyMs of [60_000, null]) {
    assert.equal(
      computeWakeDelayMs({ level: 0, frequencyMs, lastTickMs: now - 99 * 3_600_000, nowMs: now }),
      HEARTBEAT_WAKE_CAP_MS,
    )
  }
})

test("computeWakeDelayMs: frequency off sleeps on the cap", () => {
  const now = 1_000_000_000_000
  assert.equal(
    computeWakeDelayMs({ level: 3, frequencyMs: null, lastTickMs: now - 99 * 3_600_000, nowMs: now }),
    HEARTBEAT_WAKE_CAP_MS,
  )
})

test("computeWakeDelayMs: never ticked (or epoch-zero) is overdue -> fires now", () => {
  const now = 1_000_000_000_000
  const freq = 12 * 3_600_000
  assert.equal(computeWakeDelayMs({ level: 3, frequencyMs: freq, lastTickMs: null, nowMs: now }), 0)
  assert.equal(computeWakeDelayMs({ level: 3, frequencyMs: freq, lastTickMs: 0, nowMs: now }), 0)
})

test("computeWakeDelayMs: due math — overdue fires, upcoming waits, cap applies", () => {
  const now = 1_000_000_000_000
  const freq = 12 * 3_600_000
  // elapsed > frequency -> due now (missed ticks coalesce, never replay)
  assert.equal(computeWakeDelayMs({ level: 3, frequencyMs: freq, lastTickMs: now - freq - 1, nowMs: now }), 0)
  // exactly at the boundary -> due
  assert.equal(computeWakeDelayMs({ level: 3, frequencyMs: freq, lastTickMs: now - freq, nowMs: now }), 0)
  // one minute left -> the remaining window
  assert.equal(computeWakeDelayMs({ level: 3, frequencyMs: freq, lastTickMs: now - freq + 60_000, nowMs: now }), 60_000)
  // eleven hours left -> capped at the 60 s wake (hot config)
  assert.equal(
    computeWakeDelayMs({ level: 3, frequencyMs: freq, lastTickMs: now - 3_600_000, nowMs: now }),
    HEARTBEAT_WAKE_CAP_MS,
  )
  // a last tick "in the future" (clock skew) -> never negative
  assert.equal(computeWakeDelayMs({ level: 3, frequencyMs: freq, lastTickMs: now + freq, nowMs: now }), HEARTBEAT_WAKE_CAP_MS)
})

test("isHeartbeatLockStale: fresh holds, old and malformed steal", () => {
  const now = 1_000_000_000_000
  const fresh = { pid: 1, acquired_ms: now - 1_000, acquired_at: "x" }
  assert.equal(isHeartbeatLockStale(fresh, now), false)
  // One ms before the threshold still holds; at the threshold it is stale.
  assert.equal(isHeartbeatLockStale({ ...fresh, acquired_ms: now - HEARTBEAT_LOCK_STALE_MS + 1 }, now), false)
  assert.equal(isHeartbeatLockStale({ ...fresh, acquired_ms: now - HEARTBEAT_LOCK_STALE_MS }, now), true)
  assert.equal(isHeartbeatLockStale(null, now), true)
  assert.equal(isHeartbeatLockStale({ pid: 1, acquired_ms: Number.NaN, acquired_at: "x" }, now), true)
})

test("acquireHeartbeatLock: exclusive create, fresh holder skips, release frees", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hb-lock-"))
  const file = join(dir, "heartbeat.lock")
  const now = 1_000_000_000_000

  const first = await acquireHeartbeatLock(file, now)
  assert.ok(first)
  assert.equal(first.pid, process.pid)
  const onDisk = JSON.parse(await readFile(file, "utf8"))
  assert.equal(onDisk.acquired_ms, now)

  // Second acquire against the fresh lock -> overrun skip.
  assert.equal(await acquireHeartbeatLock(file, now + 1_000), null)

  await releaseHeartbeatLock(file)
  const third = await acquireHeartbeatLock(file, now + 2_000)
  assert.ok(third)
  await releaseHeartbeatLock(file)
  // Releasing a missing lock is a no-op, never throws.
  await releaseHeartbeatLock(file)
  await rm(dir, { recursive: true, force: true })
})

test("acquireHeartbeatLock: a stale lock is stolen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hb-lock-stale-"))
  const file = join(dir, "heartbeat.lock")
  const now = 1_000_000_000_000
  await writeFile(
    file,
    JSON.stringify({ pid: 999, acquired_ms: now - HEARTBEAT_LOCK_STALE_MS - 1, acquired_at: "old" }),
    "utf8",
  )
  const stolen = await acquireHeartbeatLock(file, now)
  assert.ok(stolen)
  assert.equal(stolen.pid, process.pid)
  const onDisk = JSON.parse(await readFile(file, "utf8"))
  assert.equal(onDisk.acquired_ms, now)
  await releaseHeartbeatLock(file)
  await rm(dir, { recursive: true, force: true })
})

test("acquireHeartbeatLock: a malformed lock is stolen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hb-lock-junk-"))
  const file = join(dir, "heartbeat.lock")
  await writeFile(file, "not json", "utf8")
  const stolen = await acquireHeartbeatLock(file)
  assert.ok(stolen)
  await releaseHeartbeatLock(file)
  await rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// `heartbeat:` config block (card E, plan §7)

test("parseHeartbeatConfig: defaults, overlay, and the nested autonomy dial never bleed in", () => {
  const yaml = [
    "autonomy:",
    "  level: 3",
    "  heartbeat:",
    "    frequency: 30m",
    "    in_progress_lock: false",
    "heartbeat:",
    "  enabled: false",
    "  long_silence_factor: 5",
    "  log: hb-custom.log",
    "  log_rotate_bytes: 4096",
    "",
  ].join("\n")
  const cfg = parseHeartbeatConfig(yaml)
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.long_silence_factor, 5)
  assert.equal(cfg.log, "hb-custom.log")
  assert.equal(cfg.log_rotate_bytes, 4096)
  // The nested `autonomy.heartbeat:` dial (frequency/lock) must not be read
  // by the top-level section parser, and unknown keys are ignored.
  assert.equal((cfg as any).frequency, undefined)
  assert.equal((cfg as any).in_progress_lock, undefined)
  assert.equal((cfg as any).bogus, undefined)
})

test("parseHeartbeatConfig: empty input yields no overrides", () => {
  assert.deepEqual(parseHeartbeatConfig(""), {})
  assert.deepEqual(parseHeartbeatConfig("mood:\n  dispatch_influence: false\n"), {})
})

test("readHeartbeatConfig: defaults without a file, overlay with one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hb-cfg-"))
  // No config file at all → the shipped defaults stand.
  const defaults = await readHeartbeatConfig(dir)
  assert.deepEqual(defaults, DEFAULT_HEARTBEAT_CONFIG)
  // Overlay.
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(
    join(dir, ".opencode", "sysop-config.yaml"),
    "heartbeat:\n  enabled: false\n  long_silence_factor: 0\n  log: x.log\n",
    "utf8",
  )
  const cfg = await readHeartbeatConfig(dir)
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.long_silence_factor, 0)
  assert.equal(cfg.log, "x.log")
  assert.equal(cfg.log_keep_generations, DEFAULT_HEARTBEAT_CONFIG.log_keep_generations)
  await rm(dir, { recursive: true, force: true })
})

// B7 day-side backoff (missions-plan §7 — the day twin of §17.8): the
// effective cadence stretches ×2 at streak 2 and ×4 at streak 3+; `off`
// (null) passes through untouched.
test("effectiveFrequencyMs: B7 stretches the day cadence ×2/×4; off stays off", () => {
  const H = 3_600_000
  assert.equal(effectiveFrequencyMs(12 * H, 0), 12 * H, "fresh state → base cadence")
  assert.equal(effectiveFrequencyMs(12 * H, 1), 12 * H, "one no_reply → still base (steps AFTER 2)")
  assert.equal(effectiveFrequencyMs(12 * H, 2), 24 * H, "streak 2 → ×2")
  assert.equal(effectiveFrequencyMs(12 * H, 3), 48 * H, "streak 3+ → ×4")
  assert.equal(effectiveFrequencyMs(null, 5), null, "frequency: off ignores the streak")
})

// Live status marker (card 16 §9.2): round-trips through
// state/heartbeat.current.json; a missing/corrupt file reads as null so the
// dashboard renders idle instead of throwing.
test("heartbeat.current marker: write/read round-trip; missing/corrupt → null", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hb-current-"))
  const file = join(dir, HEARTBEAT_CURRENT_FILE)
  assert.equal(await readHeartbeatCurrent(file), null, "missing → null")

  const marker = {
    ...idleHeartbeatCurrent("2026-10-15T00:00:00.000Z"),
    state: "in-flight" as const,
    tick: 7,
    phase: "mission" as const,
    mission: "drain",
    mission_title: "Drain the turn buffer",
    session: "ses_abc",
    started_at: "2026-10-15T00:00:00.000Z",
    level: 3,
  }
  await writeHeartbeatCurrent(file, marker)
  const read = await readHeartbeatCurrent(file)
  assert.equal(read?.state, "in-flight")
  assert.equal(read?.tick, 7)
  assert.equal(read?.mission, "drain")
  assert.equal(read?.session, "ses_abc")

  await writeFile(file, "{ not json", "utf8")
  assert.equal(await readHeartbeatCurrent(file), null, "corrupt → null")
  await rm(dir, { recursive: true, force: true })
})

test("computeDigest: memory.provider none yields zero unconsumed turns", async () => {
  const dir = await tmpProject({
    ".opencode/sysop-config.yaml": [
      "autonomy:",
      "  level: 2",
      "memory:",
      "  provider: none",
      "",
    ].join("\n"),
    ".opencode/state/.keep": "",
    ".opencode/missions/drain.md": [
      "---",
      "id: drain",
      "title: Drain",
      "frequency: high",
      "menus: [day, night]",
      "min_level: 2",
      "candidacy: turns-pending",
      "enabled: true",
      "---",
      "Body.",
      "",
    ].join("\n"),
  })
  const dbFile = seedTurnsDb(dir, [Date.parse("2026-10-13T00:00:00.000Z")])
  const digest = await computeDigest(dir, { now: at(12, 0), dbFile })
  assert.equal(digest.signals.unconsumed_turns, 0)
  assert.deepEqual(digest.candidates.map((c) => c.id), [])
})

// ---------------------------------------------------------------------------
// Stale-code guard

test("staleCodeFiles flags plugin files newer than the process start", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hb-stale-"))
  const a = join(dir, ".opencode/plugin/heartbeat-hook.ts")
  const b = join(dir, ".opencode/plugin/lib/heartbeat.ts")
  await mkdir(join(dir, ".opencode/plugin/lib"), { recursive: true })
  await writeFile(a, "// a\n")
  await writeFile(b, "// b\n")
  const old = new Date(Date.now() - 120_000)
  await utimes(a, old, old)
  await utimes(b, old, old)
  const startedAt = Date.now() - 60_000
  assert.deepEqual(await staleCodeFiles(dir, startedAt), [], "both predate the process")
  const future = new Date(Date.now() + 60_000)
  await utimes(b, future, future)
  assert.deepEqual(await staleCodeFiles(dir, startedAt), [".opencode/plugin/lib/heartbeat.ts"])
  assert.deepEqual(await staleCodeFiles(dir, Date.now() + 120_000), [], "nothing postdates a later start")
  await rm(dir, { recursive: true, force: true })
})

test("staleCodeFiles ignores a project without plugin files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hb-stale-empty-"))
  assert.deepEqual(await staleCodeFiles(dir, Date.now()), [])
  await rm(dir, { recursive: true, force: true })
})
