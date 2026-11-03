import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import * as intents from "./intents.ts"
import { intentPath, readIntents, toWorkItem } from "./intents.ts"
import { tempDir } from "../test-utils.ts"

const intentJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: 1,
    id: "mission:a",
    kind: "mission",
    producer: "test",
    enqueued_ms: 10,
    ...over,
  })

async function writeIntentFile(
  dir: string,
  producer: string,
  name: string,
  body: string,
  inboxDir = "inbox",
): Promise<string> {
  const producerDir = join(dir, inboxDir, producer)
  await mkdir(producerDir, { recursive: true })
  const path = join(producerDir, name)
  await writeFile(path, body, "utf8")
  return path
}

test("the write path is retired; only the importer reader remains", () => {
  assert.equal("writeIntent" in intents, false)
  assert.equal("mergeIntents" in intents, false)
  assert.equal("planIntentMerge" in intents, false)
})

test("readIntents reads namespaced files and honors a custom inbox dir", async () => {
  const dir = await tempDir("intents-read-")
  await writeIntentFile(dir, "chron:missions", "a.json", intentJson({ priority: 5 }))
  await writeIntentFile(dir, "chron:drain", "drain.json", intentJson({ id: "drain-pass", kind: "drain-pass" }))

  const read = await readIntents(dir)
  assert.deepEqual(read.bad, [])
  assert.deepEqual(read.intents.map((record) => record.intent.id).sort(), [
    "drain-pass",
    "mission:a",
  ])
  assert.equal(read.intents.find((record) => record.intent.id === "mission:a")!.intent.priority, 5)

  assert.equal((await readIntents(dir, "spool")).intents.length, 0)
  await writeIntentFile(dir, "p", "b.json", intentJson(), "spool")
  assert.equal((await readIntents(dir, "spool")).intents.length, 1)
})

test("readIntents quarantines invalid JSON and invalid schemas", async () => {
  const dir = await tempDir("intents-bad-")
  const producerDir = join(dir, "inbox", "p")
  await mkdir(producerDir, { recursive: true })
  await writeFile(join(producerDir, "bad-json.json"), "{nope", "utf8")
  await writeFile(
    join(producerDir, "bad-version.json"),
    JSON.stringify({ version: 2, id: "x", kind: "mission", producer: "p", enqueued_ms: 1 }),
    "utf8",
  )
  await writeIntentFile(dir, "p", "good.json", intentJson({ producer: "p" }))

  const read = await readIntents(dir)
  assert.equal(read.intents.length, 1)
  assert.equal(read.intents[0].intent.id, "mission:a")
  assert.equal(read.bad.length, 2)
  assert.equal((await readdir(join(dir, "inbox", "bad"))).length, 2)
  const remaining = (await readdir(producerDir)).filter((name) => name.endsWith(".json"))
  assert.deepEqual(remaining, ["good.json"])
})

test("intentPath stays stable for the importer and its tests", () => {
  const path = intentPath("/state", "chron:missions", "mission:a")
  assert.ok(path.startsWith(join("/state", "inbox", "chron-missions")))
  assert.ok(path.endsWith(".json"))
  assert.equal(path, intentPath("/state", "chron:missions", "mission:a"))
})

test("toWorkItem maps the file shape onto a queue item", () => {
  const item = toWorkItem({
    version: 1,
    id: "mission:a",
    kind: "mission",
    producer: "chron:missions",
    enqueued_ms: 42,
    priority: 5,
    expires_ms: 99,
    payload: { mission: "a" },
  })
  assert.deepEqual(item, {
    id: "mission:a",
    kind: "mission",
    producer: "chron:missions",
    enqueued_ms: 42,
    requeue_count: 0,
    priority: 5,
    expires_ms: 99,
    payload: { mission: "a" },
  })
})
