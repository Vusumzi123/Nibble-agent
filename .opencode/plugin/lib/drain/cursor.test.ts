import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CURSOR_VERSION,
  advanceSession,
  advanceWatermark,
  blockedBackoffActive,
  defaultCursor,
  loadCursor,
  normalizeCursor,
  isWritten,
  markWritten,
  pruneSessions,
  recordFailure,
  recordSessionFailure,
  resolveCursorFile,
  saveCursor,
  sessionMarkTs,
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
  await writeFile(file, JSON.stringify({ version: 99, watermark_ts: 42 }), "utf8")
  const warnings: string[] = []
  const cursor = await loadCursor(file, (msg) => warnings.push(msg))
  assert.deepEqual(cursor, defaultCursor())
  assert.match(warnings[0], /unsupported version 99/)
})

test("v1 migrates in place: summaries become per-session marks (§2.3.1)", async () => {
  const file = await tmpFile()
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      last_ts: 500,
      blocked: { ts: 500, attempts: 1 },
      summaries: {
        ses_a: { ts: 400, text: "prior summary" },
        ses_b: { ts: 600, text: "above watermark" },
        bad: { ts: "x", text: "y" },
      },
      updated_at: "2026-10-20T00:00:00.000Z",
    }),
    "utf8",
  )
  const cursor = await loadCursor(file)
  assert.equal(cursor.version, CURSOR_VERSION)
  assert.equal(cursor.watermark_ts, 500)
  assert.equal(cursor.migrated_from, 1)
  assert.ok(cursor.migrated_at)
  // Mark = min(v1.last_ts, summary.ts) — never above what v1 consumed.
  assert.equal(cursor.sessions.ses_a.last_ts, 400)
  assert.equal(cursor.sessions.ses_a.summary, "prior summary")
  assert.equal(cursor.sessions.ses_b.last_ts, 500)
  assert.equal(cursor.sessions.ses_b.summary, "above watermark")
  assert.equal("bad" in cursor.sessions, false, "invalid v1 entries are dropped")
  assert.equal(cursor.blocked.ts, 500)
  assert.equal(cursor.blocked.attempts, 1)
})

test("v1 without summaries migrates to an empty mark set", () => {
  const cursor = normalizeCursor({ version: 1, last_ts: 1000, blocked: { ts: -1, attempts: -2 } })
  assert.equal(cursor.watermark_ts, 1000)
  assert.deepEqual(cursor.sessions, {})
  assert.deepEqual(cursor.blocked, { ts: 1000, attempts: 0, blocked_until: 0 })
})

test("save/load round-trips v2 and stamps updated_at", async () => {
  const file = await tmpFile()
  const base = advanceSession(
    advanceWatermark({ ...defaultCursor(), watermark_ts: 500 }, 500),
    "ses_a",
    400,
    "prior summary",
  )
  const saved = await saveCursor(file, base, () => new Date("2026-10-21T12:00:00.000Z"))
  assert.equal(saved.updated_at, "2026-10-21T12:00:00.000Z")

  const loaded = await loadCursor(file)
  assert.equal(loaded.watermark_ts, 500)
  assert.equal(loaded.sessions.ses_a.last_ts, 400)
  assert.equal(loaded.sessions.ses_a.summary, "prior summary")
  assert.equal(loaded.version, CURSOR_VERSION)
  assert.equal(loaded.migrated_from, undefined)
})

test("load normalizes invalid v2 fields instead of throwing", async () => {
  const file = await tmpFile()
  await writeFile(
    file,
    JSON.stringify({
      version: 2,
      watermark_ts: -5,
      blocked: { ts: -1, attempts: -2, blocked_until: "x" },
      sessions: {
        bad_ts: { last_ts: "x", summary: "y" },
        ok: { last_ts: 10, summary: 5 },
      },
      updated_at: 42,
    }),
    "utf8",
  )
  const cursor = await loadCursor(file)
  assert.equal(cursor.watermark_ts, 0)
  assert.deepEqual(cursor.blocked, { ts: 0, attempts: 0, blocked_until: 0 })
  assert.deepEqual(Object.keys(cursor.sessions), ["ok"])
  assert.equal(cursor.sessions.ok.summary, "")
  assert.equal(cursor.updated_at, new Date(0).toISOString())
})

test("sessionMarkTs falls back to the watermark for unknown sessions", () => {
  const cursor = advanceSession({ ...defaultCursor(), watermark_ts: 700 }, "ses_a", 300)
  assert.equal(sessionMarkTs(cursor, "ses_a"), 300)
  assert.equal(sessionMarkTs(cursor, "unknown"), 700)
})

test("watermark advance is monotonic and clears blocked", () => {
  const blocked = { ...defaultCursor(), watermark_ts: 100, blocked: { ts: 200, attempts: 2, blocked_until: 1 } }
  const forward = advanceWatermark(blocked, 300)
  assert.equal(forward.watermark_ts, 300)
  assert.deepEqual(forward.blocked, { ts: 300, attempts: 0, blocked_until: 0 })

  const backward = advanceWatermark(forward, 250)
  assert.equal(backward.watermark_ts, 300)
})

test("session marks are monotonic per session and keep summaries", () => {
  const base = setSummary({ ...defaultCursor(), watermark_ts: 500 }, "ses_a", 400, "text")
  const forward = advanceSession(base, "ses_a", 450)
  assert.equal(forward.sessions.ses_a.last_ts, 450)
  assert.equal(forward.sessions.ses_a.summary, "text", "summary carries when not replaced")

  const backward = advanceSession(forward, "ses_a", 300, "stale")
  assert.equal(backward.sessions.ses_a.last_ts, 450, "mark never moves backwards")
  assert.equal(backward.sessions.ses_a.summary, "stale", "summary still replaces")

  const replaced = advanceSession(base, "ses_a", 460, "new text")
  assert.equal(replaced.sessions.ses_a.summary, "new text")
  assert.equal(advanceSession(base, "ses_a", 400), base, "no-op returns the same object")
  assert.equal(advanceSession(base, "", 400), base, "empty session id is ignored")
})

test("recordFailure counts attempts, sets backoff, and poisons", () => {
  const first = recordFailure(defaultCursor(), 100, 3, { nowMs: 1_000, backoffMs: 500 })
  assert.equal(first.dropped, false)
  assert.deepEqual(first.cursor.blocked, { ts: 100, attempts: 1, blocked_until: 1_500 })
  assert.equal(blockedBackoffActive(first.cursor, 1_200), true)
  assert.equal(blockedBackoffActive(first.cursor, 1_500), false)

  const second = recordFailure(first.cursor, 100, 3, { nowMs: 2_000, backoffMs: 500 })
  assert.equal(second.cursor.blocked.attempts, 2)

  const third = recordFailure(second.cursor, 100, 3, { nowMs: 3_000, backoffMs: 500 })
  assert.equal(third.dropped, true)
  assert.equal(third.cursor.watermark_ts, 100)
  assert.deepEqual(third.cursor.blocked, { ts: 100, attempts: 0, blocked_until: 0 })
})

test("poison advances exactly once and a consumed boundary is a no-op", () => {
  const poisoned = recordFailure(defaultCursor(), 100, 1)
  assert.equal(poisoned.dropped, true)
  assert.equal(poisoned.cursor.watermark_ts, 100)

  const again = recordFailure(poisoned.cursor, 100, 1)
  assert.equal(again.dropped, false, "boundary already consumed at the watermark")
  assert.equal(again.cursor.watermark_ts, 100)

  const behind = recordFailure({ ...defaultCursor(), watermark_ts: 500 }, 400, 3)
  assert.equal(behind.dropped, false)
  assert.equal(behind.cursor.blocked.attempts, 0, "boundary behind the watermark is ignored")
})

test("a new boundary resets the attempt counter", () => {
  const first = recordFailure(defaultCursor(), 100, 3)
  const next = recordFailure(first.cursor, 200, 3)
  assert.deepEqual(next.cursor.blocked.ts, 200)
  assert.equal(next.cursor.blocked.attempts, 1)
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

test("pruneSessions keeps the newest entries by mark", () => {
  let cursor = defaultCursor()
  cursor = advanceSession(cursor, "old", 100, "old")
  cursor = advanceSession(cursor, "new", 300, "new")
  cursor = advanceSession(cursor, "mid", 200, "mid")

  const kept = pruneSessions(cursor, 2)
  assert.deepEqual(Object.keys(kept.sessions).sort(), ["mid", "new"])
  assert.deepEqual(pruneSessions(cursor, 0).sessions, {})
  assert.equal(pruneSessions(cursor, 5), cursor)
})

test("saved JSON is human-readable and newline-terminated", async () => {
  const file = await tmpFile()
  await saveCursor(file, defaultCursor())
  const text = await readFile(file, "utf8")
  assert.ok(text.endsWith("\n"))
  assert.match(text, /\n {2}"watermark_ts"/)
})


test("a v2 cursor upgrades in place without losing marks", () => {
  const cursor = normalizeCursor({
    version: 2,
    watermark_ts: 900,
    sessions: { ses_a: { last_ts: 800, summary: "kept" } },
  })
  assert.equal(cursor.version, 3)
  assert.equal(cursor.watermark_ts, 900)
  assert.equal(cursor.sessions.ses_a.last_ts, 800)
  assert.deepEqual(cursor.failures, {})
  assert.deepEqual(cursor.written, {})
})

test("per-session poison advances only the failed session's batch", () => {
  let cursor = advanceWatermark(defaultCursor(), 100)
  cursor = advanceSession(cursor, "ses_a", 500)
  cursor = advanceSession(cursor, "ses_b", 500)

  const first = recordSessionFailure(cursor, "ses_a", 1000, 3, { nowMs: 1_000, backoffMs: 500 })
  assert.equal(first.dropped, false)
  assert.equal(first.cursor.failures.ses_a?.attempts, 1)
  assert.equal(first.cursor.failures.ses_a?.blocked_until, 1_500)
  assert.equal(first.cursor.failures.ses_b, undefined)

  const second = recordSessionFailure(first.cursor, "ses_a", 1000, 3)
  const third = recordSessionFailure(second.cursor, "ses_a", 1000, 3)
  assert.equal(third.dropped, true)
  assert.equal(third.cursor.failures.ses_a, undefined)
  assert.equal(third.cursor.watermark_ts, 100, "poison alone never moves the watermark")
  assert.equal(third.cursor.sessions.ses_b.last_ts, 500, "the other session is untouched")
})

test("a new boundary resets that session's attempt counter", () => {
  const first = recordSessionFailure(defaultCursor(), "ses_a", 100, 3)
  const next = recordSessionFailure(first.cursor, "ses_a", 200, 3)
  assert.equal(next.cursor.failures.ses_a?.ts, 200)
  assert.equal(next.cursor.failures.ses_a?.attempts, 1)
})

test("advancing a session or the watermark clears stale failures", () => {
  const failed = recordSessionFailure(defaultCursor(), "ses_a", 100, 5).cursor
  const advanced = advanceSession(failed, "ses_a", 150)
  assert.equal(advanced.failures.ses_a, undefined)
  assert.equal(advanceWatermark(failed, 100).failures.ses_a, undefined)
  assert.equal(advanceWatermark(failed, 50).failures.ses_a?.attempts, 1)
})

test("written hashes dedupe re-runs and are capped", () => {
  let cursor = markWritten(defaultCursor(), ["a"], 100, 2)
  cursor = markWritten(cursor, ["b"], 150, 2)
  assert.equal(isWritten(cursor, "a"), true)
  assert.equal(isWritten(cursor, "missing"), false)
  cursor = markWritten(cursor, ["c"], 200, 2)
  assert.deepEqual(Object.keys(cursor.written).sort(), ["b", "c"])
  assert.equal(isWritten(cursor, "a"), false)
})

test("pruning sessions keeps only their failure records", () => {
  let cursor = defaultCursor()
  cursor = advanceSession(cursor, "old", 100)
  cursor = advanceSession(cursor, "new", 300)
  cursor = recordSessionFailure(cursor, "old", 400, 5).cursor
  cursor = recordSessionFailure(cursor, "new", 400, 5).cursor
  const kept = pruneSessions(cursor, 1)
  assert.deepEqual(Object.keys(kept.failures), ["new"])
})
