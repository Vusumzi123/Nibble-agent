import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  acquireFileLock,
  isFileLockStale,
  type FileLockRecord,
} from "./file-lock.ts"

async function tmpLock(name = "generic.lock"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "file-lock-"))
  return join(dir, name)
}

test("exclusive create: second acquire fails while the first holds", async () => {
  const file = await tmpLock()
  const first = await acquireFileLock(file, { refreshMs: 1_000, staleMs: 3_000 })
  assert.ok(first)

  const second = await acquireFileLock(file, { refreshMs: 1_000, staleMs: 3_000 })
  assert.equal(second, null, "a fresh lock is held by someone else")

  await first!.release()
  const third = await acquireFileLock(file, { refreshMs: 1_000, staleMs: 3_000 })
  assert.ok(third, "release frees the lock")
  await third!.release()

  // release is idempotent
  await third!.release()
  const fourth = await acquireFileLock(file, { refreshMs: 1_000, staleMs: 3_000 })
  assert.ok(fourth)
  await fourth!.release()
})

test("acquireFileLock works on an arbitrary path (state/mission.lock)", async () => {
  const file = await tmpLock(join("state", "mission.lock"))
  const handle = await acquireFileLock(file, { refreshMs: 1_000, staleMs: 3_000 })
  assert.ok(handle, "nested lock directories are created")
  assert.equal(handle!.file, file)
  const record = JSON.parse(await readFile(file, "utf8")) as FileLockRecord
  assert.equal(record.pid, process.pid)
  assert.equal(record.acquired_ms, record.heartbeat_ms)
  await handle!.release()
})

test("a stale lock held by a dead process is stolen", async () => {
  const file = await tmpLock()
  const record: FileLockRecord = {
    pid: 999_999, // almost certainly not running
    acquired_ms: Date.now() - 60_000,
    heartbeat_ms: Date.now() - 60_000,
  }
  await writeFile(file, JSON.stringify(record), "utf8")

  const stolen = await acquireFileLock(file, { refreshMs: 1_000, staleMs: 3_000 })
  assert.ok(stolen, "a dead holder's stale lock is stolen")
  assert.equal(stolen!.record.pid, process.pid)
  await stolen!.release()
})

test("a stale lock held by a LIVE process is never stolen (§2.4)", async () => {
  const file = await tmpLock()
  const record: FileLockRecord = {
    pid: process.pid, // alive — us
    acquired_ms: Date.now() - 60_000,
    heartbeat_ms: Date.now() - 60_000,
  }
  await writeFile(file, JSON.stringify(record), "utf8")

  const attempt = await acquireFileLock(file, { refreshMs: 1_000, staleMs: 3_000 })
  assert.equal(attempt, null, "a hung-but-alive holder is never stolen from")
})

test("a malformed lock record is treated as stale and stealable", async () => {
  const file = await tmpLock()
  await writeFile(file, "not json", "utf8")
  const stolen = await acquireFileLock(file, { refreshMs: 1_000, staleMs: 3_000 })
  assert.ok(stolen)
  await stolen!.release()
})

test("the heartbeat refresh rewrites heartbeat_ms while held", async () => {
  const file = await tmpLock()
  const handle = await acquireFileLock(file, { refreshMs: 1_000, staleMs: 3_000 })
  assert.ok(handle)
  const before = JSON.parse(await readFile(file, "utf8")) as FileLockRecord
  assert.equal(before.heartbeat_ms, before.acquired_ms)

  await new Promise((resolve) => setTimeout(resolve, 1_300))
  const after = JSON.parse(await readFile(file, "utf8")) as FileLockRecord
  assert.ok(after.heartbeat_ms > before.heartbeat_ms, "heartbeat_ms advanced")
  assert.equal(after.pid, process.pid)
  assert.equal(after.acquired_ms, before.acquired_ms, "acquired_ms is stable")
  await handle!.release()
})

test("release does NOT remove a lock stolen by another holder", async () => {
  const file = await tmpLock()
  const mine = await acquireFileLock(file, { refreshMs: 1_000, staleMs: 3_000 })
  assert.ok(mine)
  // Simulate a steal: replace the record with someone else's.
  await writeFile(
    file,
    JSON.stringify({ pid: 999_999, acquired_ms: Date.now(), heartbeat_ms: Date.now() }),
    "utf8",
  )
  await mine!.release()
  const current = JSON.parse(await readFile(file, "utf8")) as FileLockRecord
  assert.equal(current.pid, 999_999, "the thief's record survives the old holder's release")
})

test("isFileLockStale: null/malformed/old-heartbeat are stale", () => {
  const now = 10_000
  assert.equal(isFileLockStale(null, now, 3_000), true)
  assert.equal(
    isFileLockStale({ pid: 1, acquired_ms: now, heartbeat_ms: Number.NaN }, now, 3_000),
    true,
  )
  assert.equal(
    isFileLockStale({ pid: 1, acquired_ms: 0, heartbeat_ms: now - 3_001 }, now, 3_000),
    true,
  )
  assert.equal(
    isFileLockStale({ pid: 1, acquired_ms: 0, heartbeat_ms: now - 2_999 }, now, 3_000),
    false,
  )
})
