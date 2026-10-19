import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DEFAULT_DRAIN, type DrainConfig } from "./config.ts"
import { defaultCursor, resolveCursorFile, saveCursor } from "./cursor.ts"
import { readDrainStatus, effectiveCursorLastTs } from "./status.ts"

const HOUR = 3_600_000

async function workspace(): Promise<{ directory: string; stateDir: string; dbFile: string }> {
  const root = await mkdtemp(join(tmpdir(), "drain-status-"))
  const directory = join(root, "project")
  const stateDir = join(directory, ".opencode", "state")
  await mkdir(stateDir, { recursive: true })
  const dbFile = join(stateDir, "turns.db")
  const db = new DatabaseSync(dbFile)
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, time_updated INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '');
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, data TEXT NOT NULL);
  `)
  db.close()
  return { directory, stateDir, dbFile }
}

function addTurn(dbFile: string, directory: string, id: string, time: number): void {
  const db = new DatabaseSync(dbFile)
  db.prepare(
    "INSERT INTO session (id, parent_id, directory, time_updated, title) VALUES (?, NULL, ?, ?, 'chat')",
  ).run("s_" + id, directory, time)
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
  ).run(
    "m_" + id,
    "s_" + id,
    time,
    JSON.stringify({ role: "user" }),
  )
  db.prepare("INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)").run(
    "p_" + id,
    "m_" + id,
    JSON.stringify({ type: "text", text: "hello " + id }),
  )
  db.close()
}

const writer = {
  capabilities: { write: true },
  consolidate: async () => ({ ok: true, consumed: [], skipped: [] }),
} as any

const reader = {
  capabilities: { write: false },
} as any

function cfg(overrides: Partial<DrainConfig> = {}): DrainConfig {
  return { ...DEFAULT_DRAIN, initial_lookback_hours: 0, ...overrides }
}

test("drain status: disabled and no-writer are locked", async () => {
  const ws = await workspace()
  const disabled = await readDrainStatus({
    ...ws,
    config: cfg({ enabled: false }),
    provider: writer,
  })
  assert.equal(disabled.reason, "disabled")
  assert.equal(disabled.locked, true)

  const paused = await readDrainStatus({ ...ws, config: cfg(), provider: reader })
  assert.equal(paused.reason, "paused")
  assert.equal(paused.locked, true)
  assert.equal(paused.writer, false)

  const none = await readDrainStatus({ ...ws, config: cfg(), provider: undefined })
  assert.equal(none.reason, "no-provider")
})

test("drain status: cursor parity and in-sync at the cursor", async () => {
  const ws = await workspace()
  addTurn(ws.dbFile, ws.directory, "old", 1_000)
  await saveCursor(resolveCursorFile(ws.stateDir), { ...defaultCursor(), last_ts: 1_000 })

  const synced = await readDrainStatus({ ...ws, config: cfg(), provider: writer })
  assert.equal(synced.pending, 0)
  assert.equal(synced.reason, "in-sync")
  assert.equal(synced.locked, true)

  addTurn(ws.dbFile, ws.directory, "new", 2_000)
  const pending = await readDrainStatus({ ...ws, config: cfg(), provider: writer })
  assert.equal(pending.pending, 1)
  assert.equal(pending.reason, null)
  assert.equal(pending.locked, false)
})

test("drain status: fresh cursor uses the initial lookback", async () => {
  const ws = await workspace()
  const now = 10 * HOUR
  addTurn(ws.dbFile, ws.directory, "inside", now - HOUR)
  addTurn(ws.dbFile, ws.directory, "outside", now - 3 * HOUR)

  const { lastTs, seeded } = await effectiveCursorLastTs(
    ws.stateDir,
    cfg({ initial_lookback_hours: 2 }),
    now,
  )
  assert.equal(seeded, true)
  assert.equal(lastTs, now - 2 * HOUR)

  const status = await readDrainStatus({
    ...ws,
    config: cfg({ initial_lookback_hours: 2 }),
    provider: writer,
    now,
  })
  assert.equal(status.seeded, true)
  assert.equal(status.pending, 1)
})

test("drain status: an unreadable store is unavailable, never zero", async () => {
  const ws = await workspace()
  const status = await readDrainStatus({
    directory: ws.directory,
    stateDir: ws.stateDir,
    config: cfg(),
    provider: writer,
    dbFile: join(ws.stateDir, "missing.db"),
  })
  assert.equal(status.pending, null)
  assert.equal(status.available, false)
  assert.equal(status.reason, "unavailable")
  assert.ok(status.error)
})
