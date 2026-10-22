import { test } from "node:test"
import assert from "node:assert/strict"

import {
  collectItems,
  itemRunnable,
  itemStillDue,
  missionIdOf,
  missionItemId,
  brainStaleProducer,
  tickProducer,
  turnsPendingProducer,
  type ProducerCtx,
} from "./producers.ts"
import { parseMissionFile, type Mission } from "../missions.ts"
import type { DigestCandidate, HeartbeatSignals } from "../heartbeat.ts"

const T0 = 1_700_000_000_000

function mission(id: string, frontmatter: string[]): Mission {
  const { mission: m } = parseMissionFile(
    ["---", `id: ${id}`, ...frontmatter, "---", "", "body", ""].join("\n"),
    id,
  )
  return m
}

function signals(over: Partial<HeartbeatSignals> = {}): HeartbeatSignals {
  return {
    backlog_pending: 0,
    unconsumed_turns: 0,
    audit_failures: 0,
    staleness: {},
    brain_oldest: null,
    quiet: false,
    ...over,
  }
}

function candidate(id: string, over: Partial<DigestCandidate> = {}): DigestCandidate {
  return {
    id,
    title: id,
    frequency: "mid",
    min_level: 2,
    menus: ["day"],
    candidacy: "digest",
    frequency_weight: 0.5,
    mood_bias: 1,
    weight: 0.5,
    ...over,
  }
}

function ctx(over: Partial<ProducerCtx> = {}): ProducerCtx {
  return {
    nowMs: T0,
    level: 3,
    quiet: false,
    signals: signals(),
    missions: [],
    candidates: [],
    lastMission: null,
    ...over,
  }
}

test("missionItemId round-trips", () => {
  assert.equal(missionItemId("drain"), "mission:drain")
  assert.equal(missionIdOf({ id: "mission:drain" } as never), "drain")
  assert.equal(missionIdOf({ id: "telegram:1" } as never), null)
})

test("tick producer projects primary candidates into expiring items", () => {
  const items = tickProducer.collect(
    ctx({ candidates: [candidate("research"), candidate("free-run")] }),
  )
  assert.deepEqual(items.map((i) => i.id), ["mission:research", "mission:free-run"])
  for (const i of items) {
    assert.equal(i.lane, "primary")
    assert.equal(i.producer, "tick")
    assert.equal(i.kind, "mission")
    assert.equal(i.expires_ms, T0 + 24 * 3_600_000, "primary items carry the 24h TTL")
  }
})

test("turns-pending producer fires only with unconsumed turns", () => {
  const drain = mission("drain", ["candidacy: turns-pending", "lane: side", "menus: [day, night]"])
  const due = ctx({ missions: [drain], signals: signals({ unconsumed_turns: 3 }) })
  const items = turnsPendingProducer.collect(due)
  assert.deepEqual(items.map((i) => i.id), ["mission:drain"])
  assert.equal(items[0].lane, "side")
  assert.equal(items[0].producer, "turns-pending")
  assert.equal(items[0].expires_ms, undefined, "side items never expire")

  assert.deepEqual(turnsPendingProducer.collect(ctx({ missions: [drain] })), [])
})

test("drain consumer owns drain: turns-pending stops collecting, staleness untouched (plan §4)", () => {
  const drain = mission("drain", ["candidacy: turns-pending", "lane: side", "menus: [day, night]"])
  const stale = mission("staleness", ["candidacy: brain-stale:720", "lane: side", "menus: [day, night]"])
  const note = { path: "Ref/note.md", title: "note", updated: "2026-01-01", ageHours: 900 }

  const base = ctx({
    missions: [drain, stale],
    signals: signals({ unconsumed_turns: 3, brain_oldest: note }),
    drainConsumer: true,
  })
  assert.deepEqual(turnsPendingProducer.collect(base), [], "drain leaves the queues")
  assert.deepEqual(collectItems(base).map((i) => i.id), ["mission:staleness"], "staleness still runs")

  // A queued drain item is no longer runnable and is pruned.
  const asSide = { id: "mission:drain", lane: "side" } as never
  assert.equal(itemRunnable(base, asSide), false)
  assert.equal(itemStillDue(base, asSide), false, "drops out of the queue on the next prune")

  // Rollback path: consumer off restores the old behaviour.
  const legacy = { ...base, drainConsumer: false }
  assert.deepEqual(turnsPendingProducer.collect(legacy).map((i) => i.id), ["mission:drain"])
})

test("brain-stale producer honours the candidacy threshold", () => {
  const stale = mission("staleness", ["candidacy: brain-stale:720", "lane: side"])
  const note = {
    path: "Ref/note.md",
    title: "note",
    updated: "2026-01-01",
    ageHours: 800,
  }
  const old = ctx({ missions: [stale], signals: signals({ brain_oldest: note }) })
  assert.deepEqual(brainStaleProducer.collect(old).map((i) => i.id), ["mission:staleness"])

  const young = ctx({
    missions: [stale],
    signals: signals({ brain_oldest: { ...note, ageHours: 100 } }),
  })
  assert.deepEqual(brainStaleProducer.collect(young), [])

  // No reference notes at all: fail closed (candidacyPasses semantics).
  assert.deepEqual(brainStaleProducer.collect(ctx({ missions: [stale] })), [])
})

test("side producers ignore primary missions and unbound candidacies", () => {
  const primaryTurns = mission("not-side", ["candidacy: turns-pending"]) // lane defaults to primary
  const sideJudgment = mission("side-judgment", ["lane: side", "candidacy: digest"])
  const items = collectItems(
    ctx({
      missions: [primaryTurns, sideJudgment],
      signals: signals({ unconsumed_turns: 2 }),
    }),
  )
  assert.deepEqual(items, [])
})

test("menu window and level gate collection", () => {
  const dayOnly = mission("staleness", ["candidacy: brain-stale:720", "lane: side", "menus: [day]"])
  const note = { path: "p", title: "t", updated: "2026-01-01", ageHours: 900 }

  // Night window: a day-only side mission is not collected.
  const night = ctx({
    missions: [dayOnly],
    signals: signals({ brain_oldest: note, quiet: true }),
    quiet: true,
  })
  assert.deepEqual(brainStaleProducer.collect(night), [])

  // Level below min_level: not collected.
  const low = ctx({ missions: [dayOnly], signals: signals({ brain_oldest: note }), level: 1 })
  assert.deepEqual(brainStaleProducer.collect(low), [])

  // Disabled: not collected.
  const off = mission("off", ["candidacy: turns-pending", "lane: side", "enabled: false"])
  assert.deepEqual(turnsPendingProducer.collect(ctx({ missions: [off], signals: signals({ unconsumed_turns: 1 }) })), [])
})

test("collectItems merges every producer", () => {
  const drain = mission("drain", ["candidacy: turns-pending", "lane: side", "menus: [day, night]"])
  const items = collectItems(
    ctx({
      missions: [drain],
      candidates: [candidate("research")],
      signals: signals({ unconsumed_turns: 1 }),
    }),
  )
  assert.deepEqual(items.map((i) => i.id).sort(), ["mission:drain", "mission:research"])
})

test("itemRunnable: primary items track the candidate list, side items re-check status", () => {
  const drain = mission("drain", ["candidacy: turns-pending", "lane: side", "menus: [day, night]"])
  const base = ctx({
    missions: [drain],
    candidates: [candidate("research")],
    signals: signals({ unconsumed_turns: 5 }),
  })
  const asPrimary = (id: string) => ({ id, lane: "primary" }) as never
  const asSide = (id: string) => ({ id, lane: "side" }) as never

  assert.equal(itemRunnable(base, asPrimary("mission:research")), true)
  const emptyCtx = ctx({ missions: [drain] })
  assert.equal(itemRunnable(emptyCtx, asPrimary("mission:research")), false)

  assert.equal(itemRunnable(base, asSide("mission:drain")), true)
  const noTurns = ctx({ missions: [drain], signals: signals({ unconsumed_turns: 0 }) })
  assert.equal(itemRunnable(noTurns, asSide("mission:drain")), false)

  // A day-only side item is not runnable at night but is not dropped either.
  const dayOnly = mission("staleness", ["candidacy: brain-stale:720", "lane: side", "menus: [day]"])
  const night = ctx({
    missions: [dayOnly],
    signals: signals({ brain_oldest: { path: "p", title: "t", updated: "u", ageHours: 900 }, quiet: true }),
    quiet: true,
  })
  assert.equal(itemRunnable(night, asSide("mission:staleness")), false)
  assert.equal(itemStillDue(night, asSide("mission:staleness")), true, "waits for the day window")
})

test("itemStillDue: primary survives, side drops when the status is gone", () => {
  const drain = mission("drain", ["candidacy: turns-pending", "lane: side", "menus: [day, night]"])
  const gone = ctx({ missions: [drain], signals: signals({ unconsumed_turns: 0 }) })
  assert.equal(itemStillDue(gone, { id: "mission:drain", lane: "side" } as never), false)
  assert.equal(itemStillDue(gone, { id: "mission:research", lane: "primary" } as never), true)
})
