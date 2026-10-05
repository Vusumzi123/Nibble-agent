// Temporal-memory buffer: a single JSON array of un-consumed conversation
// turns, plus a pure deterministic BM25 + tag search over it.
//
// The buffer (.opencode/state/memory.json) is owned by knowledge-hook — the
// only writer — and read by rag-search via the `temporal_search` tool. It is a
// *buffer*, not a journal: turns are pruned on successful consumption, so the
// file only ever holds the unconsumed backlog.
//
// No LLM, no network, no embeddings, no wall-clock input: identical file +
// query -> identical output. See docs/temporal-memory-plan.md §4, §6, §10.
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { unlink } from "node:fs/promises"
import { atomicRead, atomicUpdate } from "./fsx.ts"

// One completed turn. `seq` is a global monotonic turn id (increments across
// all sessions) and is the consumption/prune key. `hash` is a content hash for
// dedupe/merge.
export type MemoryEntry = {
  seq: number
  session: string
  ts: string
  user: string
  assistant: string
  tags: string[]
  salience: number | null
  newTag: string | null
  hash: string
}

// A not-yet-sequenced entry as produced by capture. `seq` is derived from the
// file (max + 1) and `hash` is computed here.
export type MemoryDraft = Omit<MemoryEntry, "seq" | "hash"> & { hash?: string }

// Normalize text for hashing only: trim + collapse internal whitespace.
export function normalizeText(s: string): string {
  return s.trim().replace(/\s+/g, " ")
}

// Dedupe/merge key: sha1 of the normalized user + assistant text.
export function entryHash(user: string, assistant: string): string {
  return createHash("sha1")
    .update(normalizeText(user) + "\n" + normalizeText(assistant))
    .digest("hex")
    .slice(0, 12)
}

// Non-empty, trimmed lines of the buffer.
export function linesOf(content: string): string[] {
  return content.split("\n").map((l) => l.trim()).filter(Boolean)
}

// seq of a single raw JSONL line, or null when it is malformed / has no seq.
export function parseSeq(line: string): number | null {
  try {
    const o = JSON.parse(line) as { seq?: unknown }
    return typeof o?.seq === "number" && Number.isFinite(o.seq) ? o.seq : null
  } catch {
    return null
  }
}

function coerceEntry(o: unknown): MemoryEntry | null {
  if (typeof o !== "object" || o === null) return null
  const r = o as Record<string, unknown>
  if (
    typeof r.seq !== "number" ||
    !Number.isFinite(r.seq) ||
    typeof r.session !== "string" ||
    typeof r.user !== "string" ||
    typeof r.assistant !== "string"
  ) {
    return null
  }
  return {
    seq: r.seq,
    session: r.session,
    ts: typeof r.ts === "string" ? r.ts : "",
    user: r.user,
    assistant: r.assistant,
    tags: Array.isArray(r.tags) ? (r.tags as unknown[]).filter((t): t is string => typeof t === "string") : [],
    salience: typeof r.salience === "number" ? r.salience : null,
    newTag: typeof r.newTag === "string" ? r.newTag : null,
    hash: typeof r.hash === "string" ? r.hash : "",
  }
}

// Parse a memory document into entries. The on-disk format is a single JSON
// array of entries. A legacy JSON Lines buffer is still accepted and is
// re-serialized as an array on the next write, so an upgrade never strands the
// existing backlog. A malformed document or a malformed entry is skipped,
// never fatal.
export function parseMemory(content: string): MemoryEntry[] {
  const trimmed = content.trim()
  if (!trimmed) return []

  const out: MemoryEntry[] = []
  if (trimmed.startsWith("[")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return []
    }
    if (!Array.isArray(parsed)) return []
    for (const item of parsed) {
      const entry = coerceEntry(item)
      if (entry) out.push(entry)
    }
    return out
  }

  // Legacy JSON Lines fallback (one object per line).
  for (const line of linesOf(content)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const entry = coerceEntry(parsed)
    if (entry) out.push(entry)
  }
  return out
}

// Serialize entries as a single pretty-printed JSON array (the on-disk format).
// An empty buffer serializes to "" so callers can delete the file.
export function serializeMemory(entries: MemoryEntry[]): string {
  return entries.length ? JSON.stringify(entries, null, 2) + "\n" : ""
}

// Rewrite a legacy JSON Lines buffer as a JSON array in place. Idempotent and
// safe to call at startup: a buffer that is missing, empty, or already an array
// is left untouched (no write). Returns true when a migration write occurred.
export async function normalizeMemoryFile(memoryFile: string): Promise<boolean> {
  const current = await atomicRead(memoryFile)
  const trimmed = current.trim()
  if (trimmed === "" || trimmed.startsWith("[")) return false
  await atomicUpdate(memoryFile, (cur) => serializeMemory(parseMemory(cur)))
  return true
}

// Read + parse the buffer (missing file -> []).
export async function readMemory(memoryFile: string): Promise<MemoryEntry[]> {
  return parseMemory(await atomicRead(memoryFile))
}

// Append one captured turn. `seq` is derived from the file content (max seq + 1,
// or 1 when empty) so there is no second counter to keep consistent. The
// per-file lock in atomicUpdate serializes concurrent captures.
export async function appendMemoryEntry(
  memoryFile: string,
  draft: MemoryDraft,
): Promise<MemoryEntry> {
  let appended: MemoryEntry | null = null
  await atomicUpdate(memoryFile, (cur) => {
    const entries = parseMemory(cur)
    const seq = entries.reduce((m, e) => Math.max(m, e.seq), 0) + 1
    const entry: MemoryEntry = {
      seq,
      session: draft.session,
      ts: draft.ts,
      user: draft.user,
      assistant: draft.assistant,
      tags: draft.tags,
      salience: draft.salience,
      newTag: draft.newTag,
      hash: draft.hash ?? entryHash(draft.user, draft.assistant),
    }
    appended = entry
    return serializeMemory([...entries, entry])
  })
  return appended as MemoryEntry
}

// Prune consumed turns by explicit seq set. Filtering (never a positional
// "keep first N") makes it idempotent and immune to reordering: a turn appended
// concurrently has a seq not in `consumed` and survives. Deletes the file when
// nothing remains. Returns the number of entries removed.
export async function pruneConsumed(memoryFile: string, consumed: Set<number>): Promise<number> {
  if (consumed.size === 0) return 0
  let removed = 0
  const next = await atomicUpdate(memoryFile, (cur) => {
    const kept = parseMemory(cur).filter((entry) => {
      if (consumed.has(entry.seq)) {
        removed++
        return false
      }
      return true
    })
    return serializeMemory(kept)
  })
  if (next.trim() === "") await unlink(memoryFile).catch(() => {})
  return removed
}

// ---------------------------------------------------------------------------
// Deterministic search (BM25 + tag boost)

export type TemporalQuery = {
  query: string
  topK?: number
  tags?: string[]
  session?: string
}

export type TemporalHit = {
  seq: number
  session: string
  ts: string
  tags: string[]
  salience: number | null
  snippet: string
  score: number
}

const BM25_K1 = 1.2
const BM25_B = 0.75
const TAG_BOOST = 2.0
const SNIPPET_MAX = 240
const DEFAULT_TOPK = 5
const MAX_TOPK = 20

// A small English stopword set. BM25 wants full terms, so this is deliberately
// minimal — it only drops function words that would dominate every document.
const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "was", "one", "our",
  "out", "get", "has", "how", "its", "new", "now", "see", "two", "who", "did", "use",
  "with", "that", "this", "have", "from", "they", "will", "would", "there", "their",
  "what", "about", "which", "when", "make", "like", "time", "just", "know", "into",
  "your", "some", "them", "then", "than", "been", "were", "also", "does", "here",
  "more", "only", "over", "such", "very", "well", "should", "could", "after",
  "before", "being", "because", "between", "through", "where", "while", "please",
])

// Lowercase, tokenize on `[a-z0-9][a-z0-9._/-]+` (min 2 chars), strip trailing
// separators, drop stopwords. Matches the extractKeywords shape but keeps full
// terms for BM25 (no length<4 filter).
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const raw of text.toLowerCase().match(/[a-z0-9][a-z0-9._/-]+/g) ?? []) {
    const token = raw.replace(/[._/-]+$/, "")
    if (token.length < 2 || STOPWORDS.has(token)) continue
    out.push(token)
  }
  return out
}

// A query term matches a tag when they are equal, when the term is a
// hierarchical segment of the tag (query `opencode` matches `ai/opencode`), or
// vice versa (query `ai/opencode` matches tag `opencode`).
export function tagMatches(term: string, tag: string): boolean {
  const t = term.toLowerCase()
  const g = tag.toLowerCase()
  if (t === g) return true
  if (g.startsWith(t + "/") || t.startsWith(g + "/")) return true
  return g.split("/").includes(t)
}

function snippetOf(entry: MemoryEntry): string {
  return normalizeText(entry.user + " " + entry.assistant).slice(0, SNIPPET_MAX)
}

function readFileSafe(file: string): string {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

// Pure deterministic search over the buffer. `source` is either the memory file
// path or an already-parsed entry list (the latter for tests / callers holding
// entries in hand). Returns topK (default 5, cap 20) hits ordered by descending
// score, tie-broken by descending seq (most recent first). A missing/malformed
// file yields [].
export function searchTemporal(
  source: string | MemoryEntry[],
  q: TemporalQuery,
): TemporalHit[] {
  const entries = typeof source === "string" ? parseMemory(readFileSafe(source)) : source
  const terms = tokenize(q.query ?? "")
  const session = (q.session ?? "").trim() || null
  const tagFilter = (q.tags ?? []).map((t) => t.trim()).filter(Boolean)
  const topK = Math.min(Math.max(q.topK ?? DEFAULT_TOPK, 1), MAX_TOPK)

  let docs = entries.filter((e) => !session || e.session === session)
  if (tagFilter.length > 0) {
    docs = docs.filter((e) => e.tags.some((tag) => tagFilter.some((f) => tagMatches(f, tag))))
  }
  if (docs.length === 0) return []

  // Empty query: recency-ranked (score 0), still honoring the filters.
  if (terms.length === 0) {
    return [...docs]
      .sort((a, b) => b.seq - a.seq)
      .slice(0, topK)
      .map((e) => ({
        seq: e.seq,
        session: e.session,
        ts: e.ts,
        tags: e.tags,
        salience: e.salience,
        snippet: snippetOf(e),
        score: 0,
      }))
  }

  const docTerms = docs.map((e) => tokenize(e.user + " " + e.assistant))
  const docLen = docTerms.map((t) => t.length)
  const N = docs.length
  const avgdl = docLen.reduce((a, b) => a + b, 0) / Math.max(1, N)

  const df = new Map<string, number>()
  for (const arr of docTerms) {
    for (const t of new Set(arr)) df.set(t, (df.get(t) ?? 0) + 1)
  }

  const hits: TemporalHit[] = []
  for (let i = 0; i < docs.length; i++) {
    const tf = new Map<string, number>()
    for (const t of docTerms[i]) tf.set(t, (tf.get(t) ?? 0) + 1)

    let score = 0
    for (const term of terms) {
      const f = tf.get(term) ?? 0
      if (f > 0) {
        const n = df.get(term) ?? 0
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
        score += (idf * (f * (BM25_K1 + 1))) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * docLen[i]) / avgdl))
      }
      if (docs[i].tags.some((tag) => tagMatches(term, tag))) score += TAG_BOOST
    }
    if (score <= 0) continue
    hits.push({
      seq: docs[i].seq,
      session: docs[i].session,
      ts: docs[i].ts,
      tags: docs[i].tags,
      salience: docs[i].salience,
      snippet: snippetOf(docs[i]),
      score: Math.round(score * 1e6) / 1e6,
    })
  }

  hits.sort((a, b) => b.score - a.score || b.seq - a.seq)
  return hits.slice(0, topK)
}
