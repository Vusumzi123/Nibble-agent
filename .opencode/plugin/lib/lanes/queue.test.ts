import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  LANES_FILE,
  MAX_REQUEUES,
  PRIMARY_TTL_MS,
  dequeuePrimary,
  dequeueSide,
  emptyQueues,
  enqueueItems,
  loadQueues,
  pruneQueues,
  queueDepth,
  queuesEmpty,
  requeueTail,
  saveQueues,
  stallResumeItem,
  type QueueItem,
} from "./queue.ts"

const T0 = 1_700_000_000_000

function item(id: string, over: Partial<QueueItem> = {}): QueueItem {
  return {
    id,
    kind: "mission",
    lane: "side",
    producer: "test",
    enqueued_ms: T0,
    requeue_count: 0,
    ...over,
  }
}

test("enqueueItems dedupes by id and keeps the ORIGINAL enqueued_ms", () => {
  let q = emptyQueues()
  q = enqueueItems(q, [item("mission:drain", { enqueued_ms: T0 })])
  q = enqueueItems(q, [item("mission:drain", { enqueued_ms: T0 + 99_000 })])
  assert.equal(q.side.length, 1)
  assert.equal(q.side[0].enqueued_ms, T0, "a re-collected item must not jump the queue")
})

test("side dequeue is FIFO among runnable items; blocked items stay queued", () => {
  const q = {
    primary: [],
    side: [
      item("mission:staleness", { enqueued_ms: T0 }),
      item("mission:drain", { enqueued_ms: T0 + 1 }),
    ],
  }
  // Head is window-blocked: the next runnable item runs, head waits.
  const pick = dequeueSide(q, (i) => i.id !== "mission:staleness")
  assert.ok(pick)
  assert.equal(pick.item.id, "mission:drain")
  assert.deepEqual(pick.rest.side.map((i) => i.id), ["mission:staleness"])

  // Nothing runnable: no dequeue.
  assert.equal(dequeueSide(q, () => false), null)

  // Strict FIFO when everything is runnable.
  const all = dequeueSide(q)
  assert.ok(all)
  assert.equal(all.item.id, "mission:staleness", "head first")
})

test("only one side item dequeues per call", () => {
  const q = {
    primary: [],
    side: [item("mission:staleness", { enqueued_ms: T0 }), item("mission:drain", { enqueued_ms: T0 + 1 })],
  }
  const first = dequeueSide(q)
  assert.ok(first)
  assert.equal(first.rest.side.length, 1, "the second item waits for the next tick")
})

test("dequeuePrimary removes exactly the chosen item", () => {
  const q = {
    primary: [item("mission:a", { lane: "primary", enqueued_ms: T0 }), item("mission:b", { lane: "primary", enqueued_ms: T0 + 1 })],
    side: [],
  }
  const pick = dequeuePrimary(q, "mission:b")
  assert.ok(pick)
  assert.equal(pick.item.id, "mission:b")
  assert.deepEqual(pick.rest.primary.map((i) => i.id), ["mission:a"])
  assert.equal(dequeuePrimary(q, "mission:missing"), null)
})

test("requeueTail puts a timed-out item at the tail with the reason", () => {
  const it = item("mission:drain", { enqueued_ms: T0 })
  const requeued = requeueTail(it, "timeout", T0 + 5_000)
  assert.ok(requeued)
  assert.equal(requeued.enqueued_ms, T0 + 5_000, "fresh timestamp = tail")
  assert.equal(requeued.requeue_count, 1)
  assert.equal(requeued.requeue_reason, "timeout")
  assert.equal(requeued.payload?.original_enqueued_ms, T0, "the original wait is kept")

  // Past MAX_REQUEUES the item must drop (no infinite loop).
  let hot = item("mission:drain", { requeue_count: MAX_REQUEUES })
  assert.equal(requeueTail(hot, "timeout", T0), null)
  hot = item("mission:drain", { requeue_count: MAX_REQUEUES - 1 })
  assert.ok(requeueTail(hot, "timeout", T0))
})

test("a requeued item sorts to the tail of the side lane", () => {
  const early = item("mission:drain", { enqueued_ms: T0 })
  const late = item("mission:staleness", { enqueued_ms: T0 + 1_000 })
  const requeued = requeueTail(early, "timeout", T0 + 9_000)!
  const q = enqueueItems(emptyQueues(), [late, requeued])
  assert.deepEqual(q.side.map((i) => i.id), ["mission:staleness", "mission:drain"])
})

test("pruneQueues drops expired primary items and due-gone side items", () => {
  const q = {
    primary: [
      item("mission:old", { lane: "primary", expires_ms: T0 - 1 }),
      item("mission:fresh", { lane: "primary", expires_ms: T0 + PRIMARY_TTL_MS }),
    ],
    side: [
      item("mission:stale-gone"),
      item("mission:still-due"),
    ],
  }
  const { queues, dropped } = pruneQueues(q, T0, (i) => i.id !== "mission:stale-gone")
  assert.deepEqual(queues.primary.map((i) => i.id), ["mission:fresh"])
  assert.deepEqual(queues.side.map((i) => i.id), ["mission:still-due"])
  assert.deepEqual(dropped.map((i) => i.id).sort(), ["mission:old", "mission:stale-gone"])
})

test("side items never expire by age", () => {
  const q = { primary: [], side: [item("mission:drain", { enqueued_ms: 0 })] }
  const { queues } = pruneQueues(q, T0 + 365 * 24 * 3_600_000, () => true)
  assert.equal(queues.side.length, 1, "no expiry: the side lane waits indefinitely")
})

test("load/save round-trips and survives corruption", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lanes-"))
  const file = join(dir, LANES_FILE)
  const q = enqueueItems(emptyQueues(), [
    item("mission:drain", { enqueued_ms: T0 }),
    item("mission:x", { lane: "primary", enqueued_ms: T0 + 1, expires_ms: T0 + 10 }),
  ])
  await saveQueues(file, q)
  const back = await loadQueues(file)
  assert.equal(back.side.length, 1)
  assert.equal(back.primary.length, 1)
  assert.equal(back.primary[0].expires_ms, T0 + 10)

  await writeFile(file, "{not json", "utf8")
  const broken = await loadQueues(file)
  assert.ok(queuesEmpty(broken))

  await writeFile(file, JSON.stringify({ primary: [{ junk: true }], side: "nope" }), "utf8")
  const junk = await loadQueues(file)
  assert.ok(queuesEmpty(junk))
})

test("depth caps drop the oldest items", () => {
  const items = Array.from({ length: 60 }, (_, i) =>
    item(`mission:m${i}`, { enqueued_ms: T0 + i }),
  )
  const q = enqueueItems(emptyQueues(), items)
  assert.equal(q.side.length, 50)
  assert.equal(q.side[0].id, "mission:m10", "oldest overflow items dropped")
  assert.deepEqual(queueDepth(q), { primary: 0, side: 50 })
})

test("LANES_FILE lands under state/", () => {
  assert.equal(LANES_FILE, "lanes.json")
})

const SUMMARY = { done: "wrote queue.ts", remaining: "wire the hook", next_steps: ["hook"], notes: "" }

function resumePayload(over = {}) {
  return {
    prior_session: "ses_abc",
    stopped_at: "2026-10-23T18:00:00.000Z",
    aborted: true,
    summary: SUMMARY,
    stalled_for_ms: 600_000,
    last_activity: "tool:bash",
    ...over,
  }
}

test("stallResumeItem requeues at the tail with the resume payload", () => {
  const it = item("mission:p4", { lane: "primary", requeue_count: 1 })
  const requeued = stallResumeItem(it, resumePayload(), T0 + 5_000)!
  assert.equal(requeued.id, "mission:p4")
  assert.equal(requeued.kind, "mission")
  assert.equal(requeued.lane, "primary")
  assert.equal(requeued.producer, "timeout")
  assert.equal(requeued.requeue_reason, "timeout")
  assert.equal(requeued.requeue_count, 2)
  assert.equal(requeued.enqueued_ms, T0 + 5_000)
  assert.equal(requeued.payload?.original_enqueued_ms, T0)
  assert.equal(requeued.payload?.resume, true)
  assert.equal(requeued.payload?.timeout_count, 2)
  assert.equal(requeued.payload?.prior_session, "ses_abc")
  assert.deepEqual(requeued.payload?.summary, SUMMARY)
  assert.equal(requeued.payload?.stalled_for_ms, 600_000)
  assert.equal(requeued.payload?.last_activity, "tool:bash")
})

test("stallResumeItem keeps an existing original_enqueued_ms and expires_ms", () => {
  const it = item("mission:later", {
    lane: "primary",
    requeue_count: 0,
    expires_ms: T0 + 60_000,
    payload: { original_enqueued_ms: T0 - 1_000 },
  })
  const requeued = stallResumeItem(it, resumePayload(), T0 + 5_000)!
  assert.equal(requeued.payload?.original_enqueued_ms, T0 - 1_000)
  assert.equal(requeued.expires_ms, T0 + 60_000)
})

test("the 4th stall drops the item", () => {
  const hot = item("mission:p4", { requeue_count: MAX_REQUEUES })
  assert.equal(stallResumeItem(hot, resumePayload(), T0), null)
})

test("a producer re-collect after a resume dedupes and keeps the resume payload", () => {
  const resumed = stallResumeItem(item("mission:p4", { lane: "primary" }), resumePayload(), T0 + 5_000)!
  let q = enqueueItems(emptyQueues(), [resumed])
  q = enqueueItems(q, [item("mission:p4", { lane: "primary", producer: "tick", enqueued_ms: T0 + 9_000 })])
  assert.equal(q.primary.length, 1)
  assert.equal(q.primary[0].enqueued_ms, T0 + 5_000, "the existing resume item wins")
  assert.equal(q.primary[0].payload?.resume, true)
})
