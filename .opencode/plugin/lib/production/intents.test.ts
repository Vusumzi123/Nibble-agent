import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  INBOX_DIRNAME,
  intentPath,
  mergeIntents,
  planIntentMerge,
  readIntents,
  writeIntent,
  type IntentRecord,
} from "./intents.ts"
import { emptyScheduler, loadWorkQueueState, type WorkItem } from "../work-queue.ts"
import { tempDir } from "../test-utils.ts"

const item = (over: Partial<WorkItem>): WorkItem => ({
  id: "mission:a",
  kind: "mission",
  producer: "tick",
  enqueued_ms: 0,
  requeue_count: 0,
  ...over,
})

const record = (id: string, over: Partial<IntentRecord["intent"]> = {}): IntentRecord => ({
  intent: {
    version: 1,
    id,
    kind: "mission",
    producer: "test",
    enqueued_ms: 10,
    ...over,
  },
  path: `/tmp/${id}.json`,
})

test("writeIntent is atomic, namespaced, and deduped by id", async () => {
  const dir = await tempDir("intents-write-")
  const first = await writeIntent(dir, "chron:missions", {
    id: "mission:research",
    kind: "mission",
    enqueued_ms: 42,
    priority: 5,
  })
  assert.equal(first.ok, true)
  if (!first.ok) return
  assert.equal(first.deduped, false)
  assert.equal(first.path, intentPath(dir, "chron:missions", "mission:research"))

  const again = await writeIntent(dir, "chron:missions", {
    id: "mission:research",
    kind: "mission",
    enqueued_ms: 99,
  })
  assert.equal(again.ok, true)
  if (!again.ok) return
  assert.equal(again.deduped, true)

  const read = await readIntents(dir)
  assert.deepEqual(read.bad, [])
  assert.equal(read.intents.length, 1)
  assert.equal(read.intents[0].intent.enqueued_ms, 42)
  assert.equal(read.intents[0].intent.priority, 5)
})

test("a custom inbox dir is honored by write and read", async () => {
  const dir = await tempDir("intents-custom-inbox-")
  const written = await writeIntent(
    dir,
    "p",
    { id: "mission:a", kind: "mission" },
    { inboxDir: "spool" },
  )
  assert.equal(written.ok, true)
  if (!written.ok) return
  assert.ok(written.path.includes("/spool/"), written.path)
  assert.equal((await readIntents(dir, "spool")).intents.length, 1)
  assert.equal((await readIntents(dir)).intents.length, 0)
})

test("readIntents quarantines invalid JSON and invalid schemas", async () => {
  const dir = await tempDir("intents-bad-")
  const producerDir = join(dir, INBOX_DIRNAME, "p")
  await mkdir(producerDir, { recursive: true })
  await writeFile(join(producerDir, "bad-json.json"), "{nope", "utf8")
  await writeFile(
    join(producerDir, "bad-version.json"),
    JSON.stringify({ version: 2, id: "x", kind: "mission", producer: "p", enqueued_ms: 1 }),
    "utf8",
  )
  const good = await writeIntent(dir, "p", { id: "mission:ok", kind: "mission" })
  assert.equal(good.ok, true)

  const read = await readIntents(dir)
  assert.equal(read.intents.length, 1)
  assert.equal(read.intents[0].intent.id, "mission:ok")
  assert.equal(read.bad.length, 2)
  const badDir = join(dir, INBOX_DIRNAME, "bad")
  assert.equal((await readdir(badDir)).length, 2)
  assert.deepEqual(
    (await readdir(producerDir)).filter((name) => name.endsWith(".json")),
    [good.ok ? good.path.split("/").pop()! : ""],
  )
})

test("planIntentMerge dedupes by id and reports duplicates", () => {
  const plan = planIntentMerge(
    [item({ id: "mission:a" })],
    [record("mission:a"), record("mission:b")],
    100,
  )
  assert.deepEqual(plan.accepted.map((r) => r.intent.id), ["mission:b"])
  assert.deepEqual(plan.duplicates.map((r) => r.intent.id), ["mission:a"])
  assert.deepEqual(plan.queue.map((i) => i.id).sort(), ["mission:a", "mission:b"])
})

test("planIntentMerge accepts only free capacity and never evicts", () => {
  const queue = Array.from({ length: 48 }, (_, i) =>
    item({ id: `mission:existing-${i}`, enqueued_ms: i }),
  )
  const records = Array.from({ length: 5 }, (_, i) =>
    record(`mission:new-${i}`, { priority: 9 - i, enqueued_ms: 100 + i }),
  )
  const plan = planIntentMerge(queue, records, 1_000)
  assert.equal(plan.accepted.length, 2)
  assert.equal(plan.rejected.length, 3)
  assert.equal(plan.queue.length, 50)
  assert.deepEqual(
    plan.queue.filter((i) => i.id.startsWith("mission:existing-")).length,
    48,
  )
  assert.deepEqual(plan.accepted.map((r) => r.intent.id), ["mission:new-0", "mission:new-1"])
})

test("expired intents are dropped and deleted", async () => {
  const dir = await tempDir("intents-expired-")
  const file = join(dir, "queue.json")
  const written = await writeIntent(dir, "p", {
    id: "mission:old",
    kind: "mission",
    expires_ms: 50,
  })
  assert.equal(written.ok, true)
  const report = await mergeIntents({
    stateDir: dir,
    queueFile: file,
    queue: [],
    scheduler: emptyScheduler(),
    nowMs: 100,
  })
  assert.equal(report.saved, true)
  assert.equal(report.expired.length, 1)
  assert.equal(report.queue.length, 0)
  const loaded = await loadWorkQueueState(file)
  assert.equal(loaded.items.length, 0)
})

test("mergeIntents deletes accepted files only after a successful save", async () => {
  const dir = await tempDir("intents-merge-")
  const file = join(dir, "queue.json")
  const paths: string[] = []
  for (const id of ["mission:a", "mission:b"]) {
    const written = await writeIntent(dir, "p", { id, kind: "mission" })
    assert.equal(written.ok, true)
    if (written.ok) paths.push(written.path)
  }

  const report = await mergeIntents({
    stateDir: dir,
    queueFile: file,
    queue: [],
    scheduler: emptyScheduler(),
    nowMs: 100,
  })
  assert.equal(report.saved, true)
  assert.equal(report.deleted.length, 2)
  for (const path of paths) await assert.rejects(readFile(path, "utf8"))
  const loaded = await loadWorkQueueState(file)
  assert.deepEqual(loaded.items.map((i) => i.id).sort(), ["mission:a", "mission:b"])
})

test("mergeIntents leaves accepted files when the save fails", async () => {
  const dir = await tempDir("intents-save-fail-")
  const written = await writeIntent(dir, "p", { id: "mission:a", kind: "mission" })
  assert.equal(written.ok, true)
  if (!written.ok) return

  const report = await mergeIntents({
    stateDir: dir,
    queueFile: join(dir, "queue.json"),
    queue: [],
    scheduler: emptyScheduler(),
    nowMs: 100,
    save: async () => false,
  })
  assert.equal(report.saved, false)
  assert.equal(report.accepted.length, 1)
  assert.deepEqual(report.deleted, [])
  assert.equal(await readFile(written.path, "utf8").then(() => true), true)
})

test("48 existing + 5 intents keeps the queue at 50 and retries the overflow", async () => {
  const dir = await tempDir("intents-capacity-")
  const file = join(dir, "queue.json")
  const queue = Array.from({ length: 48 }, (_, i) =>
    item({ id: `mission:existing-${i}`, enqueued_ms: i }),
  )
  for (let i = 0; i < 5; i++) {
    const written = await writeIntent(dir, "p", { id: `mission:new-${i}`, kind: "mission" })
    assert.equal(written.ok, true)
  }
  const report = await mergeIntents({
    stateDir: dir,
    queueFile: file,
    queue,
    scheduler: emptyScheduler(),
    nowMs: 1_000,
  })
  assert.equal(report.accepted.length, 2)
  assert.equal(report.rejected.length, 3)
  assert.equal(report.queue.length, 50)
  assert.equal(report.deleted.length, 2)
  const read = await readIntents(dir)
  assert.equal(read.intents.length, 3)
})
