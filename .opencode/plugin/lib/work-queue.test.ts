import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  WORK_PRIORITY,
  dequeueById,
  emptyQueue,
  enqueueWork,
  isDue,
  loadWorkQueue,
  pickNext,
  pruneWork,
  queueDepth,
  queueEmpty,
  requeueTail,
  saveWorkQueue,
  stallResumeItem,
  type WorkItem,
} from "./work-queue.ts"

const item = (over: Partial<WorkItem>): WorkItem => ({
  id: "mission:a",
  kind: "mission",
  producer: "tick",
  enqueued_ms: 0,
  requeue_count: 0,
  ...over,
})

test("pickNext: priority order is mission > drain-pass > dream > staleness > profile > soul", () => {
  const now = 1_000
  const all: WorkItem[] = [
    item({ id: "soul", kind: "soul-update", enqueued_ms: 1 }),
    item({ id: "staleness", kind: "staleness", enqueued_ms: 2 }),
    item({ id: "dream", kind: "dream", enqueued_ms: 3 }),
    item({ id: "drain", kind: "drain-pass", enqueued_ms: 4 }),
    item({ id: "mission", kind: "mission", enqueued_ms: 5 }),
    item({ id: "profile", kind: "profile-update", enqueued_ms: 6 }),
  ]
  assert.deepEqual(
    Object.values(WORK_PRIORITY),
    [0, 1, 2, 3, 4, 5],
    "the plan's order is the numeric order",
  )
  const picked: string[] = []
  let queue = all
  while (!queueEmpty(queue)) {
    const next = pickNext(queue, now)
    assert.ok(next)
    picked.push(next!.id)
    queue = dequeueById(queue, next!.id)!.rest
  }
  assert.deepEqual(picked, ["mission", "drain", "dream", "staleness", "profile", "soul"])
})

test("pickNext: FIFO within a kind and not_before gates visibility", () => {
  const queue = [
    item({ id: "mission:b", enqueued_ms: 20, not_before_ms: 5_000 }),
    item({ id: "mission:a", enqueued_ms: 10 }),
  ]
  assert.equal(pickNext(queue, 1_000)?.id, "mission:a", "not_before 5000 is not due")
  assert.equal(isDue(queue[0], 5_000), true)
  assert.equal(pickNext(queue, 5_000)?.id, "mission:a", "earlier enqueue wins")
  assert.equal(pickNext([queue[0]], 5_000)?.id, "mission:b")
})

test("enqueueWork dedupes by id and preserves the original enqueue time", () => {
  const queue = enqueueWork(emptyQueue(), [item({ id: "mission:a", enqueued_ms: 10 })])
  const again = enqueueWork(queue, [item({ id: "mission:a", enqueued_ms: 99 })])
  assert.equal(again.length, 1)
  assert.equal(again[0].enqueued_ms, 10)
})

test("requeueTail refreshes the timestamp, records the reason, and caps", () => {
  const requeued = requeueTail(item({ id: "mission:a", enqueued_ms: 10 }), "timeout", 50)
  assert.ok(requeued)
  assert.equal(requeued!.enqueued_ms, 50)
  assert.equal(requeued!.requeue_reason, "timeout")
  assert.equal(requeued!.payload?.original_enqueued_ms, 10)
  assert.equal(requeueTail(item({ requeue_count: 3 }), "timeout", 60), null)
})

test("stallResumeItem carries the resume payload under the same id", () => {
  const next = stallResumeItem(item({ id: "mission:a" }), { summary: "done" }, 70)
  assert.ok(next)
  assert.equal(next!.id, "mission:a")
  assert.equal(next!.payload?.resume, true)
  assert.equal(next!.payload?.summary, "done")
  assert.equal(next!.payload?.timeout_count, 1)
})

test("pruneWork drops expired items and work whose status is gone", () => {
  const queue = [
    item({ id: "mission:a", expires_ms: 100 }),
    item({ id: "mission:b" }),
    item({ id: "mission:c", kind: "staleness" }),
  ]
  const { queue: kept, dropped } = pruneWork(queue, 200, (i) => i.kind !== "staleness")
  assert.deepEqual(kept.map((i) => i.id), ["mission:b"])
  assert.deepEqual(dropped.map((i) => i.id).sort(), ["mission:a", "mission:c"])
})

test("loadWorkQueue migrates a legacy lanes file and round-trips an array", async () => {
  const dir = await mkdtemp(join(tmpdir(), "work-queue-"))
  const legacy = join(dir, "work-queue.json")
  await writeFile(
    legacy,
    JSON.stringify({
      primary: [{ id: "mission:a", kind: "mission", producer: "tick", enqueued_ms: 1 }],
      side: [{ id: "mission:b", kind: "mission", producer: "turns-pending", enqueued_ms: 2 }],
    }),
    "utf8",
  )
  const migrated = await loadWorkQueue(legacy)
  assert.equal(migrated.find((i) => i.id === "mission:a")?.kind, "mission")
  assert.equal(migrated.find((i) => i.id === "mission:b")?.kind, "staleness")

  const now = Date.now()
  await saveWorkQueue(legacy, [item({ id: "mission:c", enqueued_ms: now })])
  const reloaded = await loadWorkQueue(legacy)
  assert.equal(reloaded.length, 1)
  assert.equal(reloaded[0].id, "mission:c")
  assert.equal(queueDepth(reloaded), 1)
})

test("loadWorkQueue: a corrupt file is an empty queue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "work-queue-"))
  const file = join(dir, "work-queue.json")
  await writeFile(file, "{ not json", "utf8")
  assert.deepEqual(await loadWorkQueue(file), [])
})
