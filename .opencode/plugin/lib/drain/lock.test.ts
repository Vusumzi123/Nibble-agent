import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  acquireDrainLock,
  drainLockFile,
  isDrainLockStale,
  lockOptsFromConfig,
  type DrainLockRecord,
} from "./lock.ts"
import { DEFAULT_DRAIN } from "./config.ts"

async function tmpLock(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "drain-lock-"))
  return drainLockFile(dir)
}

test("exclusive create: second acquire fails while the first holds", async () => {
  const file = await tmpLock()
  const first = await acquireDrainLock(file, { refreshMs: 1_000, staleMs: 3_000 })
  assert.ok(first)

  const second = await acquireDrainLock(file, { refreshMs: 1_000, staleMs: 3_000 })
  assert.equal(second, null, "a fresh lock is held by someone else")

  await first!.release()
  const third = await acquireDrainLock(file, { refreshMs: 1_000, staleMs: 3_000 })
  assert.ok(third, "release frees the lock")
  await third!.release()

  // release is idempotent
  await third!.release()
  const fourth = await acquireDrainLock(file, { refreshMs: 1_000, staleMs: 3_000 })
  assert.ok(fourth)
  await fourth!.release()
})

test("a stale lock held by a dead process is stolen", async () => {
  const file = await tmpLock()
  const record: DrainLockRecord = {
    pid: 999_999, // almost certainly not running
    acquired_ms: Date.now() - 60_000,
    heartbeat_ms: Date.now() - 60_000,
  }
  await writeFile(file, JSON.stringify(record), "utf8")

  const stolen = await acquireDrainLock(file, { refreshMs: 1_000, staleMs: 3_000 })
  assert.ok(stolen, "a dead holder's stale lock is stolen")
  assert.equal(stolen!.record.pid, process.pid)
  await stolen!.release()
})

test("a stale lock held by a LIVE process is never stolen (§2.4)", async () => {
  const file = await tmpLock()
  const record: DrainLockRecord = {
    pid: process.pid, // alive — us
    acquired_ms: Date.now() - 60_000,
    heartbeat_ms: Date.now() - 60_000,
  }
  await writeFile(file, JSON.stringify(record), "utf8")

  const attempt = await acquireDrainLock(file, { refreshMs: 1_000, staleMs: 3_000 })
  assert.equal(attempt, null, "a hung-but-alive holder is never stolen from")
})

test("a malformed lock record is treated as stale and stealable", async () => {
  const file = await tmpLock()
  await writeFile(file, "not json", "utf8")
  const stolen = await acquireDrainLock(file, { refreshMs: 1_000, staleMs: 3_000 })
  assert.ok(stolen)
  await stolen!.release()
})

test("the heartbeat refresh rewrites heartbeat_ms while held", async () => {
  const file = await tmpLock()
  const handle = await acquireDrainLock(file, { refreshMs: 1_000, staleMs: 3_000 })
  assert.ok(handle)
  const before = JSON.parse(await readFile(file, "utf8")) as DrainLockRecord
  assert.equal(before.heartbeat_ms, before.acquired_ms)

  await new Promise((resolve) => setTimeout(resolve, 1_300))
  const after = JSON.parse(await readFile(file, "utf8")) as DrainLockRecord
  assert.ok(after.heartbeat_ms > before.heartbeat_ms, "heartbeat_ms advanced")
  assert.equal(after.pid, process.pid)
  assert.equal(after.acquired_ms, before.acquired_ms, "acquired_ms is stable")
  await handle!.release()
})

test("release does NOT remove a lock stolen by another holder", async () => {
  const file = await tmpLock()
  const mine = await acquireDrainLock(file, { refreshMs: 1_000, staleMs: 3_000 })
  assert.ok(mine)
  // Simulate a steal: replace the record with someone else's.
  await writeFile(
    file,
    JSON.stringify({ pid: 999_999, acquired_ms: Date.now(), heartbeat_ms: Date.now() }),
    "utf8",
  )
  await mine!.release()
  const current = JSON.parse(await readFile(file, "utf8")) as DrainLockRecord
  assert.equal(current.pid, 999_999, "the thief's record survives the old holder's release")
})

test("isDrainLockStale: null/malformed/old-heartbeat are stale", () => {
  const now = 10_000
  assert.equal(isDrainLockStale(null, now, 3_000), true)
  assert.equal(
    isDrainLockStale({ pid: 1, acquired_ms: now, heartbeat_ms: Number.NaN }, now, 3_000),
    true,
  )
  assert.equal(
    isDrainLockStale({ pid: 1, acquired_ms: 0, heartbeat_ms: now - 3_001 }, now, 3_000),
    true,
  )
  assert.equal(
    isDrainLockStale({ pid: 1, acquired_ms: 0, heartbeat_ms: now - 2_999 }, now, 3_000),
    false,
  )
})

test("lockOptsFromConfig passes refresh and stale through", () => {
  const opts = lockOptsFromConfig(DEFAULT_DRAIN)
  assert.equal(opts.refreshMs, DEFAULT_DRAIN.lock_refresh_ms)
  assert.equal(opts.staleMs, DEFAULT_DRAIN.lock_stale_ms)
})
