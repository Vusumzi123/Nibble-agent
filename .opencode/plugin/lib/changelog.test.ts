import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendChangelog,
  bumpFrontmatterDate,
  parseLog,
  parseLogSummary,
  readArchive,
  renderEntry,
  serializeLog,
} from "./changelog.ts"

test("renderEntry formats a parseable header and body", () => {
  const s = renderEntry({ date: "2026-10-15", op: "consolidation", title: "Added X", body: "Did a thing." })
  assert.equal(s, "## [2026-10-15] consolidation | Added X\nDid a thing.")
  const noBody = renderEntry({ date: "2026-10-15", op: "change", title: "T", body: "  " })
  assert.equal(noBody, "## [2026-10-15] change | T")
})

test("parseLog splits head from entries and round-trips", () => {
  const text = [
    "---",
    "title: Vault Changelog",
    "updated: 2026-10-01",
    "---",
    "",
    "# Vault Changelog",
    "",
    "intro",
    "",
    "## [2026-10-01] change | First",
    "Body one.",
    "",
    "## [2026-10-02] consolidation | Second",
    "Body two line a",
    "line b",
    "",
  ].join("\n")
  const { head, entries } = parseLog(text)
  assert.match(head, /# Vault Changelog/)
  assert.equal(entries.length, 2)
  assert.deepEqual(entries[0], { date: "2026-10-01", op: "change", title: "First", body: "Body one." })
  assert.deepEqual(entries[1], {
    date: "2026-10-02",
    op: "consolidation",
    title: "Second",
    body: "Body two line a\nline b",
  })
  const again = parseLog(serializeLog(head, entries))
  assert.deepEqual(again.entries, entries)
})

test("parseLog on a file with no entries keeps everything as head", () => {
  const { head, entries } = parseLog("# Title\n\nnothing here\n")
  assert.equal(entries.length, 0)
  assert.match(head, /# Title/)
})

test("parseLog drops a legacy ## Related section", () => {
  const text = [
    "# Vault Changelog",
    "",
    "## [2026-10-01] change | First",
    "Body one.",
    "",
    "## Related",
    "",
    "- [[overview]]",
    "- [[contract]]",
    "",
    "## [2026-10-02] change | Second",
    "Body two.",
    "",
  ].join("\n")
  const { entries } = parseLog(text)
  assert.deepEqual(entries.map((e) => e.title), ["First", "Second"])
  assert.equal(entries[0].body, "Body one.")
  assert.doesNotMatch(serializeLog("head", entries), /Related/)
})

test("bumpFrontmatterDate rewrites updated/updated_at only", () => {
  const head = "---\ntitle: X\ncreated: 2026-01-01\nupdated: 2026-10-01\nupdated_at: '2026-10-01'\n---\n\n# X"
  const out = bumpFrontmatterDate(head, "2026-10-15")
  assert.match(out, /^updated: 2026-10-15$/m)
  assert.match(out, /^updated_at: 2026-10-15$/m)
  assert.match(out, /^created: 2026-01-01$/m)
})

test("parseLogSummary prefers JSON, falls back to a title line", () => {
  assert.deepEqual(parseLogSummary('x\n```log\n{"title":"T","body":"B"}\n```'), { title: "T", body: "B" })
  assert.deepEqual(parseLogSummary("```log\nTitle here\nbody line\n```"), { title: "Title here", body: "body line" })
  assert.equal(parseLogSummary("no fence"), null)
  assert.equal(parseLogSummary("```log\n\n```"), null)
})

test("appendChangelog seeds a frontmatter head and appends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "changelog-"))
  const log = join(dir, "meta", "log.md")
  const res = await appendChangelog(
    log,
    { date: "2026-10-15", op: "consolidation", title: "First", body: "B." },
    { maxEntries: 0, archiveFile: join(dir, "state", "archive.ndjson") },
  )
  assert.deepEqual(res, { appended: true, archived: 0, rotated: false })
  const text = await readFile(log, "utf8")
  assert.match(text, /^---\ntitle: Vault Changelog/m)
  assert.match(text, /^updated: 2026-10-15$/m)
  assert.match(text, /^## \[2026-10-15\] consolidation \| First$/m)
  assert.match(text, /B\./)
})

test("appendChangelog rolls the oldest entries into the archive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "changelog-"))
  const log = join(dir, "meta", "log.md")
  const archive = join(dir, "state", "changelog-archive.ndjson")
  for (const n of [1, 2, 3]) {
    await appendChangelog(
      log,
      { date: `2026-09-0${n}`, op: "change", title: `E${n}`, body: `b${n}` },
      { maxEntries: 0, archiveFile: archive },
    )
  }

  const res = await appendChangelog(
    log,
    { date: "2026-09-04", op: "change", title: "E4", body: "b4" },
    { maxEntries: 2, archiveFile: archive },
  )
  assert.deepEqual(res, { appended: true, archived: 2, rotated: true })

  const kept = parseLog(await readFile(log, "utf8")).entries
  assert.deepEqual(kept.map((e) => e.title), ["E3", "E4"])

  const archived = await readArchive(archive)
  assert.deepEqual(archived.map((e) => e.title), ["E1", "E2"])
  assert.equal(archived[0].date, "2026-09-01")
})
