import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { openWorkStore } from "./sqlite.ts"

const T0 = 1_700_000_000_000

async function legacyDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "work-migrate-"))
  const stateDir = join(dir, ".opencode", "state")
  await mkdir(join(stateDir, "inbox", "chron:missions"), { recursive: true })
  await writeFile(
    join(stateDir, "work-queue.json"),
    JSON.stringify({
      version: 2,
      items: [
        {
          id: "mission:queued",
          kind: "mission",
          producer: "chron:missions",
          enqueued_ms: T0 - 5_000,
          requeue_count: 0,
        },
      ],
      scheduler: {
        fair: true,
        weights: { mission: 4, "drain-pass": 3 },
        credits: { mission: 2 },
        served: { mission: 7 },
        last_kind: "mission",
        updated_ms: T0 - 1_000,
      },
    }),
    "utf8",
  )
  const intent = (over: Record<string, unknown>) =>
    JSON.stringify({ version: 1, producer: "chron:missions", enqueued_ms: T0, ...over })
  await writeFile(
    join(stateDir, "inbox", "chron:missions", "mission-new.json"),
    intent({ id: "mission:new", kind: "mission", priority: 5 }),
    "utf8",
  )
  await writeFile(
    join(stateDir, "inbox", "chron:missions", "mission-old.json"),
    intent({ id: "mission:old", kind: "mission", expires_ms: T0 - 1 }),
    "utf8",
  )
  return stateDir
}

test("first open imports the v2 queue and inbox once, then backs them up", async () => {
  const stateDir = await legacyDir()
  const store = await openWorkStore({ stateDir, now: () => T0 })
  const items = store.snapshot().items
  assert.deepEqual(items.map((entry) => entry.id).sort(), ["mission:new", "mission:queued"])
  assert.equal(store.snapshot().scheduler.served.mission, 7)
  assert.deepEqual(store.snapshot().scheduler.credits, { mission: 2 })
  store.close()

  const backups = await readdir(join(stateDir, "backup"))
  assert.equal(backups.length, 1)
  const backupDir = join(stateDir, "backup", backups[0])
  const copied = JSON.parse(await readFile(join(backupDir, "work-queue.json"), "utf8"))
  assert.equal(copied.items.length, 1)
  const inboxBackup = join(backupDir, "inbox", "chron:missions")
  assert.equal((await readdir(inboxBackup)).length, 2)

  const again = await openWorkStore({ stateDir, now: () => T0 + 1_000 })
  assert.deepEqual(again.snapshot().items.map((entry) => entry.id).sort(), [
    "mission:new",
    "mission:queued",
  ])
  again.close()
  assert.equal((await readdir(join(stateDir, "backup"))).length, 1, "no second import")
})

test("a second concurrent first open sees the marker and imports nothing twice", async () => {
  const stateDir = await legacyDir()
  const [first, second] = await Promise.all([
    openWorkStore({ stateDir, now: () => T0 }),
    openWorkStore({ stateDir, now: () => T0 }),
  ])
  assert.equal(first.snapshot().items.length, 2)
  assert.equal(second.snapshot().items.length, 2)
  first.close()
  second.close()
  assert.equal((await readdir(join(stateDir, "backup"))).length, 1)
})

test("dump -> restore round-trips ids and scheduler state", async () => {
  const stateDir = await legacyDir()
  const store = await openWorkStore({ stateDir, now: () => T0 })
  const dumped = store.dump()
  store.close()

  const target = await mkdtemp(join(tmpdir(), "work-restore-"))
  const targetState = join(target, ".opencode", "state")
  await mkdir(targetState, { recursive: true })
  await writeFile(
    join(targetState, "work-queue.json"),
    JSON.stringify({ version: 2, ...dumped }),
    "utf8",
  )
  const restored = await openWorkStore({ stateDir: targetState, now: () => T0 + 1_000 })
  assert.deepEqual(restored.snapshot().items.map((entry) => entry.id).sort(), [
    "mission:new",
    "mission:queued",
  ])
  assert.equal(restored.snapshot().scheduler.served.mission, 7)
  restored.close()
})

test("a corrupt legacy queue imports as empty and still sets the marker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "work-migrate-bad-"))
  const stateDir = join(dir, ".opencode", "state")
  await mkdir(stateDir, { recursive: true })
  await writeFile(join(stateDir, "work-queue.json"), "{not json", "utf8")
  const store = await openWorkStore({ stateDir, now: () => T0 })
  assert.equal(store.snapshot().items.length, 0)
  store.close()
  await writeFile(join(stateDir, "work-queue.json"), JSON.stringify({ version: 2, items: [{ id: "mission:late", kind: "mission", producer: "x", enqueued_ms: 1, requeue_count: 0 }] }), "utf8")
  const again = await openWorkStore({ stateDir, now: () => T0 })
  assert.equal(again.snapshot().items.length, 0, "the marker prevents a later import")
  again.close()
})
