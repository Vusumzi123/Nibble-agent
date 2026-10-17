import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CURSOR_VERSION,
  advanceCursor,
  consumeBatch,
  defaultCursor,
  loadCursor,
  pruneSummaries,
  recordFailure,
  resolveCursorFile,
  saveCursor,
  setSummary,
} from "./cursor.ts"

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "drain-cursor-"))
  return resolveCursorFile(dir)
}

test("missing file yields defaults without warning", async () => {
  let warned = false
  const cursor = await loadCursor(await tmpFile(), () => (warned = true))
  assert.deepEqual(cursor, defaultCursor())
  assert.equal(warned, false)
})

test("corrupt JSON yields defaults and warns", async () => {
  const file = await tmpFile()
  await writeFile(file, "{ not json", "utf8")
  const warnings: string[] = []
  const cursor = await loadCursor(file, (msg) => warnings.push(msg))
  assert.deepEqual(cursor, defaultCursor())
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /corrupt JSON/)
})

test("unsupported version yields defaults and warns", async () => {
  const file = await tmpFile()
  await writeFile(file, JSON.stringify({ version: 99, last_ts: 42 }), "utf8")
  const warnings: string[] = []
  const cursor = await loadCursor(file, (msg) => warnings.push(msg))
  assert.deepEqual(cursor, defaultCursor())
  assert.match(warnings[0], /unsupported version 99/)
})

test("save/load round-trips the cursor and stamps updated_at", async () => {
  const file = await tmpFile()
  const base = setSummary({ ...defaultCursor(), last_ts: 500 }, "ses_a", 400, "prior summary")
  const saved = await saveCursor(file, base, () => new Date("2026-10-17T12:00:00.000Z"))
  assert.equal(saved.updated_at, "2026-10-17T12:00:00.000Z")

  const loaded = await loadCursor(file)
  assert.equal(loaded.last_ts, 500)
  assert.equal(loaded.summaries.ses_a.text, "prior summary")
  assert.equal(loaded.version, CURSOR_VERSION)
})

test("load normalizes invalid fields instead of throwing", async () => {
  const file = await tmpFile()
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      last_ts: -5,
      blocked: { ts: -1, attempts: -2 },
      summaries: {
        bad_ts: { ts: "x", text: "y" },
        bad_text: { ts: 10, text: 5 },
        stale: { ts: 3, text: "ok" },
      },
      updated_at: 42,
    }),
    "utf8",
  )
  const cursor = await loadCursor(file)
  assert.equal(cursor.last_ts, 0)
  assert.deepEqual(cursor.blocked, { ts: 0, attempts: 0 })
  assert.deepEqual(Object.keys(cursor.summaries), ["stale"])
  assert.equal(cursor.updated_at, new Date(0).toISOString())
})

test("advance is monotonic and clears blocked", async () => {
  const blocked = { ...defaultCursor(), last_ts: 100, blocked: { ts: 200, attempts: 2 } }
  const forward = advanceCursor(blocked, 300)
  assert.equal(forward.last_ts, 300)
  assert.deepEqual(forward.blocked, { ts: 300, attempts: 0 })

  const backward = advanceCursor(forward, 250)
  assert.equal(backward.last_ts, 300)
})

test("recordFailure counts attempts at one boundary", () => {
  const first = recordFailure(defaultCursor(), 100, 3)
  assert.equal(first.dropped, false)
  assert.deepEqual(first.cursor.blocked, { ts: 100, attempts: 1 })

  const second = recordFailure(first.cursor, 100, 3)
  assert.equal(second.cursor.blocked.attempts, 2)

  const third = recordFailure(second.cursor, 100, 3)
  assert.equal(third.dropped, true)
  assert.equal(third.cursor.last_ts, 100)
  assert.deepEqual(third.cursor.blocked, { ts: 100, attempts: 0 })
})

test("poison advances exactly once", () => {
  const poisoned = recordFailure(defaultCursor(), 100, 1)
  assert.equal(poisoned.dropped, true)
  assert.equal(poisoned.cursor.last_ts, 100)

  const again = recordFailure(poisoned.cursor, 100, 1)
  assert.equal(again.dropped, false)
  assert.equal(again.cursor.last_ts, 100)
  assert.deepEqual(again.cursor.blocked, { ts: 100, attempts: 0 })
})

test("a new boundary resets the attempt counter", () => {
  const first = recordFailure(defaultCursor(), 100, 3)
  const next = recordFailure(first.cursor, 200, 3)
  assert.deepEqual(next.cursor.blocked, { ts: 200, attempts: 1 })
})

test("poisonAttempts <= 0 never drops", () => {
  let cursor = defaultCursor()
  for (let i = 0; i < 10; i++) {
    const result = recordFailure(cursor, 100, 0)
    assert.equal(result.dropped, false)
    cursor = result.cursor
  }
  assert.equal(cursor.blocked.attempts, 10)
})

test("pruneSummaries keeps the newest entries", () => {
  let cursor = defaultCursor()
  cursor = setSummary(cursor, "old", 100, "old")
  cursor = setSummary(cursor, "new", 300, "new")
  cursor = setSummary(cursor, "mid", 200, "mid")

  const kept = pruneSummaries(cursor, 2)
  assert.deepEqual(Object.keys(kept.summaries).sort(), ["mid", "new"])
  assert.deepEqual(pruneSummaries(cursor, 0).summaries, {})
  assert.equal(pruneSummaries(cursor, 5), cursor)
})

test("consumeBatch advances, clears blocked, and prunes", () => {
  let cursor = defaultCursor()
  cursor = setSummary(cursor, "a", 100, "a")
  cursor = setSummary(cursor, "b", 300, "b")
  cursor = { ...cursor, blocked: { ts: 400, attempts: 2 } }

  const next = consumeBatch(cursor, 400, 1)
  assert.equal(next.last_ts, 400)
  assert.deepEqual(next.blocked, { ts: 400, attempts: 0 })
  assert.deepEqual(Object.keys(next.summaries), ["b"])
})

test("saved JSON is human-readable and newline-terminated", async () => {
  const file = await tmpFile()
  await saveCursor(file, defaultCursor())
  const text = await readFile(file, "utf8")
  assert.ok(text.endsWith("\n"))
  assert.match(text, /\n {2}"last_ts"/)
})
