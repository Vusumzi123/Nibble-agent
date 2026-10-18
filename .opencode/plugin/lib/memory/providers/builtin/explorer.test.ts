import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { DEFAULT_DRAIN } from "../../../drain/config.ts"
import { createExplorerProvider } from "./explorer.ts"

async function workspace(): Promise<{ directory: string; stateDir: string; vaultDir: string; dbFile: string }> {
  const root = await mkdtemp(join(tmpdir(), "memory-explorer-"))
  const stateDir = join(root, "state")
  const vaultDir = join(root, "vault")
  await mkdir(stateDir, { recursive: true })
  await mkdir(vaultDir, { recursive: true })
  const dbFile = join(root, "opencode.db")
  const db = new DatabaseSync(dbFile)
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, time_updated INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '');
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, data TEXT NOT NULL);
  `)
  db.prepare("INSERT INTO session (id, parent_id, directory, time_updated) VALUES (?, ?, ?, ?)").run(
    "top-1",
    null,
    root,
    2000,
  )
  const turn = (id: string, time: number, text: string) => {
    db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
      id,
      "top-1",
      time,
      JSON.stringify({ role: "user" }),
    )
    db.prepare("INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)").run(
      `${id}-p`,
      id,
      JSON.stringify({ type: "text", text }),
    )
  }
  turn("m1", 1000, "old note about wireguard")
  turn("m2", 2000, "fresh note about backups")
  db.close()
  return { directory: root, stateDir, vaultDir, dbFile }
}

function provider(ws: { directory: string; stateDir: string; vaultDir: string; dbFile: string }) {
  return createExplorerProvider({ ...ws, drain: DEFAULT_DRAIN })
}

test("readPlan is the recency lane only", () => {
  const p = provider({ directory: "/p", stateDir: "/s", vaultDir: "/v", dbFile: "/db" })
  const plan = p.readPlan()!
  assert.match(plan, /memory-explorer/)
  assert.match(plan, /un-consolidated turns/)
  assert.match(plan, /\[brain-first: RETRIEVE\]/)
  assert.equal(plan.includes("rag-search"), false)
})

test("search returns un-consolidated evidence", async () => {
  const ws = await workspace()
  const hits = await provider(ws).search!({ query: "wireguard", topK: 5 })
  assert.equal(hits.length, 1)
  assert.match(hits[0].excerpt, /wireguard/)
})

test("seed is the most recent un-consolidated turn", async () => {
  const seed = await provider(await workspace()).seed!()
  assert.match(seed ?? "", /^recent turn: fresh note about backups/)
})

test("pending counts turns after the cursor", async () => {
  assert.equal(await provider(await workspace()).pending!(), 2)
})

test("tools exposes memory_search through the supplied factory", async () => {
  const ws = await workspace()
  const schema: any = {
    string: () => schema,
    number: () => schema,
    array: () => schema,
    int: () => schema,
    min: () => schema,
    max: () => schema,
    optional: () => schema,
    describe: () => schema,
  }
  const factory: any = (def: unknown) => def
  factory.schema = schema

  const tools = provider(ws).tools!(factory)
  assert.deepEqual(Object.keys(tools), ["memory_search"])
  const payload = JSON.parse(
    await (tools.memory_search as any).execute({ query: "backups", top_k: 1 }, { directory: ws.directory }),
  )
  assert.equal(payload.hits.length, 1)
  assert.match(payload.hits[0].excerpt, /backups/)
})

test("the explorer never exposes a writer", () => {
  const p = provider({ directory: "/p", stateDir: "/s", vaultDir: "/v", dbFile: "/db" })
  assert.equal(p.consolidate, undefined)
  assert.equal(p.capabilities.write, false)
})
