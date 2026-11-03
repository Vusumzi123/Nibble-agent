import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { openWorkStore } from "./work-store/sqlite.ts"
import { MAX_QUEUE_DEPTH, emptyScheduler, type WorkItem } from "./work-queue.ts"
import { LEASE_TTL_MS } from "./work-store.ts"

const T0 = 1_700_000_000_000

async function stateDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "work-store-"))
}

const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  id: "mission:a",
  kind: "mission",
  producer: "test",
  enqueued_ms: T0,
  requeue_count: 0,
  ...over,
})

async function seeded(
  dir: string,
  items: WorkItem[],
  opts: { failedRetryMs?: number } = {},
) {
  const store = await openWorkStore({ stateDir: dir, now: () => T0, ...opts })
  const lease = store.leaseAcquire("owner-a", T0)!
  const result = store.enqueue(items, T0)
  return { store, lease, result }
}

test("open creates WAL, the four tables, user_version 1, and an ok integrity check", async () => {
  const dir = await stateDir()
  const store = await openWorkStore({ stateDir: dir, now: () => T0 })
  assert.equal(store.integrityCheck(), true)

  const db = new DatabaseSync(join(dir, "work.db"), { readOnly: true })
  try {
    const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }
    assert.equal(mode.journal_mode, "wal")
    const version = db.prepare("PRAGMA user_version").get() as { user_version: number }
    assert.equal(version.user_version, 1)
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
        name: string
      }>
    ).map((row) => row.name)
    assert.deepEqual(names, ["lease", "meta", "scheduler_state", "work_items"])
  } finally {
    db.close()
    store.close()
  }
})

test("enqueue, snapshot, claim, and settle move one item through the store", async () => {
  const dir = await stateDir()
  const { store, result } = await seeded(dir, [
    item({ id: "mission:a", enqueued_ms: 10 }),
    item({ id: "mission:b", enqueued_ms: 20 }),
  ])
  assert.deepEqual(result.accepted, ["mission:a", "mission:b"])
  const snapshot = store.snapshot()
  assert.deepEqual(snapshot.items.map((entry) => entry.id), ["mission:a", "mission:b"])

  const scheduler = {
    ...emptyScheduler(),
    credits: { mission: -4 },
    served: { mission: 1 },
    last_kind: "mission" as const,
    updated_ms: T0,
  }
  const claimed = store.claim("mission:a", scheduler, "owner-a", T0)
  assert.ok(claimed)
  assert.equal(claimed!.state, "running")
  assert.equal(claimed!.attempts, 1)
  assert.equal(claimed!.claimed_by, "owner-a")
  assert.equal(store.snapshot().items.length, 1)
  assert.deepEqual(store.snapshot().scheduler.credits, { mission: -4 })
  assert.deepEqual(store.snapshot().scheduler.served, { mission: 1 })
  assert.equal(store.has("mission:a"), true)

  assert.equal(store.settle("mission:a", "owner-a", null, T0), true)
  assert.equal(store.has("mission:a"), false)
  assert.equal(store.snapshot().items.length, 1)
})

test("scheduler credits and the claim commit together and survive a reopen", async () => {
  const dir = await stateDir()
  const first = await openWorkStore({ stateDir: dir, now: () => T0 })
  first.leaseAcquire("owner-a", T0)
  first.enqueue([item({ id: "mission:a" })], T0)
  const scheduler = {
    ...emptyScheduler(),
    credits: { mission: -4 },
    served: { mission: 1 },
    last_kind: "mission" as const,
    updated_ms: T0,
  }
  assert.ok(first.claim("mission:a", scheduler, "owner-a", T0))
  first.close()

  const second = await openWorkStore({ stateDir: dir, now: () => T0 })
  assert.deepEqual(second.snapshot().scheduler.credits, { mission: -4 })
  assert.equal(second.snapshot().scheduler.served.mission, 1)
  assert.equal(second.snapshot().scheduler.last_kind, "mission")
  second.close()
})

test("a full queue rejects the overflow without writing", async () => {
  const dir = await stateDir()
  const store = await openWorkStore({ stateDir: dir, now: () => T0 })
  const fill = Array.from({ length: MAX_QUEUE_DEPTH }, (_, i) =>
    item({ id: `mission:fill-${i}`, enqueued_ms: i }),
  )
  const first = store.enqueue(fill, T0)
  assert.equal(first.accepted.length, MAX_QUEUE_DEPTH)
  const overflow = store.enqueue([item({ id: "mission:overflow" })], T0)
  assert.deepEqual(overflow.rejected, ["mission:overflow"])
  assert.equal(store.has("mission:overflow"), false)
  store.close()
})

test("duplicate ids are no-ops and outcomes are per id", async () => {
  const dir = await stateDir()
  const { store } = await seeded(dir, [item({ id: "mission:a", enqueued_ms: 10 })])
  const outcome = store.enqueue(
    [
      item({ id: "mission:a", enqueued_ms: 99 }),
      item({ id: "mission:b", enqueued_ms: 20 }),
    ],
    T0,
  )
  assert.deepEqual(outcome.accepted, ["mission:b"])
  assert.deepEqual(outcome.duplicates, ["mission:a"])
  assert.equal(store.snapshot().items.find((entry) => entry.id === "mission:a")!.enqueued_ms, 10)
  store.close()
})

test("expired queued rows are pruned and expired enqueues are rejected", async () => {
  const dir = await stateDir()
  const { store } = await seeded(dir, [
    item({ id: "mission:expired", expires_ms: T0 + 1 }),
    item({ id: "mission:live", expires_ms: T0 + 10_000 }),
  ])
  assert.equal(store.prune(T0 + 2), 1)
  assert.deepEqual(store.snapshot().items.map((entry) => entry.id), ["mission:live"])
  assert.deepEqual(store.enqueue([item({ id: "mission:old", expires_ms: T0 - 1 })], T0).rejected, [
    "mission:old",
  ])
  store.close()
})

test("dropStale removes only the queued ids the tick computed", async () => {
  const dir = await stateDir()
  const { store } = await seeded(dir, [item({ id: "mission:a" }), item({ id: "mission:b" })])
  assert.equal(store.dropStale(["mission:a"]), 1)
  assert.deepEqual(store.snapshot().items.map((entry) => entry.id), ["mission:b"])
  store.close()
})

test("recover resets a crashed running row to queued and caps attempts at three", async () => {
  const dir = await stateDir()
  const { store } = await seeded(dir, [item({ id: "mission:a" })])
  assert.ok(store.claim("mission:a", emptyScheduler(), "owner-a", T0))

  // A new owner steals the expired lease and recovers the dead owner's row.
  const later = T0 + LEASE_TTL_MS
  assert.ok(store.leaseAcquire("owner-b", later))
  assert.deepEqual(store.recover("owner-b", later), { reset: ["mission:a"], failed: [] })
  assert.equal(store.has("mission:a"), true)

  assert.ok(store.claim("mission:a", emptyScheduler(), "owner-b", later))
  const later2 = later + LEASE_TTL_MS
  assert.ok(store.leaseAcquire("owner-c", later2))
  assert.deepEqual(store.recover("owner-c", later2).reset, ["mission:a"])
  assert.ok(store.claim("mission:a", emptyScheduler(), "owner-c", later2))

  const later3 = later2 + LEASE_TTL_MS
  assert.ok(store.leaseAcquire("owner-d", later3))
  assert.deepEqual(store.recover("owner-d", later3), { reset: [], failed: ["mission:a"] })
  assert.equal(store.has("mission:a"), false, "has ignores failed rows")
  store.close()
})

test("a failed id is replaceable only after the cooldown and a newer enqueue time", async () => {
  const dir = await stateDir()
  const { store } = await seeded(dir, [item({ id: "mission:a", enqueued_ms: 10 })], {
    failedRetryMs: 1_000,
  })
  const db = new DatabaseSync(join(dir, "work.db"))
  try {
    db.prepare(
      "UPDATE work_items SET state = 'failed', attempts = 3, failed_ms = ? WHERE id = ?",
    ).run(T0, "mission:a")
  } finally {
    db.close()
  }

  assert.deepEqual(store.enqueue([item({ id: "mission:a", enqueued_ms: 20 })], T0 + 500).duplicates, [
    "mission:a",
  ])
  assert.equal(store.has("mission:a"), false)
  const replaced = store.enqueue([item({ id: "mission:a", enqueued_ms: 20 })], T0 + 1_000)
  assert.deepEqual(replaced.accepted, ["mission:a"])
  assert.equal(store.has("mission:a"), true)
  const row = store.snapshot().items.find((entry) => entry.id === "mission:a")!
  assert.equal(row.enqueued_ms, 20)
  store.close()
})

test("pruneFailed removes only failed rows past the retention window", async () => {
  const dir = await stateDir()
  const { store } = await seeded(dir, [])
  const db = new DatabaseSync(join(dir, "work.db"))
  try {
    const insert = db.prepare(
      `INSERT INTO work_items (id, kind, producer, enqueued_ms, requeue_count, state, failed_ms)
       VALUES (?, 'mission', 'test', ?, 0, 'failed', ?)`,
    )
    insert.run("mission:old", T0, T0 - 40 * 86_400_000)
    insert.run("mission:fresh", T0, T0 - 1_000)
  } finally {
    db.close()
  }
  assert.equal(store.pruneFailed(30 * 86_400_000, T0), 1)
  const remaining = new DatabaseSync(join(dir, "work.db"), { readOnly: true })
  try {
    const rows = remaining.prepare("SELECT id FROM work_items ORDER BY id").all() as Array<{
      id: string
    }>
    assert.deepEqual(rows.map((row) => row.id), ["mission:fresh"])
  } finally {
    remaining.close()
  }
  store.close()
})

test("a crash between claim and settle recovers the row on the next tick", async () => {
  const dir = await stateDir()
  const first = await openWorkStore({ stateDir: dir, now: () => T0 })
  first.leaseAcquire("owner-a", T0)
  first.enqueue([item({ id: "mission:crash" })], T0)
  assert.ok(first.claim("mission:crash", emptyScheduler(), "owner-a", T0))
  first.close()

  const second = await openWorkStore({ stateDir: dir, now: () => T0 + LEASE_TTL_MS })
  assert.ok(second.leaseAcquire("owner-b", T0 + LEASE_TTL_MS))
  assert.deepEqual(second.recover("owner-b", T0 + LEASE_TTL_MS).reset, ["mission:crash"])
  assert.deepEqual(second.snapshot().items.map((row) => row.id), ["mission:crash"])
  second.close()
})

test("two connections enqueue and claim without lost updates", async () => {
  const dir = await stateDir()
  const first = await openWorkStore({ stateDir: dir, now: () => T0 })
  const second = await openWorkStore({ stateDir: dir, now: () => T0 })
  assert.ok(first.leaseAcquire("owner-a", T0))
  assert.deepEqual(first.enqueue([item({ id: "mission:a" })], T0).accepted, ["mission:a"])
  assert.deepEqual(second.enqueue([item({ id: "mission:b" })], T0).accepted, ["mission:b"])
  assert.equal(second.snapshot().items.length, 2)
  assert.ok(first.claim("mission:b", emptyScheduler(), "owner-a", T0))
  assert.equal(second.snapshot().items.length, 1)
  first.close()
  second.close()
})

test("dump emits queued and running rows in the legacy v2 shape", async () => {
  const dir = await stateDir()
  const { store } = await seeded(dir, [item({ id: "mission:a" }), item({ id: "mission:b" })])
  const scheduler = { ...emptyScheduler(), served: { mission: 1 }, updated_ms: T0 }
  assert.ok(store.claim("mission:b", scheduler, "owner-a", T0))
  const dumped = store.dump()
  assert.deepEqual(dumped.items.map((entry) => entry.id), ["mission:a", "mission:b"])
  assert.equal(dumped.scheduler.served.mission, 1)
  const db = new DatabaseSync(join(dir, "work.db"))
  try {
    db.prepare(
      "UPDATE work_items SET state = 'failed', failed_ms = ? WHERE id = ?",
    ).run(T0, "mission:a")
  } finally {
    db.close()
  }
  assert.deepEqual(store.dump().items.map((entry) => entry.id), ["mission:b"])
  store.close()
})
