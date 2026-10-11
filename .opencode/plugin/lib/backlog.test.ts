import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_CONFIG,
  append,
  buildEntry,
  findOpenDuplicate,
  list,
  newBacklogId,
  normalizeKind,
  normalizeTitle,
  parseBacklogConfig,
  parseNdjsonEntries,
  pendingCount,
  readAll,
  readBacklogConfig,
  refreshView,
  renderEntry,
  renderMarkdown,
  resolveBacklogFile,
  resolveViewFile,
  serializeEntries,
  setStatus,
  sortEntries,
  type BacklogDraft,
  type BacklogEntry,
} from "./backlog.ts"
import { writeSection } from "./test-utils.ts"

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "backlog-"))
}

function draft(over: Partial<BacklogDraft> = {}): BacklogDraft {
  return {
    source: "conversation",
    kind: "task",
    payload: { title: "Do the thing", detail: "soon" },
    ...over,
  }
}

function entry(id: string, over: Partial<BacklogEntry> = {}): BacklogEntry {
  return {
    id,
    created: "2026-10-10T00:00:00.000Z",
    updated: "2026-10-10T00:00:00.000Z",
    source: "conversation",
    kind: "task",
    payload: { title: "t", detail: "", commands: [], files: [] },
    level_required: 0,
    priority: 0,
    status: "pending",
    channel_notified: null,
    awaiting_reply: false,
    jev_decision: null,
    result: null,
    view_ref: null,
    links: [],
    ...over,
  }
}

// --- Config ---------------------------------------------------------------

test("parseBacklogConfig reads known keys and ignores unknown ones", () => {
  const parsed = parseBacklogConfig(
    "backlog:\n  enabled: false\n  file: q.ndjson\n  view_file: Q.md\n  dedupe: false\n  max_view: 50\n  bogus: x\n",
  )
  assert.equal(parsed.enabled, false)
  assert.equal(parsed.file, "q.ndjson")
  assert.equal(parsed.view_file, "Q.md")
  assert.equal(parsed.dedupe, false)
  assert.equal(parsed.max_view, 50)
  assert.equal("bogus" in parsed, false)
})

test("readBacklogConfig returns defaults when the section is absent", async () => {
  const dir = await tmpDir()
  await writeSection(dir, "knowledge", ["enabled: true"])
  const cfg = await readBacklogConfig(dir)
  assert.deepEqual(cfg, DEFAULT_CONFIG)
})

test("resolveBacklogFile / resolveViewFile join leaves onto their roots", () => {
  const cfg = { ...DEFAULT_CONFIG, file: "backlog.ndjson", view_file: "Backlog.md" }
  assert.equal(resolveBacklogFile("/state", cfg), "/state/backlog.ndjson")
  assert.equal(resolveViewFile("/vault", cfg), "/vault/Backlog.md")
})

// --- Id + kind helpers ----------------------------------------------------

test("newBacklogId is unique and prefixed for time ordering", () => {
  const a = newBacklogId(1700000000000)
  const b = newBacklogId(1700000000000)
  assert.notEqual(a, b)
  assert.ok(a.startsWith("bl-"))
  assert.equal(newBacklogId(100).slice(0, 5), newBacklogId(100).slice(0, 5))
})

test("normalizeKind accepts the enum and falls back to task", () => {
  assert.equal(normalizeKind("idea"), "idea")
  assert.equal(normalizeKind("not-a-kind"), "task")
  assert.equal(normalizeKind(undefined), "task")
})

test("normalizeTitle collapses whitespace and lowercases", () => {
  assert.equal(normalizeTitle("  Do  The   Thing "), "do the thing")
})

// --- buildEntry -----------------------------------------------------------

test("buildEntry fills defaults and reserved fields", () => {
  const e = buildEntry(draft())
  assert.match(e.id, /^bl-/)
  assert.equal(e.status, "pending")
  assert.equal(e.level_required, 0)
  assert.equal(e.priority, 0)
  assert.equal(e.payload.detail, "soon")
  assert.deepEqual(e.payload.commands, [])
  assert.deepEqual(e.payload.files, [])
  assert.equal(e.channel_notified, null)
  assert.equal(e.jev_decision, null)
  assert.equal(e.result, null)
  assert.equal(e.view_ref, null)
  assert.equal(e.awaiting_reply, false)
  assert.deepEqual(e.links, [])
})

// --- append / readAll -----------------------------------------------------

test("append writes an NDJSON line and returns created", async () => {
  const dir = await tmpDir()
  const file = join(dir, "backlog.ndjson")
  const { entry: e, created } = await append(file, draft())
  assert.equal(created, true)
  const entries = await readAll(file)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, e.id)
})

test("append dedupes an open duplicate by source + title", async () => {
  const dir = await tmpDir()
  const file = join(dir, "backlog.ndjson")
  const first = await append(file, draft())
  const dup = await append(file, draft({ payload: { title: "  do the thing " } }))
  assert.equal(dup.created, false)
  assert.equal(dup.entry.id, first.entry.id)
  assert.equal((await readAll(file)).length, 1)
})

test("append with dedupe:false does not dedupe", async () => {
  const dir = await tmpDir()
  const file = join(dir, "backlog.ndjson")
  await append(file, draft())
  const second = await append(file, draft(), { dedupe: false })
  assert.equal(second.created, true)
  assert.equal((await readAll(file)).length, 2)
})

test("append does not dedupe against a closed entry", async () => {
  const dir = await tmpDir()
  const file = join(dir, "backlog.ndjson")
  const first = await append(file, draft())
  await setStatus(file, first.entry.id, "done")
  const second = await append(file, draft())
  assert.equal(second.created, true)
})

test("readAll skips blank and malformed lines", async () => {
  const dir = await tmpDir()
  const file = join(dir, "backlog.ndjson")
  await append(file, draft())
  await append(file, draft({ payload: { title: "second" } }), { dedupe: false })
  const good = (await readFile(file, "utf8")).trim().split("\n")
  // Corrupt the middle: one malformed line + one blank line between the two
  // good lines.
  await writeFile(file, `${good[0]}\n{ not json }\n\n${good[1]}\n`)
  const entries = await readAll(file)
  assert.equal(entries.length, 2)
})

// --- list / pendingCount --------------------------------------------------

test("list sorts priority desc then created asc", async () => {
  const dir = await tmpDir()
  const file = join(dir, "backlog.ndjson")
  await append(file, draft({ payload: { title: "a" }, priority: 1 }))
  await append(file, draft({ payload: { title: "b" }, priority: 2 }), { dedupe: false })
  await append(file, draft({ payload: { title: "c" }, priority: 1 }), { dedupe: false })
  const titles = (await list(file)).map((e) => e.payload.title)
  assert.deepEqual(titles, ["b", "a", "c"])
})

test("list filters by status, statuses, and maxLevel", async () => {
  const dir = await tmpDir()
  const file = join(dir, "backlog.ndjson")
  const a = await append(file, draft({ payload: { title: "a" }, level_required: 1 }))
  await append(file, draft({ payload: { title: "b" }, level_required: 3 }), { dedupe: false })
  await setStatus(file, a.entry.id, "done")

  assert.equal((await list(file, { status: "done" })).length, 1)
  assert.equal((await list(file, { statuses: ["pending", "done"] })).length, 2)
  assert.equal((await list(file, { maxLevel: 1 })).length, 1)
})

test("pendingCount respects maxLevel", async () => {
  const dir = await tmpDir()
  const file = join(dir, "backlog.ndjson")
  await append(file, draft({ payload: { title: "a" }, level_required: 1 }))
  await append(file, draft({ payload: { title: "b" }, level_required: 4 }), { dedupe: false })
  assert.equal(await pendingCount(file), 2)
  assert.equal(await pendingCount(file, 1), 1)
  assert.equal(await pendingCount(file, 4), 2)
})

test("pendingCount on a missing file is 0", async () => {
  const dir = await tmpDir()
  assert.equal(await pendingCount(join(dir, "nope.ndjson")), 0)
})

// --- setStatus ------------------------------------------------------------

test("setStatus transitions atomically and bumps updated", async () => {
  const dir = await tmpDir()
  const file = join(dir, "backlog.ndjson")
  const a = await append(file, draft({ payload: { title: "a" } }))
  const b = await append(file, draft({ payload: { title: "b" } }), { dedupe: false })

  const updated = await setStatus(file, a.entry.id, "approved")
  assert.ok(updated)
  assert.equal(updated.status, "approved")
  assert.ok(updated.updated > a.entry.updated)

  const entries = await readAll(file)
  assert.equal(entries.find((e) => e.id === a.entry.id)?.status, "approved")
  assert.equal(entries.find((e) => e.id === b.entry.id)?.status, "pending")
})

test("setStatus returns null for an unknown id and leaves the file intact", async () => {
  const dir = await tmpDir()
  const file = join(dir, "backlog.ndjson")
  await append(file, draft())
  const before = await readFile(file, "utf8")
  assert.equal(await setStatus(file, "bl-missing", "done"), null)
  assert.equal(await readFile(file, "utf8"), before)
})

test("setStatus can patch reserved fields (e.g. result)", async () => {
  const dir = await tmpDir()
  const file = join(dir, "backlog.ndjson")
  const a = await append(file, draft())
  const updated = await setStatus(file, a.entry.id, "done", {
    result: { ok: true, summary: "nailed it", ts: "2026-10-10T01:00:00.000Z", token_cost: 1200 },
  })
  assert.deepEqual(updated?.result, {
    ok: true,
    summary: "nailed it",
    ts: "2026-10-10T01:00:00.000Z",
    token_cost: 1200,
  })
})

// --- serialize/parse round-trip + sort ------------------------------------

test("serializeEntries/parseNdjsonEntries round-trip", () => {
  const entries = [entry("bl-1"), entry("bl-2", { status: "done" })]
  assert.deepEqual(parseNdjsonEntries(serializeEntries(entries)), entries)
})

test("sortEntries is stable and does not mutate its input", () => {
  const entries = [
    entry("a", { priority: 0, created: "2026-01-01T00:00:00Z" }),
    entry("b", { priority: 2, created: "2026-01-01T00:00:00Z" }),
    entry("c", { priority: 0, created: "2025-01-01T00:00:00Z" }),
  ]
  const sorted = sortEntries(entries)
  assert.deepEqual(sorted.map((e) => e.id), ["b", "c", "a"])
  assert.equal(entries[0].id, "a") // input unchanged
})

// --- renderer -------------------------------------------------------------

test("renderMarkdown emits status sections, wikilinks, and detail", () => {
  const entries = [
    entry("bl-1", {
      payload: { title: "Fix the thing", detail: "it is broken", commands: [], files: [] },
      level_required: 2,
      links: ["[[Roadmap]]"],
    }),
  ]
  const md = renderMarkdown(entries)
  assert.ok(md.includes("## Pending"))
  assert.ok(md.includes("- [ ] **Fix the thing** (id: bl-1, L2, priority 0) [[Roadmap]]"))
  assert.ok(md.includes("it is broken"))
  assert.ok(md.includes("title: Backlog"))
})

test("renderMarkdown orders sections by STATUS_ORDER and hides extras beyond maxView", () => {
  const entries = [entry("a", { status: "done" }), entry("b", { status: "pending" })]
  const md = renderMarkdown(entries)
  assert.ok(md.indexOf("## Pending") < md.indexOf("## Done"))

  const many = [entry("a"), entry("b"), entry("c")]
  const capped = renderMarkdown(many, { maxView: 2 })
  assert.ok(capped.includes("… 1 more pending item(s) hidden"))
})

test("renderMarkdown renders an empty queue", () => {
  const md = renderMarkdown([])
  assert.ok(md.includes("_No backlog items._"))
  assert.ok(!md.includes("## Pending"))
})

test("renderEntry omits empty links and level 0", () => {
  const line = renderEntry(entry("x"))
  assert.ok(!line.includes("L0"))
  assert.ok(!line.includes("  "))
})

// --- refreshView ----------------------------------------------------------

test("refreshView writes the derived view from the queue", async () => {
  const dir = await tmpDir()
  const file = join(dir, "backlog.ndjson")
  const view = join(dir, "Backlog.md")
  await append(file, draft())
  await refreshView(file, view)
  const md = await readFile(view, "utf8")
  assert.ok(md.includes("## Pending"))
  assert.ok(md.includes("Do the thing"))
})
