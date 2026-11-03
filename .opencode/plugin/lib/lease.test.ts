import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { acquireLease, newOwnerToken } from "./lease.ts"
import { openWorkStore } from "./work-store/sqlite.ts"
import { LEASE_TTL_MS, type WorkStore } from "./work-store.ts"
import { emptyScheduler } from "./work-queue.ts"

const T0 = 1_700_000_000_000
const DEAD_PID = 4_194_303

async function store(): Promise<{ dir: string; work: WorkStore }> {
  const dir = await mkdtemp(join(tmpdir(), "lease-"))
  return { dir, work: await openWorkStore({ stateDir: dir, now: () => T0 }) }
}

test("newOwnerToken carries the pid and a random suffix", () => {
  const first = newOwnerToken()
  const second = newOwnerToken()
  assert.match(first, new RegExp(`^${process.pid}:`))
  assert.notEqual(first, second)
})

test("acquire creates the row, a live holder is refused, release frees it", async () => {
  const { work } = await store()
  const first = acquireLease(work, { nowMs: T0 })
  assert.ok(first)
  assert.equal(first!.held(), true)
  assert.equal(work.leaseHolder()!.owner, first!.owner)

  assert.equal(acquireLease(work, { nowMs: T0 + 1_000 }), null)

  first!.release()
  assert.equal(first!.held(), false)
  assert.equal(work.leaseHolder(), null)
  assert.ok(acquireLease(work, { nowMs: T0 + 2_000 }))
  work.close()
})

test("a lease with a dead holder is stolen immediately", async () => {
  const { work } = await store()
  work.leaseAcquire("dead:0:x", T0)
  const db = work.leaseHolder()!
  assert.equal(db.owner, "dead:0:x")

  // Rewrite the row with a dead PID, keeping a fresh heartbeat.
  const raw = new (await import("node:sqlite")).DatabaseSync(work.file)
  try {
    raw.prepare("UPDATE lease SET pid = ?, pid_start = NULL, heartbeat_ms = ? WHERE id = 1").run(
      DEAD_PID,
      T0,
    )
  } finally {
    raw.close()
  }
  const next = acquireLease(work, { nowMs: T0 + 1_000 })
  assert.ok(next, "a dead PID must be stealable even with a fresh heartbeat")
  work.close()
})

test("a live but unrenewed lease is stolen once the TTL expires", async () => {
  const { work } = await store()
  const first = acquireLease(work, { nowMs: T0 })
  assert.ok(first)
  assert.equal(
    acquireLease(work, { nowMs: T0 + LEASE_TTL_MS - 1 }),
    null,
    "a live holder inside the TTL is never stolen from",
  )
  const stolen = acquireLease(work, { nowMs: T0 + LEASE_TTL_MS })
  assert.ok(stolen)
  assert.notEqual(stolen!.owner, first!.owner)
  first!.release()
  assert.equal(work.leaseHolder()!.owner, stolen!.owner, "release never deletes a stolen lease")
  work.close()
})

test("refresh re-stamps the heartbeat and reports a lost lease", async () => {
  const { work } = await store()
  const handle = acquireLease(work, { nowMs: T0 })
  assert.ok(handle)
  assert.equal(handle!.refresh(T0 + 10_000), true)
  assert.equal(work.leaseHolder()!.heartbeat_ms, T0 + 10_000)

  work.leaseRelease(handle!.owner)
  assert.equal(handle!.refresh(T0 + 20_000), false)
  assert.equal(handle!.held(), false)
  work.close()
})

test("a stale owner cannot claim or settle after a steal", async () => {
  const { work } = await store()
  const stale = acquireLease(work, { nowMs: T0 })!
  assert.ok(
    work.enqueue(
      [{ id: "mission:a", kind: "mission", producer: "test", enqueued_ms: T0, requeue_count: 0 }],
      T0,
    ).accepted.length,
  )

  const next = acquireLease(work, { nowMs: T0 + LEASE_TTL_MS })!
  assert.notEqual(next.owner, stale.owner)
  assert.throws(
    () => work.claim("mission:a", emptyScheduler(), stale.owner, T0 + LEASE_TTL_MS),
    /lease is not held/,
  )
  assert.ok(work.claim("mission:a", emptyScheduler(), next.owner, T0 + LEASE_TTL_MS))
  assert.equal(
    work.settle("mission:a", stale.owner, null, T0 + LEASE_TTL_MS),
    false,
    "a stale-owner settle returns zero rows",
  )
  assert.equal(work.settle("mission:a", next.owner, null, T0 + LEASE_TTL_MS), true)
  work.close()
})

test("a new owner's row survives a stale owner settle", async () => {
  const { work } = await store()
  const stale = acquireLease(work, { nowMs: T0 })!
  work.enqueue(
    [{ id: "mission:a", kind: "mission", producer: "test", enqueued_ms: T0, requeue_count: 0 }],
    T0,
  )
  const next = acquireLease(work, { nowMs: T0 + LEASE_TTL_MS })!
  assert.ok(work.claim("mission:a", emptyScheduler(), next.owner, T0 + LEASE_TTL_MS))
  assert.equal(work.settle("mission:a", stale.owner, null, T0 + LEASE_TTL_MS), false)
  assert.equal(work.has("mission:a"), true, "the new owner's running row is intact")
  work.close()
})
