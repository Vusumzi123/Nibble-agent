import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_WORK_WEIGHTS,
  KIND_ORDER,
  dequeueById,
  emptyQueue,
  emptyScheduler,
  enqueueWork,
  loadWorkQueue,
  loadWorkQueueState,
  pickFair,
  pruneWork,
  queueDepth,
  requeueTail,
  saveWorkQueue,
  saveWorkQueueState,
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

test("loadWorkQueue round-trips a v2 array", async () => {
  const dir = await mkdtemp(join(tmpdir(), "work-queue-"))
  const file = join(dir, "work-queue.json")
  const now = Date.now()
  await saveWorkQueue(file, [item({ id: "mission:c", enqueued_ms: now })])
  const reloaded = await loadWorkQueue(file)
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

function runFairRounds(
  kinds: Array<{ kind: WorkItem["kind"]; weight: number }>,
  rounds: number,
): Array<WorkItem["kind"]> {
  const scheduler = emptyScheduler({
    ...DEFAULT_WORK_WEIGHTS,
    ...Object.fromEntries(kinds.map((entry) => [entry.kind, entry.weight])),
  })
  let state = scheduler
  let queue: WorkItem[] = kinds.map((entry) => item({ id: `${entry.kind}:x`, kind: entry.kind }))
  const picked: Array<WorkItem["kind"]> = []
  for (let i = 0; i < rounds; i += 1) {
    const pick = pickFair(queue, state, 1_000)
    assert.ok(pick)
    picked.push(pick!.kind)
    state = pick!.scheduler
    queue = dequeueById(queue, pick!.item.id)!.rest
    queue = enqueueWork(queue, [item({ id: `${pick!.kind}:x`, kind: pick!.kind, enqueued_ms: i + 1 })])
  }
  return picked
}

test("SWRR: 4:3 service is proportional and never starves", () => {
  const picked = runFairRounds(
    [
      { kind: "mission", weight: 4 },
      { kind: "drain-pass", weight: 3 },
    ],
    14,
  )
  assert.equal(picked.filter((kind) => kind === "mission").length, 8)
  assert.equal(picked.filter((kind) => kind === "drain-pass").length, 6)
  const maxGap = (kind: WorkItem["kind"]): number => {
    let gap = 0
    let current = 0
    for (const entry of picked) {
      if (entry === kind) {
        gap = Math.max(gap, current)
        current = 0
      } else current += 1
    }
    return gap
  }
  assert.ok(maxGap("drain-pass") <= 3, `drain max gap ${maxGap("drain-pass")}`)
  assert.ok(maxGap("mission") <= 2, `mission max gap ${maxGap("mission")}`)
})

test("SWRR: a third kind gets its share without changing the core", () => {
  const picked = runFairRounds(
    [
      { kind: "mission", weight: 4 },
      { kind: "drain-pass", weight: 3 },
      { kind: "staleness", weight: 1 },
    ],
    16,
  )
  assert.equal(picked.filter((kind) => kind === "mission").length, 8)
  assert.equal(picked.filter((kind) => kind === "drain-pass").length, 6)
  assert.equal(picked.filter((kind) => kind === "staleness").length, 2)
})

test("SWRR: weight 0 disables a kind", () => {
  const scheduler = emptyScheduler({ ...DEFAULT_WORK_WEIGHTS, "drain-pass": 0 })
  const queue = [
    item({ id: "mission:a", kind: "mission" }),
    item({ id: "drain-pass", kind: "drain-pass" }),
  ]
  const pick = pickFair(queue, scheduler, 1_000)
  assert.ok(pick)
  assert.equal(pick!.kind, "mission")
})

test("SWRR state persists beside the queue and keeps items on corrupt scheduler", async () => {
  const dir = await mkdtemp(join(tmpdir(), "swrr-"))
  const file = join(dir, "work-queue.json")
  const scheduler = pickFair(
    [item({ id: "mission:a", kind: "mission" }), item({ id: "drain-pass", kind: "drain-pass" })],
    emptyScheduler(),
    1_000,
  )!.scheduler
  await saveWorkQueueState(file, [item({ id: "mission:a" })], scheduler)
  const loaded = await loadWorkQueueState(file)
  assert.equal(loaded.items.length, 1)
  assert.equal(loaded.scheduler.served.mission, 1)

  await writeFile(file, JSON.stringify({ version: 2, items: [item({ id: "mission:b" })], scheduler: "bad" }), "utf8")
  const recovered = await loadWorkQueueState(file)
  assert.equal(recovered.items.length, 1)
  assert.deepEqual(recovered.scheduler.credits, {})
})

test("priority orders items inside a kind: higher first, then FIFO", () => {
  const queue = [
    item({ id: "user-task:low", kind: "user-task", enqueued_ms: 1, priority: 1 }),
    item({ id: "user-task:mid", kind: "user-task", enqueued_ms: 2, priority: 5 }),
    item({ id: "user-task:high", kind: "user-task", enqueued_ms: 3, priority: 9 }),
  ]
  const scheduler = emptyScheduler({ ...DEFAULT_WORK_WEIGHTS, mission: 0 })
  const picked: string[] = []
  let state = scheduler
  let rest = queue
  while (rest.length > 0) {
    const pick = pickFair(rest, state, 1_000)
    assert.ok(pick)
    picked.push(pick!.item.id)
    state = pick!.scheduler
    rest = dequeueById(rest, pick!.item.id)!.rest
  }
  assert.deepEqual(picked, ["user-task:high", "user-task:mid", "user-task:low"])
})

test("a mission still wins over a priority-9 user task (no cross-kind preemption)", () => {
  const pick = pickFair(
    [
      item({ id: "mission:a", kind: "mission", enqueued_ms: 1 }),
      item({ id: "user-task:x", kind: "user-task", enqueued_ms: 0, priority: 9 }),
    ],
    emptyScheduler(),
    1_000,
  )
  assert.ok(pick)
  assert.equal(pick!.kind, "mission", "SWRR is the kind-level decision")
})

test("user-task joins KIND_ORDER, the weights, and the sanitizer", async () => {
  assert.ok(KIND_ORDER.includes("user-task"))
  assert.equal(DEFAULT_WORK_WEIGHTS["user-task"], 2)
  const dir = await mkdtemp(join(tmpdir(), "work-queue-user-task-"))
  const file = join(dir, "work-queue.json")
  await saveWorkQueueState(
    file,
    [
      item({ id: "user-task:a", kind: "user-task", priority: 7 }),
      item({ id: "user-task:b", kind: "user-task", priority: 42 }),
      item({ id: "bogus", kind: "nonsense" as WorkItem["kind"] }),
    ],
    emptyScheduler(),
  )
  const loaded = await loadWorkQueueState(file)
  assert.deepEqual(loaded.items.map((i) => i.id).sort(), ["user-task:a", "user-task:b"])
  assert.equal(loaded.items.find((i) => i.id === "user-task:a")!.priority, 7)
  assert.equal(
    loaded.items.find((i) => i.id === "user-task:b")!.priority,
    undefined,
    "out-of-range priority is dropped",
  )
})
