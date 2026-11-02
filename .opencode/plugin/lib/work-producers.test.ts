// Producer-side eligibility: the chron scan owns mission/staleness production,
// user tasks are file-ingested, and only drain is still collected inline.
import { test } from "node:test"
import assert from "node:assert/strict"

import { parseMissionFile, type Mission } from "./missions.ts"
import {
  itemRunnable,
  itemStillDue,
  missionItemId,
  type ProducerCtx,
} from "./work-producers.ts"
import type { WorkItem } from "./work-queue.ts"

function mission(over: Partial<Mission> = {}): Mission {
  const { mission: base } = parseMissionFile(
    "---\nid: x\ntitle: X\nschedule: every 1h\nmenus: [day]\nmin_level: 2\ncandidacy: always\n---\nBody.\n",
    "x",
  )
  return { ...base, ...over }
}

function ctx(over: Partial<ProducerCtx> = {}): ProducerCtx {
  return {
    nowMs: 1_000,
    level: 3,
    quiet: false,
    signals: { backlog_pending: 0, unconsumed_turns: 0, audit_failures: 0, staleness: {}, quiet: false },
    missions: [],
    ...over,
  }
}

test("a queued mission is a reservation: a failed roll does not make it unrunnable", () => {
  // The mission is not in the current candidate list (its roll failed), but
  // the queued item still runs because candidacy was decided at enqueue time.
  const c = ctx({ missions: [mission({ id: "free", candidacy: "roll:0.1" })] })
  const item: WorkItem = {
    id: missionItemId("free"),
    kind: "mission",
    producer: "tick",
    enqueued_ms: 1,
    requeue_count: 0,
  }
  assert.equal(itemRunnable(c, item), true)
})

test("runnability still honours enabled, menu, level, and staleness status", () => {
  const night = mission({ id: "day-only", menus: ["day"] })
  const item = (id: string, kind: WorkItem["kind"] = "mission"): WorkItem => ({
    id: missionItemId(id),
    kind,
    producer: "tick",
    enqueued_ms: 1,
    requeue_count: 0,
  })
  assert.equal(itemRunnable(ctx({ missions: [night] }), item("day-only")), true)
  assert.equal(itemRunnable(ctx({ missions: [night], quiet: true }), item("day-only")), false)
  assert.equal(itemRunnable(ctx({ missions: [{ ...night, enabled: false }] }), item("day-only")), false)
  assert.equal(itemRunnable(ctx({ missions: [{ ...night, min_level: 4 }] }), item("day-only")), false)

  const stale = mission({ id: "stale", candidacy: "brain-stale:720" })
  assert.equal(itemRunnable(ctx({ missions: [stale] }), item("stale", "staleness")), false)
  assert.equal(
    itemRunnable(
      ctx({
        missions: [stale],
        signals: {
          backlog_pending: 0,
          unconsumed_turns: 0,
          audit_failures: 0,
          staleness: {},
          quiet: false,
          brain_oldest: { path: "Old.md", title: "Old", updated: "2020-01-01", ageHours: 800 },
        },
      }),
      item("stale", "staleness"),
    ),
    true,
  )
})

test("itemStillDue drops a staleness item only when its status is gone", () => {
  const stale = mission({ id: "stale", candidacy: "brain-stale:720" })
  const item: WorkItem = {
    id: missionItemId("stale"),
    kind: "staleness",
    producer: "brain-stale",
    enqueued_ms: 1,
    requeue_count: 0,
  }
  assert.equal(itemStillDue(ctx({ missions: [stale] }), item), false)
  assert.equal(itemStillDue(ctx({ missions: [stale] }), { ...item, kind: "mission" }), true, "missions are TTL-only")
})
