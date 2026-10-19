import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  checkSchema,
  explainFetch,
  openDrainSource,
  resolveDbFile,
  searchUnconsumed,
  type DrainSdkClient,
} from "./db.ts"
import { SUMMARIZER_SESSION_TITLE, WRITER_SESSION_TITLE } from "./automation.ts"

const PROJECT = "/work/project-a"
const OTHER = "/work/project-b"
const LAST_TS = 500

async function tmpDb(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "drain-db-"))
  return join(dir, "opencode.db")
}

function createFixture(file: string): DatabaseSync {
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      directory TEXT NOT NULL,
      time_updated INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX message_session_time_created_id_idx
      ON message(session_id, time_created, id);
  `)
  return db
}

function addSession(
  db: DatabaseSync,
  id: string,
  directory: string,
  updated: number,
  parent: string | null = null,
  title = "",
) {
  db.prepare(
    "INSERT INTO session (id, parent_id, directory, time_updated, title) VALUES (?, ?, ?, ?, ?)",
  ).run(id, parent, directory, updated, title)
}

function addMessage(
  db: DatabaseSync,
  id: string,
  sessionID: string,
  time: number,
  role: string,
  part: { type?: string; text?: string; synthetic?: boolean },
) {
  db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
    id,
    sessionID,
    time,
    JSON.stringify({ role }),
  )
  db.prepare("INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)").run(
    `${id}-p`,
    id,
    JSON.stringify(part),
  )
}

function seedMemory(file: string): void {
  const db = createFixture(file)
  addSession(db, "top-1", PROJECT, 3000)
  addSession(db, "child-1", PROJECT, 4000, "top-1")

  addMessage(db, "old", "top-1", 500, "user", { type: "text", text: "old wireguard note" })
  addMessage(db, "m1", "top-1", 1000, "user", {
    type: "text",
    text: "wireguard setup on the router",
  })
  addMessage(db, "m2", "top-1", 1500, "assistant", {
    type: "text",
    text: "use wg-quick with /etc/wireguard/wg0.conf",
  })
  addMessage(db, "m3", "top-1", 2500, "user", { type: "text", text: "backup policy is borg nightly" })
  addMessage(db, "mc", "child-1", 2600, "user", { type: "text", text: "wireguard child turn" })
  db.close()
}

function seed(file: string): void {
  const db = createFixture(file)
  addSession(db, "top-1", PROJECT, 1000)
  addSession(db, "top-other", OTHER, 2000)
  addSession(db, "child-1", PROJECT, 3000, "top-1")
  addSession(db, "old-1", PROJECT, 10)

  addMessage(db, "m-old", "top-1", 100, "user", { type: "text", text: "already consumed" })
  addMessage(db, "m-user", "top-1", 600, "user", { type: "text", text: "hello" })
  addMessage(db, "m-assistant", "top-1", 700, "assistant", { type: "text", text: "hi" })
  addMessage(db, "m-synthetic", "top-1", 800, "assistant", {
    type: "text",
    text: "synthetic",
    synthetic: true,
  })
  addMessage(db, "m-empty", "top-1", 850, "user", { type: "text", text: "   " })
  addMessage(db, "m-compaction", "top-1", 900, "assistant", { type: "compaction", text: "sum" })
  addMessage(db, "m-child", "child-1", 650, "user", { type: "text", text: "child turn" })
  addMessage(db, "m-other", "top-other", 650, "user", { type: "text", text: "other project" })
  db.close()
}

test("resolveDbFile honors env precedence", () => {
  assert.equal(resolveDbFile({ env: { OPENCODE_DB: "/x/custom.db" } as NodeJS.ProcessEnv }), "/x/custom.db")
  assert.equal(
    resolveDbFile({ env: { OPENCODE_DATA_DIR: "/data/opencode" } as NodeJS.ProcessEnv }),
    "/data/opencode/opencode.db",
  )
  assert.equal(
    resolveDbFile({ env: { XDG_DATA_HOME: "/xdg" } as NodeJS.ProcessEnv, home: "/home/u" }),
    "/xdg/opencode/opencode.db",
  )
  assert.equal(resolveDbFile({ env: {} as NodeJS.ProcessEnv, home: "/home/u" }), "/home/u/.local/share/opencode/opencode.db")
})

test("schema guard accepts the real column set", async () => {
  const file = await tmpDb()
  const db = createFixture(file)
  assert.deepEqual(checkSchema(db), { ok: true })
  db.close()
})

test("discovery is project-scoped, top-level only, and activity-ordered", async () => {
  const file = await tmpDb()
  seed(file)
  const source = await openDrainSource({ projectDir: PROJECT, dbFile: file })
  const sessions = await source.discover(LAST_TS, 10)
  await source.close()

  assert.equal(source.kind, "sqlite")
  assert.deepEqual(
    sessions.map((s) => s.id),
    ["top-1"],
  )
  assert.equal(sessions[0].timeUpdated, 1000)
})

test("discovery and the pending count skip the pipeline's own child sessions", async () => {
  const file = await tmpDb()
  seed(file)
  const db = new DatabaseSync(file)
  addSession(db, "auto-sum", PROJECT, 1100, null, SUMMARIZER_SESSION_TITLE)
  addSession(db, "auto-writer", PROJECT, 1200, null, WRITER_SESSION_TITLE)
  addMessage(db, "m-auto-sum", "auto-sum", 1100, "user", { type: "text", text: "meta" })
  addMessage(db, "m-auto-writer", "auto-writer", 1200, "assistant", {
    type: "text",
    text: "meta",
  })
  db.close()

  const source = await openDrainSource({ projectDir: PROJECT, dbFile: file })
  const sessions = await source.discover(LAST_TS, 10)
  assert.deepEqual(sessions.map((s) => s.id), ["top-1"])
  assert.equal(await source.unconsumedCount(LAST_TS), 2)
  await source.close()
})

test("discovery skips autonomous mission sessions", async () => {
  const file = await tmpDb()
  seed(file)
  const db = new DatabaseSync(file)
  addSession(db, "hb-stale", PROJECT, 1100, null, "heartbeat:staleness")
  addSession(db, "hb-drain", PROJECT, 1200, null, "heartbeat:drain")
  addSession(db, "dream-run", PROJECT, 1300, null, "dream:dream")
  addMessage(db, "m-hb-stale", "hb-stale", 1100, "assistant", {
    type: "text",
    text: "Refreshed Agent.md",
  })
  addMessage(db, "m-hb-drain", "hb-drain", 1200, "assistant", { type: "text", text: "Drained 3 sessions" })
  addMessage(db, "m-dream", "dream-run", 1300, "assistant", { type: "text", text: "A dream" })
  db.close()

  const source = await openDrainSource({ projectDir: PROJECT, dbFile: file })
  const sessions = await source.discover(LAST_TS, 10)
  assert.deepEqual(sessions.map((s) => s.id), ["top-1"])
  assert.equal(await source.unconsumedCount(LAST_TS), 2)
  await source.close()
})

test("fetch keeps only newer, non-synthetic text and respects the cap", async () => {
  const file = await tmpDb()
  seed(file)
  const source = await openDrainSource({ projectDir: PROJECT, dbFile: file })
  const turns = await source.fetch("top-1", LAST_TS, 10)
  await source.close()

  assert.deepEqual(
    turns.map((t) => t.text),
    ["hello", "hi"],
  )
  assert.deepEqual(turns.map((t) => t.role), ["user", "assistant"])
  assert.ok(turns.every((t) => t.time > LAST_TS))

  const capped = await (async () => {
    const src = await openDrainSource({ projectDir: PROJECT, dbFile: file })
    const rows = await src.fetch("top-1", LAST_TS, 1)
    await src.close()
    return rows
  })()
  assert.deepEqual(capped.map((t) => t.text), ["hello"])
})

test("unconsumedCount counts eligible new turns", async () => {
  const file = await tmpDb()
  seed(file)
  const source = await openDrainSource({ projectDir: PROJECT, dbFile: file })
  assert.equal(await source.unconsumedCount(LAST_TS), 2)
  assert.equal(await source.unconsumedCount(10_000), 0)
  await source.close()
})

test("the fetch query plan uses the session/time index", async () => {
  const file = await tmpDb()
  seed(file)
  const db = new DatabaseSync(file, { readOnly: true })
  const plan = explainFetch(db, "top-1", LAST_TS, 10)
  db.close()
  const details = plan.map((row) => String(row.detail ?? "")).join("\n")
  assert.match(details, /message_session_time_created_id_idx/)
})

test("schema mismatch degrades to the SDK source", async () => {
  const file = await tmpDb()
  const db = new DatabaseSync(file)
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY);")
  db.close()

  const client = mockClient()
  const warnings: string[] = []
  const source = await openDrainSource({
    projectDir: PROJECT,
    dbFile: file,
    client,
    onWarn: (msg) => warnings.push(msg),
  })
  assert.equal(source.kind, "sdk")
  assert.equal(source.degraded, "schema-mismatch")
  assert.match(warnings[0], /schema mismatch/)
  await source.close()
})

test("missing DB degrades to the SDK source when a client is provided", async () => {
  const file = await tmpDb()
  const source = await openDrainSource({ projectDir: PROJECT, dbFile: file, client: mockClient() })
  assert.equal(source.kind, "sdk")
  assert.equal(source.degraded, "sdk-fallback")
  await source.close()
})

test("missing DB without a client throws", async () => {
  const file = await tmpDb()
  await assert.rejects(() => openDrainSource({ projectDir: PROJECT, dbFile: file }), /db unavailable/)
})

test("SDK fallback applies the same filters and ordering", async () => {
  const source = await openDrainSource({
    projectDir: PROJECT,
    dbFile: "/nonexistent/opencode.db",
    client: mockClient(),
  })
  const sessions = await source.discover(LAST_TS, 10)
  assert.deepEqual(sessions.map((s) => s.id), ["s-top"])

  const turns = await source.fetch("s-top", LAST_TS, 10)
  assert.deepEqual(turns.map((t) => t.text), ["hello", "hi"])
  assert.equal(await source.unconsumedCount(LAST_TS), 2)
  await source.close()
})

function mockClient(): DrainSdkClient {
  return {
    session: {
      async list() {
        return {
          data: [
            { id: "s-top", parentID: null, directory: PROJECT, time: { updated: 1000 } },
            {
              id: "s-auto",
              parentID: null,
              title: WRITER_SESSION_TITLE,
              directory: PROJECT,
              time: { updated: 1500 },
            },
            {
              id: "s-mission",
              parentID: null,
              title: "heartbeat:staleness",
              directory: PROJECT,
              time: { updated: 1600 },
            },
            { id: "s-child", parentID: "s-top", directory: PROJECT, time: { updated: 3000 } },
            { id: "s-other", parentID: null, directory: OTHER, time: { updated: 2000 } },
            { id: "s-stale", parentID: null, directory: PROJECT, time: { updated: 10 } },
          ],
        }
      },
      async messages({ path }: any) {
        if (path.id !== "s-top") return { data: [] }
        return {
          data: [
            {
              info: { id: "old", sessionID: "s-top", role: "user", time: { created: 100 } },
              parts: [{ type: "text", text: "already consumed" }],
            },
            {
              info: { id: "u", sessionID: "s-top", role: "user", time: { created: 600 } },
              parts: [
                { type: "text", text: "hello" },
                { type: "text", text: "   " },
                { type: "text", text: "synthetic", synthetic: true },
                { type: "compaction", text: "sum" },
              ],
            },
            {
              info: { id: "a", sessionID: "s-top", role: "assistant", time: { created: 700 } },
              parts: [{ type: "text", text: "hi" }],
            },
            {
              info: { id: "ignored", sessionID: "s-top", role: "assistant", time: { created: 800 } },
              parts: [{ type: "text", text: "ignored", ignored: true }],
            },
          ],
        }
      },
    },
  }
}

test("memory search scores, filters, and caps the un-consolidated lane", async () => {
  const file = await tmpDb()
  seedMemory(file)

  const wireguard = await searchUnconsumed({
    projectDir: PROJECT,
    cursorTs: 900,
    query: "wireguard",
    topK: 5,
    dbFile: file,
  })
  assert.deepEqual(wireguard.map((h) => h.session), ["top-1", "top-1"])
  assert.deepEqual(wireguard.map((h) => h.time_ms), [1500, 1000])
  assert.ok(wireguard.every((h) => h.score > 0))
  assert.ok(wireguard.every((h) => h.excerpt.length <= 320))
  assert.equal(wireguard.some((h) => h.excerpt.includes("old wireguard")), false)

  const borg = await searchUnconsumed({
    projectDir: PROJECT,
    cursorTs: 900,
    query: "borg",
    topK: 5,
    dbFile: file,
  })
  assert.deepEqual(borg.map((h) => h.time_ms), [2500])
})

test("memory search honors since, session, tags, and top_k", async () => {
  const file = await tmpDb()
  seedMemory(file)

  const recent = await searchUnconsumed({
    projectDir: PROJECT,
    cursorTs: 900,
    since: 2000,
    query: "",
    topK: 5,
    dbFile: file,
  })
  assert.deepEqual(recent.map((h) => h.time_ms), [2500])

  const scoped = await searchUnconsumed({
    projectDir: PROJECT,
    cursorTs: 900,
    query: "wireguard",
    session: "top-1",
    topK: 5,
    dbFile: file,
  })
  assert.equal(scoped.every((h) => h.session === "top-1"), true)

  const child = await searchUnconsumed({
    projectDir: PROJECT,
    cursorTs: 900,
    query: "wireguard",
    session: "child-1",
    topK: 5,
    dbFile: file,
  })
  assert.deepEqual(child, [])

  const tagged = await searchUnconsumed({
    projectDir: PROJECT,
    cursorTs: 900,
    query: "",
    tags: ["wireguard"],
    topK: 5,
    dbFile: file,
  })
  assert.deepEqual(tagged.map((h) => h.time_ms), [1500, 1000])

  const capped = await searchUnconsumed({
    projectDir: PROJECT,
    cursorTs: 900,
    query: "wireguard",
    topK: 1,
    dbFile: file,
  })
  assert.equal(capped.length, 1)
  assert.equal(capped[0].time_ms, 1500)
})

test("memory hits disappear once the drain cursor advances past them", async () => {
  const file = await tmpDb()
  seedMemory(file)

  const before = await searchUnconsumed({
    projectDir: PROJECT,
    cursorTs: 900,
    query: "wireguard",
    topK: 5,
    dbFile: file,
  })
  assert.ok(before.length > 0)

  const after = await searchUnconsumed({
    projectDir: PROJECT,
    cursorTs: 2000,
    query: "wireguard",
    topK: 5,
    dbFile: file,
  })
  assert.deepEqual(after, [])
})
