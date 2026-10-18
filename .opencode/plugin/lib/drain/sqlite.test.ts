import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { openReadOnlyDb } from "./sqlite.ts"

async function fixture(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "drain-sqlite-"))
  const file = join(dir, "opencode.db")
  const db = new DatabaseSync(file)
  db.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, name TEXT NOT NULL);")
  db.exec("INSERT INTO sample (id, name) VALUES (1, 'one'), (2, 'two');")
  db.close()
  return { dir, file }
}

test("openReadOnlyDb queries through the active backend", async () => {
  const { dir, file } = await fixture()
  const db = await openReadOnlyDb(file)
  try {
    const one = db.prepare("SELECT name FROM sample WHERE id = ?").get(1) as { name?: unknown }
    assert.equal(one.name, "one")
    const names = (db.prepare("SELECT name FROM sample ORDER BY id").all() as Array<{ name?: unknown }>)
      .map((row) => row.name)
    assert.deepEqual(names, ["one", "two"])
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("openReadOnlyDb rejects a missing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drain-sqlite-missing-"))
  try {
    await assert.rejects(openReadOnlyDb(join(dir, "nope.db")))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
