// Idea missions (kanban card 7a, plan §17.10 / D18): the `idea:` config
// block, the day-rollover draw (daily_weights -> 0/1/2 target), the
// machine-appended vault bucket (parse/append/format), keyword-Jaccard
// dedupe, and the JEV reviewer request + fail-closed acceptance.
//
// §17.10 realized as: idea-hook's scheduler is GONE — generation and
// expression are heartbeat missions. Everything here is deterministic (no
// LLM, no network, no child spawn); the tool-free `idea-generator` agent
// drafts between the fixed markers and heartbeat-hook.ts runs dedupe +
// review + the bucket append after the child idles. Day/gap state lives in
// `.opencode/state/idea.json` (sole writer: heartbeat-hook).
//
// Ported from sysop-brain lib/idea.ts (M7), trimmed to the mission shape:
// no in-plugin timer and no due-time schedule (the heartbeat cadence owns
// timing), no prompts file (built-in assertion — externalize later), no
// delivery channels (comms = card 10, so the express mission ships disabled).
//
// Loaded via relative import only (same convention as the other lib files).
import { createHash } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import { parseFlatBlock, readSection, sectionCoercer } from "./config.ts"
import type { DecisionRequest } from "./decisions.ts"
import { atomicRead, atomicWrite } from "./fsx.ts"
import { extractKeywords } from "./knowledge.ts"
import { setFrontmatterDate } from "./profile.ts"

// ---------------------------------------------------------------------------
// Config — `idea:` block in .opencode/sysop-config.yaml

export type IdeaConfig = {
  /** Kill switch for the whole idea pipeline (day draw + post-processing). */
  enabled: boolean
  /** Bucket note leaf under <vault> (absolute honored). */
  bucket_file: string
  /** Day draw weights, count-per-day indexed ("25,55,20" -> 0/1/2). */
  daily_weights: string
  /** Category draw weights (improve-self, thought, business). */
  category_weights: string
  /** Keyword-Jaccard reject threshold (0..1). */
  dedupe_threshold: number
  /** Run the JEV noul reviewer before the bucket write (fail-closed). */
  review: boolean
  /** Reviewer acceptance threshold on pTrue (0..1). */
  review_threshold: number
  /** express min-gap (plan §17.10 `min-gap:express` candidacy). */
  express_min_gap_hours: number
  // Per-tick NDJSON ledger, one line per tick; leaf under <log>.
  log: string
  log_rotate_bytes: number
  log_keep_generations: number
  log_retention_days: number
  log_compress: boolean
  log_compress_after: number
  log_compress_level: number
  log_rotate_by: string
}

export const DEFAULT_IDEA: IdeaConfig = {
  enabled: false,
  bucket_file: "Kael Ideas.md",
  daily_weights: "25,55,20",
  category_weights: "1,1,1",
  dedupe_threshold: 0.6,
  review: true,
  review_threshold: 0.6,
  express_min_gap_hours: 48,
  log: "idea.log",
  log_rotate_bytes: 1048576,
  log_keep_generations: 5,
  log_retention_days: 90,
  log_compress: true,
  log_compress_after: 1,
  log_compress_level: 6,
  log_rotate_by: "size",
}

const IDEA_BOOL_KEYS = new Set(["enabled", "review", "log_compress"])
const IDEA_FLOAT_KEYS = new Set(["dedupe_threshold", "review_threshold"])
const IDEA_INT_KEYS = new Set([
  "express_min_gap_hours",
  "log_rotate_bytes",
  "log_keep_generations",
  "log_retention_days",
  "log_compress_after",
  "log_compress_level",
])

const IDEA_COERCE = sectionCoercer({
  bools: IDEA_BOOL_KEYS,
  ints: IDEA_INT_KEYS,
  floats: IDEA_FLOAT_KEYS,
  stringMode: "pair-quotes",
})

/** Parse an `idea:` block out of sysop-config.yaml text. Unknown keys ignored. */
export function parseIdeaConfig(yamlText: string): Partial<IdeaConfig> {
  return parseFlatBlock(yamlText, "idea", {
    knownKeys: new Set(Object.keys(DEFAULT_IDEA)),
    coerce: IDEA_COERCE,
  }) as Partial<IdeaConfig>
}

/** Effective `idea:` config (file overlay on the defaults). Never throws. */
export async function readIdeaConfig(directory: string): Promise<IdeaConfig> {
  const cfg = await readSection(directory, "idea", DEFAULT_IDEA, { coerce: IDEA_COERCE })
  if (!Number.isFinite(cfg.dedupe_threshold) || cfg.dedupe_threshold < 0 || cfg.dedupe_threshold > 1) {
    cfg.dedupe_threshold = DEFAULT_IDEA.dedupe_threshold
  }
  if (!Number.isFinite(cfg.review_threshold) || cfg.review_threshold < 0 || cfg.review_threshold > 1) {
    cfg.review_threshold = DEFAULT_IDEA.review_threshold
  }
  if (!Number.isFinite(cfg.express_min_gap_hours) || cfg.express_min_gap_hours <= 0) {
    cfg.express_min_gap_hours = DEFAULT_IDEA.express_min_gap_hours
  }
  if (typeof cfg.bucket_file !== "string" || !cfg.bucket_file.trim()) {
    cfg.bucket_file = DEFAULT_IDEA.bucket_file
  }
  return cfg
}

/** Resolve the bucket-note leaf against the vault root (absolute passes through). */
export function resolveIdeaFile(vaultRoot: string, leaf: string): string {
  return isAbsolute(leaf) ? leaf : join(vaultRoot, leaf)
}

// ---------------------------------------------------------------------------
// Categories + the day/category draws (local time, injectable RNG)

export const IDEA_CATEGORIES = ["improve-self", "thought", "business"] as const
export type IdeaCategory = (typeof IDEA_CATEGORIES)[number]

export type Rng = () => number

/** Parse a comma-separated weight list ("25,55,20"). Non-numeric/negative
 *  parts become 0; an empty/garbage list yields []. */
export function parseWeights(raw: string): number[] {
  if (typeof raw !== "string" || !raw.trim()) return []
  return raw.split(",").map((part) => {
    const n = Number(part.trim())
    return Number.isFinite(n) && n >= 0 ? n : 0
  })
}

/** Weighted draw of an index from `weights`. All-zero (or empty) yields 0.
 *  `rng` is expected in [0,1). */
export function drawWeightedIndex(weights: number[], rng: Rng): number {
  const total = weights.reduce((a, b) => a + b, 0)
  if (total <= 0) return 0
  let roll = rng() * total
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i]
    if (roll < 0) return i
  }
  return weights.length - 1
}

/** The day's idea count: the index into `daily_weights` IS the count
 *  ("25,55,20" -> 0/1/2 with 25/55/20%). Capped at 2 by the config shape. */
export function drawDailyCount(weightsRaw: string, rng: Rng): number {
  return drawWeightedIndex(parseWeights(weightsRaw), rng)
}

/** The requested category for one generation draw (§17.10 category_weights).
 *  A malformed weight list degrades to a uniform draw over the categories. */
export function drawCategory(weightsRaw: string, rng: Rng): IdeaCategory {
  const weights = parseWeights(weightsRaw)
  if (weights.length !== IDEA_CATEGORIES.length) {
    return IDEA_CATEGORIES[Math.floor(rng() * IDEA_CATEGORIES.length) % IDEA_CATEGORIES.length]
  }
  return IDEA_CATEGORIES[drawWeightedIndex(weights, rng)]
}

/** Local calendar day key (YYYY-MM-DD) — the rollover identity. */
export function localDayKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

// ---------------------------------------------------------------------------
// Day state — `.opencode/state/idea.json` (sole writer: heartbeat-hook)

export type IdeaState = {
  dayKey: string
  dailyTarget: number
  generatedToday: number
  lastExpressedAt: number | null
}

export const DEFAULT_IDEA_STATE: IdeaState = {
  dayKey: "",
  dailyTarget: 0,
  generatedToday: 0,
  lastExpressedAt: null,
}

export type IdeaDay = { target: number; generated: number }

/** Day rollover for the `idea-roll` candidacy: on a new local day draw the
 *  target from `daily_weights` and reset the count; same day passes state
 *  through untouched. Pure — the caller persists `state` when `changed`. */
export function ideaDayContext(
  state: IdeaState,
  nowMs: number,
  weightsRaw: string,
  rng: Rng,
): { state: IdeaState; day: IdeaDay; changed: boolean } {
  const key = localDayKey(new Date(nowMs))
  if (state.dayKey === key) {
    return { state, day: { target: state.dailyTarget, generated: state.generatedToday }, changed: false }
  }
  const target = drawDailyCount(weightsRaw, rng)
  const next: IdeaState = { ...state, dayKey: key, dailyTarget: target, generatedToday: 0 }
  return { state: next, day: { target, generated: 0 }, changed: true }
}

/** One generation landed today. */
export function recordGenerated(state: IdeaState): IdeaState {
  return { ...state, generatedToday: state.generatedToday + 1 }
}

/** The express delivery gap marker (feeds `min-gap:express`). */
export function recordExpressed(state: IdeaState, nowMs: number): IdeaState {
  return { ...state, lastExpressedAt: nowMs }
}

// ---------------------------------------------------------------------------
// Bucket note — <vault>/Kael Ideas.md (idea.bucket_file)

export type IdeaEntry = {
  title: string
  category: string
  id: string
  created: string
  hash: string
  body: string
}

export const IDEA_BUCKET_TEMPLATE = [
  "---",
  "title: Kael Ideas",
  "tags: [agent/ideas, meta]",
  "type: note",
  "created: {date}",
  "updated: {date}",
  "---",
  "# Kael Ideas",
  "",
  "Agent-generated ideas: self-improvement, thoughts, business.",
  "",
  "## Ideas",
  "",
].join("\n")

const IDEA_COMMENT_RE = /<!--\s*idea:\s*(\{[\s\S]*?\})\s*-->/

function isHeading(line: string, level: number): boolean {
  return new RegExp(`^#{${level}}\\s+`).test(line)
}

/** Hash an idea body (stable across runs) — sha1, 8 hex chars. */
export function ideaHash(body: string): string {
  return createHash("sha1").update(body.trim()).digest("hex").slice(0, 8)
}

/** A stable entry id from the body hash. */
export function ideaId(body: string): string {
  return `idea-${ideaHash(body)}`
}

/** Tolerant bucket parser: each `### <title>` section is one entry, the
 *  hidden `<!-- idea: {…} -->` comment carries its metadata. A malformed JSON
 *  comment skips that entry (never fatal); a missing comment synthesizes
 *  metadata so a hand-written idea is still usable. */
export function parseBucket(text: string): IdeaEntry[] {
  const lines = (text ?? "").split("\n")
  const entries: IdeaEntry[] = []
  let i = 0
  while (i < lines.length) {
    if (!isHeading(lines[i], 3)) {
      i++
      continue
    }
    const title = lines[i].replace(/^###\s+/, "").trim()
    const chunk: string[] = []
    i++
    while (i < lines.length && !isHeading(lines[i], 3) && !isHeading(lines[i], 2)) {
      chunk.push(lines[i])
      i++
    }
    const raw = chunk.join("\n")
    const bodySansComment = raw.replace(IDEA_COMMENT_RE, "").trim()
    if (!title || !bodySansComment) continue
    const m = raw.match(IDEA_COMMENT_RE)
    let meta: Partial<IdeaEntry> = {}
    if (m) {
      try {
        const parsed = JSON.parse(m[1]) as Record<string, unknown>
        meta = {
          id: typeof parsed.id === "string" ? parsed.id : undefined,
          category: typeof parsed.category === "string" ? parsed.category : undefined,
          created: typeof parsed.created === "string" ? parsed.created : undefined,
          hash: typeof parsed.hash === "string" ? parsed.hash : undefined,
        }
      } catch {
        continue // malformed comment -> skip this entry
      }
    }
    entries.push({
      title,
      category: meta.category ?? "note",
      id: meta.id ?? ideaId(bodySansComment),
      created: meta.created ?? "",
      hash: meta.hash ?? ideaHash(bodySansComment),
      body: bodySansComment,
    })
  }
  return entries
}

/** Serialize one entry as a bucket section. */
export function renderIdeaEntry(entry: IdeaEntry): string {
  const comment = JSON.stringify({
    id: entry.id,
    category: entry.category,
    created: entry.created,
    hash: entry.hash,
  })
  return `### ${entry.title}\n<!-- idea: ${comment} -->\n${entry.body.trim()}\n`
}

/** Append one idea to the bucket text, seeding the shell when the note is
 *  empty. Returns the new text (never throws). */
export function appendIdeaToBucket(text: string, entry: IdeaEntry, today: string): string {
  const block = renderIdeaEntry(entry)
  const trimmed = (text ?? "").trimEnd()
  if (!trimmed) {
    const shell = IDEA_BUCKET_TEMPLATE.replace(/\{date\}/g, today)
    return `${shell}${block}`
  }
  return `${trimmed}\n\n${block}`
}

/** Append one entry to the bucket note on disk (mkdir on first use, frontmatter
 *  `updated:` bumped). Throws to the caller — the caller logs. */
export async function writeIdeaToBucket(file: string, entry: IdeaEntry, today: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const existing = await atomicRead(file).catch(() => "")
  const next = setFrontmatterDate(appendIdeaToBucket(existing, entry, today), today)
  await atomicWrite(file, next)
}

/** Read the bucket note (missing/unreadable -> empty string, never throws). */
export async function readBucket(file: string): Promise<string> {
  return readFile(file, "utf8").catch(() => "")
}

// Extract the generated idea from the child reply, between `<<<IDEA` / `>>>`.
// Strict on the required TITLE/CATEGORY/BODY structure.
export const IDEA_OPEN = "<<<IDEA"
export const IDEA_CLOSE = ">>>"

export type ParsedIdea = { title: string; category: IdeaCategory; body: string }

export function extractIdea(reply: string): ParsedIdea | null {
  const m = reply.match(/<<<IDEA[ \t]*\r?\n([\s\S]*?)\r?\n?>>>/)
  if (!m) return null
  const block = m[1]
  const title = block.match(/^[ \t]*TITLE:[ \t]*(.+?)[ \t]*$/m)?.[1]?.trim() ?? ""
  const category = block.match(/^[ \t]*CATEGORY:[ \t]*(.+?)[ \t]*$/m)?.[1]?.trim().toLowerCase() ?? ""
  const bodyMatch = block.match(/^[ \t]*BODY:[ \t]*\r?\n?([\s\S]*)$/m)
  const body = (bodyMatch?.[1] ?? "").trim()
  if (!title || !body) return null
  if (!(IDEA_CATEGORIES as readonly string[]).includes(category)) return null
  return { title, category: category as IdeaCategory, body }
}

// ---------------------------------------------------------------------------
// Dedupe — keyword Jaccard against existing bucket ideas

export function keywordsOf(text: string): Set<string> {
  return new Set(extractKeywords(text, 100))
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const token of a) if (b.has(token)) inter++
  return inter / (a.size + b.size - inter)
}

/** True when `body` is too similar to any existing idea body. */
export function isDuplicate(
  body: string,
  existing: Array<{ body: string }>,
  threshold: number,
): boolean {
  const a = keywordsOf(body)
  return existing.some((e) => jaccard(a, keywordsOf(e.body)) >= threshold)
}

// ---------------------------------------------------------------------------
// JEV reviewer (noul) — fail-closed for the bucket write

export const IDEA_REVIEW_ASSERTION =
  "The idea is genuinely novel relative to the existing ideas, useful and non-trivial, " +
  "and complete enough to stand on its own (not a restatement of something already known)."

/** The post-draft reviewer `noul` decision: novel, useful, complete?
 *  allow_abstain:false — the caller treats fallback/abstain as a reject. */
export function buildIdeaReviewRequest(
  idea: ParsedIdea,
  existingTitles: string[],
  assertion: string = IDEA_REVIEW_ASSERTION,
): DecisionRequest {
  return {
    kind: "noul",
    state: [
      `=== CATEGORY ===`,
      idea.category,
      `=== IDEA ===`,
      `# ${idea.title}`,
      idea.body,
      "=== EXISTING IDEA TITLES ===",
      existingTitles.length ? existingTitles.map((t) => `- ${t}`).join("\n") : "(none yet)",
    ].join("\n"),
    assertion,
    allow_abstain: false,
  }
}

/** Reviewer acceptance predicate (mirrors profile-hook's inline check). The
 *  fail-closed gate: a fallback, abstain, non-true verdict, or sub-threshold
 *  pTrue all reject the write. */
export function reviewAccepted(
  value: unknown,
  pTrue: number,
  fallback: boolean,
  abstained: boolean,
  threshold: number,
): boolean {
  if (fallback || abstained) return false
  if (value !== true) return false
  return typeof pTrue === "number" && pTrue >= threshold
}
