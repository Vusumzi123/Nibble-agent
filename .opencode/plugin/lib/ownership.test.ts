import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  OWNERSHIP_FILE,
  OWNERSHIP_TTL_MS,
  acquireOwnership,
  ownershipFile,
  type OwnershipRecord,
} from "./ownership.ts"

const T0 = 1_700_000_000_000
/** A PID that cannot be running (above the common Linux pid_max). */
const DEAD_PID = 4_194_303

async function dir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ownership-"))
}

function live(over: Partial<OwnershipRecord> = {}): OwnershipRecord {
  return {
    pid: process.pid,
    acquired_ms: T0,
    heartbeat_ms: T0,
    ...over,
  }
}

test("ownershipFile names the short lease under the state root", () => {
  assert.equal(ownershipFile("/x/state"), join("/x/state", OWNERSHIP_FILE))
})

test("acquire creates the lease, a second live holder is refused, release frees it", async () => {
  const file = ownershipFile(await dir())
  const first = await acquireOwnership(file, { nowMs: T0 })
  assert.ok(first)
  assert.equal(first.record.pid, process.pid)
  assert.equal(first.held(), true)

  assert.equal(await acquireOwnership(file, { nowMs: T0 + 1_000 }), null)
  const held = JSON.parse(await readFile(file, "utf8")) as OwnershipRecord
  assert.equal(held.pid, process.pid)

  await first.release()
  assert.equal(first.held(), false)
  await assert.rejects(readFile(file, "utf8"))
  assert.ok(await acquireOwnership(file, { nowMs: T0 + 2_000 }))
})

test("a lease with a dead holder is stolen immediately", async () => {
  const root = await dir()
  const file = ownershipFile(root)
  await writeFile(
    file,
    JSON.stringify({ pid: DEAD_PID, acquired_ms: T0, heartbeat_ms: T0 }),
    "utf8",
  )
  const handle = await acquireOwnership(file, { nowMs: T0 + 1_000 })
  assert.ok(handle, "a dead PID must be stealable even with a fresh heartbeat")
  const next = JSON.parse(await readFile(file, "utf8")) as OwnershipRecord
  assert.equal(next.pid, process.pid)
  await handle.release()
})

test("a live but unrenewed lease is stolen once the TTL expires", async () => {
  const root = await dir()
  const file = ownershipFile(root)
  await writeFile(file, JSON.stringify(live()), "utf8")

  assert.equal(
    await acquireOwnership(file, { nowMs: T0 + OWNERSHIP_TTL_MS - 1 }),
    null,
    "a live holder inside the TTL is never stolen from",
  )
  const handle = await acquireOwnership(file, { nowMs: T0 + OWNERSHIP_TTL_MS })
  assert.ok(handle, "a hung live holder must not stall the project past the TTL")
  await handle.release()
})

test("a live, fresh lease is not stolen", async () => {
  const root = await dir()
  const file = ownershipFile(root)
  await writeFile(file, JSON.stringify(live({ heartbeat_ms: T0 + 60_000 })), "utf8")
  assert.equal(await acquireOwnership(file, { nowMs: T0 + 61_000 }), null)
})

test("refresh re-stamps the heartbeat and reports a lost lease", async () => {
  const root = await dir()
  const file = ownershipFile(root)
  const handle = await acquireOwnership(file, { nowMs: T0 })
  assert.ok(handle)
  assert.equal(await handle.refresh(), true)
  const after = JSON.parse(await readFile(file, "utf8")) as OwnershipRecord
  assert.ok(after.heartbeat_ms > T0)

  // Someone stole the file: refresh must notice and stop claiming ownership.
  await writeFile(file, JSON.stringify(live({ acquired_ms: T0 + 5_000 })), "utf8")
  assert.equal(await handle.refresh(), false)
  assert.equal(handle.held(), false)
  await handle.release()
  assert.equal(JSON.parse(await readFile(file, "utf8")).acquired_ms, T0 + 5_000)
})

test("release never deletes a lease that was stolen", async () => {
  const root = await dir()
  const file = ownershipFile(root)
  const handle = await acquireOwnership(file, { nowMs: T0 })
  assert.ok(handle)

  const foreign = JSON.stringify(live({ acquired_ms: T0 + 9_000 }))
  await writeFile(file, foreign, "utf8")
  await handle.release()
  assert.equal(await readFile(file, "utf8"), foreign)
})

test("a malformed lease is stolen", async () => {
  const root = await dir()
  const file = ownershipFile(root)
  await writeFile(file, "not json", "utf8")
  const handle = await acquireOwnership(file, { nowMs: T0 })
  assert.ok(handle)
  await handle.release()
})
