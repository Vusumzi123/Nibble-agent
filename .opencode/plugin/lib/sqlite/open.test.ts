import { test } from "node:test"
import assert from "node:assert/strict"
import { openReadWriteDb } from "./open.ts"

test("get normalizes a missing row to null instead of the backend default", async () => {
  const db = await openReadWriteDb(":memory:")
  try {
    db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)")
    assert.equal(db.prepare("SELECT id FROM t WHERE id = ?").get("missing"), null)

    db.prepare("INSERT INTO t (id, n) VALUES (?, ?)").run("a", 1)
    const row = db.prepare("SELECT id, n FROM t WHERE id = ?").get("a") as {
      id?: string
      n?: number
    } | null
    assert.equal(row?.id, "a")
    assert.equal(row?.n, 1)
    const all = db.prepare("SELECT id FROM t ORDER BY id").all() as Array<{ id?: string }>
    assert.equal(all.length, 1)
    assert.equal(all[0]?.id, "a")
  } finally {
    db.close()
  }
})
