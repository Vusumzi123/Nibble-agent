import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  appendMemoryEntry,
  entryHash,
  linesOf,
  normalizeMemoryFile,
  parseMemory,
  parseSeq,
  pruneConsumed,
  searchTemporal,
  type MemoryEntry,
} from "./temporal.ts"

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "temporal-"))
  return join(dir, "memory.json")
}

function entry(
  seq: number,
  user: string,
  assistant: string,
  over: Partial<MemoryEntry> = {},
): MemoryEntry {
  return {
    seq,
    session: over.session ?? "ses_x",
    ts: over.ts ?? "2026-09-26T00:00:00Z",
    user,
    assistant,
    tags: over.tags ?? [],
    salience: over.salience ?? null,
    newTag: over.newTag ?? null,
    hash: over.hash ?? entryHash(user, assistant),
  }
}

function draft(user: string, assistant: string, over: Partial<MemoryEntry> = {}) {
  return {
    session: over.session ?? "ses_x",
    ts: over.ts ?? "2026-09-26T00:00:00Z",
    user,
    assistant,
    tags: over.tags ?? [],
    salience: over.salience ?? null,
    newTag: over.newTag ?? null,
  }
}

// ---------------------------------------------------------------------------
// Parsing

test("linesOf trims and drops blanks; parseSeq tolerates malformed lines", () => {
  assert.deepEqual(linesOf("a\n\n  b  \n"), ["a", "b"])
  assert.equal(parseSeq('{"seq":7}'), 7)
  assert.equal(parseSeq("not json"), null)
  assert.equal(parseSeq('{"noSeq":1}'), null)
})

test("parseMemory parses a JSON array and skips malformed entries", () => {
  const content = JSON.stringify([
    entry(1, "alpha", "beta"),
    { nope: true },
    {
      seq: 2,
      session: "ses_b",
      ts: "2026-09-26T01:00:00Z",
      user: "u2",
      assistant: "a2",
      tags: ["ai/opencode"],
      salience: 3,
      newTag: null,
      hash: "deadbeef",
    },
  ])

  const parsed = parseMemory(content)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].seq, 1)
  assert.equal(parsed[1].seq, 2)
  assert.deepEqual(parsed[1].tags, ["ai/opencode"])
  assert.equal(parsed[1].salience, 3)
})

test("parseMemory still reads a legacy JSON Lines buffer", () => {
  const content = [
    JSON.stringify(entry(1, "alpha", "beta")),
    "{ torn write",
    JSON.stringify(entry(2, "u2", "a2", { tags: ["ai/opencode"] })),
  ].join("\n")

  assert.deepEqual(parseMemory(content).map((e) => e.seq), [1, 2])
})

test("appendMemoryEntry writes a JSON array document", async () => {
  const file = await tmpFile()
  await appendMemoryEntry(file, draft("one", "r1"))
  await appendMemoryEntry(file, draft("two", "r2"))
  const raw = await readFile(file, "utf8")
  assert.ok(raw.trim().startsWith("["))
  const parsed = JSON.parse(raw)
  assert.ok(Array.isArray(parsed))
  assert.equal(parsed.length, 2)
})

test("normalizeMemoryFile migrates a legacy JSON Lines buffer to an array", async () => {
  const file = await tmpFile()
  await writeFile(
    file,
    [JSON.stringify(entry(1, "a", "b")), JSON.stringify(entry(2, "c", "d"))].join("\n") + "\n",
    "utf8",
  )
  assert.equal(await normalizeMemoryFile(file), true)
  const raw = await readFile(file, "utf8")
  assert.ok(raw.trim().startsWith("["))
  assert.deepEqual(parseMemory(raw).map((e) => e.seq), [1, 2])
  // Idempotent: an array (or a missing file) is left untouched.
  assert.equal(await normalizeMemoryFile(file), false)
  assert.equal(await normalizeMemoryFile("/nonexistent/memory.json"), false)
})

// ---------------------------------------------------------------------------
// seq + hash

test("appendMemoryEntry derives a global monotonic seq from file content", async () => {
  const file = await tmpFile()
  const a = await appendMemoryEntry(file, draft("one", "reply one"))
  const b = await appendMemoryEntry(file, draft("two", "reply two"))
  const c = await appendMemoryEntry(file, draft("three", "reply three"))
  assert.equal(a.seq, 1)
  assert.equal(b.seq, 2)
  assert.equal(c.seq, 3)
  assert.deepEqual(
    parseMemory(await readFile(file, "utf8")).map((e) => e.seq),
    [1, 2, 3],
  )
})

test("entryHash is normalized, stable, and content-sensitive", () => {
  assert.equal(entryHash(" a ", "b"), entryHash("a", "b"))
  assert.equal(entryHash("a", "b"), entryHash("a", "b"))
  assert.notEqual(entryHash("a", "b"), entryHash("a", "c"))
})

// ---------------------------------------------------------------------------
// prune

test("pruneConsumed filters by seq set and is idempotent", async () => {
  const file = await tmpFile()
  await appendMemoryEntry(file, draft("one", "r1"))
  await appendMemoryEntry(file, draft("two", "r2"))
  await appendMemoryEntry(file, draft("three", "r3"))

  assert.equal(await pruneConsumed(file, new Set([2])), 1)
  assert.deepEqual(parseMemory(await readFile(file, "utf8")).map((e) => e.seq), [1, 3])
  // Already gone: second prune is a no-op.
  assert.equal(await pruneConsumed(file, new Set([2])), 0)
})

test("pruneConsumed keeps concurrently-appended higher seqs", async () => {
  const file = await tmpFile()
  await appendMemoryEntry(file, draft("one", "r1"))
  await appendMemoryEntry(file, draft("two", "r2"))

  await pruneConsumed(file, new Set([1]))
  const newer = await appendMemoryEntry(file, draft("three", "r3"))
  assert.equal(newer.seq, 3)
  assert.deepEqual(parseMemory(await readFile(file, "utf8")).map((e) => e.seq), [2, 3])
})

test("pruneConsumed deletes an emptied file", async () => {
  const file = await tmpFile()
  await appendMemoryEntry(file, draft("one", "r1"))
  await pruneConsumed(file, new Set([1]))
  assert.equal(existsSync(file), false)
})

// ---------------------------------------------------------------------------
// search

test("searchTemporal is deterministic and ranks BM25 hits", () => {
  const entries = [
    entry(1, "install htop on cachyos", "run pacman -S htop"),
    entry(2, "angular frontend observables", "rxjs and signals"),
    entry(3, "htop htop htop pacman package manager", "install with pacman"),
  ]
  const q = { query: "htop pacman" }
  const first = searchTemporal(entries, q)
  const second = searchTemporal(entries, q)
  assert.deepEqual(first, second)
  assert.ok(first.length >= 1)
  // Entry 3 repeats the terms, so it must outrank entry 1.
  assert.equal(first[0].seq, 3)
})

test("searchTemporal tag boost matches a hierarchical prefix", () => {
  const entries = [
    entry(1, "deployment pipeline review", "no matching text here", { tags: ["ai/opencode"] }),
    entry(2, "unrelated content", "nothing to see"),
  ]
  const hits = searchTemporal(entries, { query: "opencode" })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].seq, 1)
  assert.ok(hits[0].score > 0)
})

test("searchTemporal honors tags and session filters", () => {
  const entries = [
    entry(1, "widget alpha", "reply", { session: "ses_a", tags: ["ai/opencode"] }),
    entry(2, "widget beta", "reply", { session: "ses_b", tags: ["linux"] }),
  ]
  const byTag = searchTemporal(entries, { query: "widget", tags: ["opencode"] })
  assert.deepEqual(byTag.map((h) => h.seq), [1])
  const bySession = searchTemporal(entries, { query: "widget", session: "ses_b" })
  assert.deepEqual(bySession.map((h) => h.seq), [2])
})

test("searchTemporal caps topK at 20 and bounds the snippet", () => {
  const entries = Array.from({ length: 25 }, (_, i) =>
    entry(i + 1, `widget ${i}`, "x".repeat(500)),
  )
  const hits = searchTemporal(entries, { query: "widget", topK: 100 })
  assert.equal(hits.length, 20)
  for (const h of hits) assert.ok(h.snippet.length <= 240)
})

test("searchTemporal with an empty query returns recency-ranked hits", () => {
  const entries = [entry(1, "a", "b"), entry(5, "c", "d"), entry(3, "e", "f")]
  const hits = searchTemporal(entries, { query: "" })
  assert.deepEqual(hits.map((h) => h.seq), [5, 3, 1])
  assert.ok(hits.every((h) => h.score === 0))
})

test("searchTemporal returns [] for a missing or malformed file", async () => {
  assert.deepEqual(searchTemporal("/nonexistent/memory.json", { query: "anything" }), [])
  const file = await tmpFile()
  await writeFile(file, "{ malformed\n", "utf8")
  assert.deepEqual(searchTemporal(file, { query: "anything" }), [])
})
