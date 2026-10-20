import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_BRAIN_STALE_HOURS,
  oldestReferenceNote,
  parseUpdatedDate,
} from "./vault-stale.ts"

async function tmpVault(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vault-stale-"))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    await mkdir(join(full, ".."), { recursive: true })
    await writeFile(full, content, "utf8")
  }
  return dir
}

const note = (type: string, updated: string, title = "T"): string =>
  `---\ntitle: ${title}\ntype: ${type}\nupdated: ${updated}\n---\n\nBody.\n`

test("parseUpdatedDate: accepts dates and ISO datetimes, rejects junk and impossible dates", () => {
  assert.equal(parseUpdatedDate("2026-08-05"), Date.UTC(2026, 7, 5))
  assert.equal(parseUpdatedDate("2026-08-05T12:34:56Z"), Date.UTC(2026, 7, 5))
  assert.equal(parseUpdatedDate("2026-02-30"), null)
  assert.equal(parseUpdatedDate("{{YYYY-MM-DD}}"), null)
  assert.equal(parseUpdatedDate(""), null)
})

test("oldestReferenceNote: picks the oldest type:reference note by updated:", async () => {
  const now = Date.UTC(2026, 9, 19)
  const dir = await tmpVault({
    "AI/older.md": note("reference", "2026-01-01", "Older"),
    "AI/newer.md": note("reference", "2026-09-01", "Newer"),
    "AI/log.md": note("log", "2020-01-01", "Log"),
    "AI/draft.md": note("note", "2019-01-01", "Draft"),
    "Journal/private.md": note("reference", "2010-01-01", "Private"),
    ".trash/old.md": note("reference", "2000-01-01", "Trash"),
  })

  const oldest = await oldestReferenceNote(dir, { nowMs: now, excludeDirs: ["Journal"] })
  assert.ok(oldest)
  assert.equal(oldest.path, "AI/older.md")
  assert.equal(oldest.title, "Older")
  assert.equal(oldest.updated, "2026-01-01")
  assert.equal(oldest.ageHours, (now - Date.UTC(2026, 0, 1)) / 3_600_000)
})

test("oldestReferenceNote: ties break on the path for a stable signal", async () => {
  const dir = await tmpVault({
    "b.md": note("reference", "2026-01-01", "B"),
    "a.md": note("reference", "2026-01-01", "A"),
  })
  const oldest = await oldestReferenceNote(dir, { nowMs: Date.UTC(2026, 9, 19) })
  assert.ok(oldest)
  assert.equal(oldest.path, "a.md")
})

test("oldestReferenceNote: no eligible notes and missing vault yield null", async () => {
  const empty = await tmpVault({ "AI/draft.md": note("note", "2020-01-01") })
  assert.equal(await oldestReferenceNote(empty, { nowMs: Date.now() }), null)
  assert.equal(await oldestReferenceNote(join(empty, "missing"), { nowMs: Date.now() }), null)
})

test("DEFAULT_BRAIN_STALE_HOURS is 30 days", () => {
  assert.equal(DEFAULT_BRAIN_STALE_HOURS, 720)
})
