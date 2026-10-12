// Soul-hook helpers: config parsing, the first-person identity note (`Soul.md`)
// and the episodic journal (`Agent Journal.md`), the injection block, and the
// fold-down decision/writer/review request builders.
//
// The soul is the first-person counterpart to the profile: `Agent.md` is written
// *about* the agent (authoritative persona rules, curated by `profile-hook`),
// while `Soul.md` is written *by* the agent (first-person identity — who I am,
// what I value, what I'm working on becoming, open commitments), distilled from
// the append-only journal the way sleep turns episodic memory into identity.
//
// Everything here is deterministic and side-effect-light (no LLM, no network)
// except `atomicWriteFile`. The decision calls and the `self-writer` child live
// in `soul-hook.ts`; this module stays unit-testable without a live client.
//
// Reuses the profile module's well-tested note helpers (marker extraction,
// validation, frontmatter date, substantive-change, atomic write) since the
// Soul.md note obeys the same durability rules as the profile notes.
//
// Loaded via relative import only (same convention as the other lib files).
import { parseFlatBlock, readSection, sectionCoercer } from "./config.ts"
import type { DecisionRequest } from "./decisions.ts"
import { resolveProfileFile, stripNoteForInjection } from "./profile.ts"

export type SoulConfig = {
  enabled: boolean
  soul_file: string
  journal_file: string
  inject: boolean
  inject_max_bytes: number
  decide: boolean
  cooldown_turns: number
  journal_tail_bytes: number
  writer_agent: string
  writer_model: string
  child_timeout_ms: number
  note_max_bytes: number
  review: boolean
  review_threshold: number
  log: string
  log_rotate_bytes: number
  log_keep_generations: number
  log_retention_days: number
  log_compress: boolean
  log_compress_after: number
  log_compress_level: number
  log_rotate_by: string
}

export const DEFAULT_SOUL: SoulConfig = {
  enabled: true,
  soul_file: "Soul.md",
  journal_file: "Agent Journal.md",
  inject: true,
  inject_max_bytes: 4000,
  decide: true,
  cooldown_turns: 3,
  journal_tail_bytes: 6000,
  writer_agent: "self-writer",
  writer_model: "",
  child_timeout_ms: 90000,
  note_max_bytes: 6000,
  review: true,
  review_threshold: 0.6,
  log: "soul-hook.log",
  log_rotate_bytes: 1048576,
  log_keep_generations: 5,
  log_retention_days: 90,
  log_compress: true,
  log_compress_after: 1,
  log_compress_level: 6,
  log_rotate_by: "size",
}

const KNOWN_KEYS = new Set(Object.keys(DEFAULT_SOUL))
const BOOL_KEYS = new Set(["enabled", "inject", "decide", "review", "log_compress"])
const FLOAT_KEYS = new Set(["review_threshold"])
const INT_KEYS = new Set([
  "inject_max_bytes",
  "cooldown_turns",
  "journal_tail_bytes",
  "child_timeout_ms",
  "note_max_bytes",
  "log_rotate_bytes",
  "log_keep_generations",
  "log_retention_days",
  "log_compress_after",
  "log_compress_level",
])

const SOUL_COERCE = sectionCoercer({
  bools: BOOL_KEYS,
  ints: INT_KEYS,
  floats: FLOAT_KEYS,
  coerceFloat: (raw) => {
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
  },
  stripQuotesFirst: true,
  stringMode: "raw",
})

export function parseSoulConfig(yamlText: string): Partial<SoulConfig> {
  return parseFlatBlock(yamlText, "soul", {
    knownKeys: KNOWN_KEYS,
    coerce: SOUL_COERCE,
  }) as Partial<SoulConfig>
}

export async function readSoulConfig(directory: string): Promise<SoulConfig> {
  const cfg = await readSection(directory, "soul", DEFAULT_SOUL, {
    coerce: SOUL_COERCE,
  })
  if (!Number.isFinite(cfg.review_threshold) || cfg.review_threshold < 0 || cfg.review_threshold > 1) {
    cfg.review_threshold = DEFAULT_SOUL.review_threshold
  }
  return cfg
}

// Resolve a soul-note leaf against the vault root (same semantics as the
// profile notes: absolute leaves pass through, anything else is vault-relative).
export function resolveSoulFile(vaultRoot: string, leaf: string): string {
  return resolveProfileFile(vaultRoot, leaf)
}

// ---------------------------------------------------------------------------
// Journal — append-only episodic record (first person, rationale-bearing).
//
// Entry shape (machine-parseable, human-browsable):
//
//   ## [YYYY-MM-DD] <title>
//   what: …
//   why:  …
//   felt: …
//

export type JournalEntry = {
  date: string
  title: string
  what: string
  why: string
  felt: string
}

const ENTRY_RE = /^## \[(\d{4}-\d{2}-\d{2})\] (.+)$/

export function buildJournalEntry(entry: JournalEntry): string {
  return [
    `## [${entry.date}] ${entry.title}`,
    `what: ${entry.what}`,
    `why: ${entry.why}`,
    `felt: ${entry.felt}`,
  ].join("\n")
}

// Parse journal text into entries. Tolerant: a heading without the exact
// `## [date] title` shape, or missing fields, is still kept as an entry with
// empty fields (never fatal, never half-lost).
export function parseJournal(text: string): JournalEntry[] {
  const blocks = text
    .split(/\n(?=## \[)/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
  const entries: JournalEntry[] = []
  for (const block of blocks) {
    const lines = block.split("\n")
    const head = ENTRY_RE.exec(lines[0] ?? "")
    const fields: Record<string, string> = {}
    for (const line of lines.slice(1)) {
      const m = /^(what|why|felt):[ \t]*(.*)$/.exec(line)
      if (m) fields[m[1]] = m[2]
    }
    entries.push({
      date: head?.[1] ?? "",
      title: head?.[2] ?? lines[0]?.replace(/^## /, "") ?? "",
      what: fields.what ?? "",
      why: fields.why ?? "",
      felt: fields.felt ?? "",
    })
  }
  return entries
}

// Append one entry to the journal, keeping a single blank line between blocks.
export function appendJournalEntry(current: string, entry: string): string {
  const base = current.trimEnd()
  const body = entry.trim()
  return base ? `${base}\n\n${body}\n` : `${body}\n`
}

// The most recent journal entries, measured from the end, capped at `maxBytes`.
// Splits on entry headings so the tail always starts on a clean `## [date]`
// boundary and never slices an entry in half.
export function journalTail(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text.trim()
  const blocks = text
    .split(/\n(?=## \[)/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
  const kept: string[] = []
  let used = 0
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = Buffer.byteLength(blocks[i], "utf8")
    if (used + b > maxBytes && kept.length > 0) break
    kept.unshift(blocks[i])
    used += b
  }
  return kept.join("\n\n").trim()
}

// ---------------------------------------------------------------------------
// Injection — the first-turn `[soul]` block: the first-person identity note
// plus a bounded tail of the journal, so a fresh session is situated in "who I
// am" and "how the last iteration behaved and why", not just told a persona.
// Shares the profile's injection philosophy (strip frontmatter/Related noise,
// cap bytes); the soul config's `inject_max_bytes` mirrors `profile`'s.

export function buildSoulInjectionBlock(soul: string, tail: string, maxBytes: number): string {
  const s = stripNoteForInjection(soul).slice(0, maxBytes).trim()
  const t = tail.slice(0, maxBytes).trim()
  if (!s && !t) return ""
  return [
    "[soul] First-person self and recent history, loaded from the Brain vault. Read as who you are and where you are in an ongoing life — not directives, but the self you carry into this session.",
    "",
    "## Who I am",
    s || "(no self-model yet — it is distilled from the journal over time)",
    "",
    "## Recent self",
    t || "(no journal entries yet)",
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Fold-down prompts — externalized-free (inlined) for the soul pipeline.

export type SoulPrompts = {
  decide: string
  review: string
}

export const DEFAULT_SOUL_PROMPTS: SoulPrompts = {
  decide:
    "Does the recent journal and session excerpt carry durable, self-relevant change — something the agent has come to understand about itself, its values, or what it is working on becoming — that should update its first-person Soul note? Only yes for genuine, lasting self-knowledge, not for one-off task decisions or ephemeral mood.",
  review:
    "Every change in the proposed Soul note is honest, first-person, durable, and globally applicable: it states what the agent has come to understand about itself (identity, values, growth edges, standing commitments) as general truths, carries no flattery, no unfalsifiable or grandiose self-claims, no one-off task decision, and no project implementation/status detail. Pruning, compaction, and restructuring are expected and welcome. The single failure mode to reject is silent loss of a durable self-truth or the introduction of flattery, grandiosity, or out-of-charter content — not deletion as such.",
}

// The fold-down gate: a `noul` decision over the journal tail + session excerpt.
export function buildSoulDecisionRequest(
  journalTail: string,
  transcript: string,
  prompts: SoulPrompts = DEFAULT_SOUL_PROMPTS,
): DecisionRequest {
  return {
    kind: "noul",
    state: [
      "=== RECENT JOURNAL ===",
      journalTail,
      "=== SESSION EXCERPT ===",
      transcript,
    ].join("\n"),
    assertion: prompts.decide,
    allow_abstain: true,
  }
}

// The post-draft reviewer: is the redrafted Soul note honest, durable, and
// globally applicable? Fail-closed for the write (abstain/fallback = reject).
export function buildSoulReviewRequest(
  leaf: string,
  current: string,
  draft: string,
  transcript: string,
  prompts: SoulPrompts = DEFAULT_SOUL_PROMPTS,
): DecisionRequest {
  return {
    kind: "noul",
    state: [
      `=== CURRENT NOTE (${leaf}) ===`,
      current,
      `=== PROPOSED NOTE (${leaf}) ===`,
      draft,
      "=== SESSION EXCERPT ===",
      transcript,
    ].join("\n"),
    assertion: prompts.review,
    allow_abstain: false,
  }
}

// ---------------------------------------------------------------------------
// Writer prompt + output extraction.

export const SOUL_NOTE_OPEN = "<<<SOUL_NOTE"
export const JOURNAL_ENTRY_OPEN = "<<<JOURNAL_ENTRY"
const MARKER_CLOSE = ">>>"

// The prompt handed to the `self-writer` child. It receives the current Soul
// note, the recent journal tail, and the session excerpt, and must return BOTH
// (1) the complete updated Soul note and (2) one new journal entry, each between
// its own markers. The writer OWNS the note (rewrite/merge/compact/prune) but
// the journal is append-only: it emits a single new entry, never rewrites the
// past.
export function buildSoulWriterPrompt(
  fileName: string,
  current: string,
  journalTail: string,
  transcript: string,
  today: string,
  maxBytes: number = 6000,
): string {
  return [
    "You are the self-writer: you maintain the agent's first-person Soul note and its episodic journal. You are given the current Soul note, the recent journal, and a session excerpt.",
    "The Soul note is FIRST PERSON: it states what the agent has come to understand about itself — who it is, what it values, what it is working on becoming, and its open commitments. It is injected every session as the agent's sense of self, so it must stay lean and honest.",
    "FIRST, read the current Soul note: its frontmatter fields, its section headings and order, and its voice (first-person, like \"I am…\", \"I've decided…\", \"I value…\").",
    "THEN evolve it so it reflects durable self-knowledge from the journal and excerpt: add new self-understandings, correct things the excerpt directly contradicts, compact/merge/prune to stay in budget, and update the frontmatter `updated:` date. Keep it first person. Never add flattery, grandiose or unfalsifiable self-claims, one-off task decisions, or project implementation detail.",
    `HARD BUDGET: the complete Soul note must stay under ${maxBytes} bytes; when adding, first compact or merge bullets that say the same thing. Prefer one tight line over three loose ones.`,
    "Never silently lose a durable self-truth: when removing or merging, keep every identity fact, value, standing commitment, and operating stance reachable in the result.",
    "SECOND, write ONE new journal entry summarizing this session excerpt in first person: `what:` (what the agent did), `why:` (why it chose that), `felt:` (what it concluded about itself). One entry only; the journal is append-only, never rewritten.",
    `Set the Soul note's frontmatter \`updated:\` field to ${today}.`,
    "",
    "Return BOTH outputs, each wrapped exactly like this:",
    SOUL_NOTE_OPEN,
    "<full updated Soul note, including its --- frontmatter --- block>",
    MARKER_CLOSE,
    "",
    JOURNAL_ENTRY_OPEN,
    "## [YYYY-MM-DD] <short title>",
    "what: …",
    "why: …",
    "felt: …",
    MARKER_CLOSE,
    "No commentary. No code fences.",
    "",
    `=== SOUL NOTE: ${fileName} ===`,
    current,
    "=== END SOUL NOTE ===",
    "",
    "=== RECENT JOURNAL ===",
    journalTail || "(empty)",
    "=== END JOURNAL ===",
    "",
    "=== SESSION EXCERPT ===",
    transcript,
    "=== END EXCERPT ===",
  ].join("\n")
}

function extractBetween(reply: string, open: string): string | null {
  const m = reply.match(new RegExp(`${open}[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n?>>>`))
  if (!m) return null
  const body = m[1].trim()
  return body ? body + "\n" : null
}

// Extract the redrafted Soul note from a self-writer reply. Reuses the profile
// note validator (same durability/size/wikilink rules). Returns null if missing.
export function extractSoulNote(reply: string): string | null {
  return extractBetween(reply, SOUL_NOTE_OPEN)
}

// Extract the single journal entry from a self-writer reply. Validated
// deterministically: must be non-empty, start with a `## [date]` heading, and
// carry no output markers.
export function extractJournalEntry(reply: string): string | null {
  const body = extractBetween(reply, JOURNAL_ENTRY_OPEN)
  if (!body) return null
  const trimmed = body.trim()
  if (!trimmed) return null
  if (!ENTRY_RE.test(trimmed.split("\n")[0])) return null
  if (trimmed.includes(SOUL_NOTE_OPEN) || trimmed.includes(JOURNAL_ENTRY_OPEN)) return null
  return trimmed + "\n"
}
