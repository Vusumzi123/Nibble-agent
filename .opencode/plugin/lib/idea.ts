// Idea-hook helpers: config parsing, the externalized prompts file, the
// time-of-day schedule (daily draw + due times), the machine-appended vault
// bucket parse/append/format, keyword-Jaccard dedupe, and the generator prompt +
// JEV reviewer request builders.
//
// Everything here is deterministic and side-effect-light (no LLM, no network)
// except the pure string helpers. The child spawn and the bucket write live in
// idea-hook.ts; this module stays unit-testable without a live client. See
// docs/idea-hook-plan.md.
//
// Loaded via relative import only (same convention as the other lib files).
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { extractKeywords } from "./autonomy.ts"
import { parseFlatBlock, readSection, sectionCoercer } from "./config.ts"
import { expandHome } from "./paths.ts"
import { setFrontmatterDate, splitWriterModel } from "./profile.ts"
import type { DecisionRequest } from "./decisions.ts"

export { setFrontmatterDate, splitWriterModel }

// ---------------------------------------------------------------------------
// Config — `idea:` block in .opencode/sysop-config.yaml

export type IdeaConfig = {
  enabled: boolean
  bucket_file: string
  generator_agent: string
  generator_model: string
  child_timeout_ms: number
  interval_ms: number
  active_start_hour: number
  active_end_hour: number
  daily_weights: string
  category_weights: string
  seed_notes: number
  context_turns: number
  context_max_bytes: number
  note_max_bytes: number
  dedupe_threshold: number
  review: boolean
  review_threshold: number
  prompts_file: string
  notify: boolean
  // expression (read by the standalone script)
  express_min_gap_hours: number
  express_token_file: string
  express_chat_id_file: string
  express_parse_mode: string
  express_telegram: boolean
  express_email: boolean
  express_email_to: string
  express_email_bin: string
  // logs
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
  bucket_file: "Ideas.md",
  generator_agent: "idea-generator",
  generator_model: "deepseek/deepseek-flash",
  child_timeout_ms: 90000,
  interval_ms: 900000,
  active_start_hour: 9,
  active_end_hour: 23,
  daily_weights: "25,55,20",
  category_weights: "1,1,1",
  seed_notes: 1,
  context_turns: 4,
  context_max_bytes: 12000,
  note_max_bytes: 8000,
  dedupe_threshold: 0.6,
  review: true,
  review_threshold: 0.6,
  prompts_file: ".opencode/idea-prompts.json",
  notify: true,
  express_min_gap_hours: 48,
  express_token_file: "~/.config/update-reminder/telegram-token",
  express_chat_id_file: "~/.config/update-reminder/telegram-chat-id",
  express_parse_mode: "Markdown",
  express_telegram: true,
  express_email: true,
  express_email_to: "",
  express_email_bin: "msmtp",
  log: "idea-hook.log",
  log_rotate_bytes: 1048576,
  log_keep_generations: 5,
  log_retention_days: 90,
  log_compress: true,
  log_compress_after: 1,
  log_compress_level: 6,
  log_rotate_by: "size",
}

const KNOWN_KEYS = new Set(Object.keys(DEFAULT_IDEA))
const BOOL_KEYS = new Set([
  "enabled",
  "review",
  "notify",
  "express_telegram",
  "express_email",
  "log_compress",
])
const FLOAT_KEYS = new Set(["dedupe_threshold", "review_threshold"])
const INT_KEYS = new Set([
  "child_timeout_ms",
  "interval_ms",
  "active_start_hour",
  "active_end_hour",
  "seed_notes",
  "context_turns",
  "context_max_bytes",
  "note_max_bytes",
  "express_min_gap_hours",
  "log_rotate_bytes",
  "log_keep_generations",
  "log_retention_days",
  "log_compress_after",
  "log_compress_level",
])

const IDEA_COERCE = sectionCoercer({
  bools: BOOL_KEYS,
  ints: INT_KEYS,
  floats: FLOAT_KEYS,
  stringMode: "pair-quotes",
})

// Parse an `idea:` block out of sysop-config.yaml text. Only flat `key: value`
// scalars are supported. Unrecognized keys are ignored.
export function parseIdeaConfig(yamlText: string): Partial<IdeaConfig> {
  return parseFlatBlock(yamlText, "idea", {
    knownKeys: KNOWN_KEYS,
    coerce: IDEA_COERCE,
  }) as Partial<IdeaConfig>
}

// Read the effective `idea:` config for a project directory, overlaying the
// block on the defaults. Never throws: a missing or malformed config yields the
// defaults.
export async function readIdeaConfig(directory: string): Promise<IdeaConfig> {
  const cfg = await readSection(directory, "idea", DEFAULT_IDEA, { coerce: IDEA_COERCE })
  if (!Number.isFinite(cfg.dedupe_threshold) || cfg.dedupe_threshold < 0 || cfg.dedupe_threshold > 1) {
    cfg.dedupe_threshold = DEFAULT_IDEA.dedupe_threshold
  }
  if (!Number.isFinite(cfg.review_threshold) || cfg.review_threshold < 0 || cfg.review_threshold > 1) {
    cfg.review_threshold = DEFAULT_IDEA.review_threshold
  }
  if (!Number.isFinite(cfg.interval_ms) || cfg.interval_ms < 1000) {
    cfg.interval_ms = DEFAULT_IDEA.interval_ms
  }
  if (
    !Number.isFinite(cfg.active_start_hour) ||
    !Number.isFinite(cfg.active_end_hour) ||
    cfg.active_start_hour < 0 ||
    cfg.active_end_hour > 24 ||
    cfg.active_end_hour <= cfg.active_start_hour
  ) {
    cfg.active_start_hour = DEFAULT_IDEA.active_start_hour
    cfg.active_end_hour = DEFAULT_IDEA.active_end_hour
  }
  if (typeof cfg.bucket_file !== "string" || !cfg.bucket_file.trim()) {
    cfg.bucket_file = DEFAULT_IDEA.bucket_file
  }
  if (typeof cfg.prompts_file !== "string" || !cfg.prompts_file.trim()) {
    cfg.prompts_file = DEFAULT_IDEA.prompts_file
  }
  return cfg
}

// Resolve the bucket-note leaf against the vault root. Absolute leaves pass
// through unchanged (config override).
export function resolveIdeaFile(vaultRoot: string, leaf: string): string {
  return isAbsolute(leaf) ? leaf : join(vaultRoot, leaf)
}

// Resolve the idea prompts-file leaf. Absolute paths pass through; a leading
// `~` is home-expanded; anything else is project-relative.
export function resolveIdeaPrompts(directory: string, leaf: string): string {
  const expanded = expandHome(leaf, homedir())
  return isAbsolute(expanded) ? expanded : join(directory, expanded)
}

// ---------------------------------------------------------------------------
// Externalized prompts (`.opencode/idea-prompts.json`)

export const IDEA_CATEGORIES = ["improve-self", "thought", "business"] as const
export type IdeaCategory = (typeof IDEA_CATEGORIES)[number]

export type IdeaPrompts = {
  generate: { instructions: string; criteria: Record<IdeaCategory, string> }
  review: { assertion: string }
}

export const DEFAULT_IDEA_PROMPTS: IdeaPrompts = {
  generate: {
    instructions:
      "Write one original, self-contained idea in the requested category. It must be concrete and worth acting on, not a vague musing.",
    criteria: {
      "improve-self":
        "a concrete way to improve the agent's own code, reliability, security, or autonomy",
      thought:
        "an interesting observation, question, or reflection grounded in what the agent knows",
      business:
        "a plausible product, service, or revenue idea the user could pursue",
    },
  },
  review: {
    assertion:
      "The idea is genuinely novel relative to the existing ideas, useful and non-trivial, and complete enough to stand on its own (not a restatement of something already known).",
  },
}

// Validate a parsed prompts file. Strict: required keys present, exactly the
// known categories, every string non-empty. Returns null on deviation so the
// caller falls back to DEFAULT_IDEA_PROMPTS.
export function parseIdeaPrompts(json: unknown): IdeaPrompts | null {
  if (!json || typeof json !== "object") return null
  const root = json as Record<string, unknown>
  const generate = root.generate
  const review = root.review
  if (!generate || typeof generate !== "object" || !review || typeof review !== "object") return null
  const g = generate as Record<string, unknown>
  const r = review as Record<string, unknown>
  if (typeof g.instructions !== "string" || !g.instructions.trim()) return null
  if (typeof r.assertion !== "string" || !r.assertion.trim()) return null
  const criteriaRaw = g.criteria
  if (!criteriaRaw || typeof criteriaRaw !== "object" || Array.isArray(criteriaRaw)) return null
  const criteria = {} as Record<IdeaCategory, string>
  for (const cat of IDEA_CATEGORIES) {
    const value = (criteriaRaw as Record<string, unknown>)[cat]
    if (typeof value !== "string" || !value.trim()) return null
    criteria[cat] = value
  }
  return { generate: { instructions: g.instructions, criteria }, review: { assertion: r.assertion } }
}

// Read + parse the prompts file. Never throws: a missing/unreadable/malformed
// file yields null and the caller uses the built-in defaults.
export async function readIdeaPrompts(file: string): Promise<IdeaPrompts | null> {
  try {
    return parseIdeaPrompts(JSON.parse(await readFile(file, "utf8")))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Schedule — daily draw + due times (local time, injectable RNG)

export type Rng = () => number

// Parse a comma-separated weight list ("25,55,20"). Non-numeric/negative parts
// become 0; an empty/garbage list yields [].
export function parseWeights(raw: string): number[] {
  if (typeof raw !== "string" || !raw.trim()) return []
  return raw.split(",").map((part) => {
    const n = Number(part.trim())
    return Number.isFinite(n) && n >= 0 ? n : 0
  })
}

// Weighted draw of an index from `weights`. All-zero (or empty) weights yield 0.
// `rng` is expected in [0,1).
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

// Draw the day's idea count: index into `daily_weights` is the count itself
// (e.g. "25,55,20" -> 0/1/2 with 25/55/20%). The draw is capped at 2 by the
// config shape.
export function drawDailyCount(weightsRaw: string, rng: Rng): number {
  const weights = parseWeights(weightsRaw)
  return drawWeightedIndex(weights, rng)
}

// Draw `count` distinct due timestamps (ms) uniformly in
// [startHour, endHour) on the local day of `base`, sorted ascending.
export function drawDueTimes(base: Date, count: number, startHour: number, endHour: number, rng: Rng): number[] {
  if (count <= 0) return []
  const day = new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime()
  const spanMs = (endHour - startHour) * 3600_000
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    out.push(day + startHour * 3600_000 + Math.floor(rng() * spanMs))
  }
  return out.sort((a, b) => a - b)
}

// Local calendar day key (YYYY-MM-DD) — the rollover identity.
export function localDayKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

// True when `date`'s local hour falls in [startHour, endHour).
export function isInActiveWindow(date: Date, startHour: number, endHour: number): boolean {
  const h = date.getHours()
  return h >= startHour && h < endHour
}

// True when the next un-generated due time has passed. `generatedToday` is the
// count already produced today; a fully-consumed schedule is never due.
export function isDue(dueAt: number[], generatedToday: number, now: number): boolean {
  if (generatedToday < 0 || generatedToday >= dueAt.length) return false
  return now >= dueAt[generatedToday]
}

// ---------------------------------------------------------------------------
// Bucket note — Brain/Ideas.md (idea.bucket_file)

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
  "title: Ideas",
  "tags: [agent/ideas, meta]",
  "type: note",
  "created: {date}",
  "updated: {date}",
  "---",
  "# Ideas",
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

// Hash an idea body (stable across runs) — sha1, 8 hex chars.
export function ideaHash(body: string): string {
  return createHash("sha1").update(body.trim()).digest("hex").slice(0, 8)
}

// Build a stable entry id from the body hash.
export function ideaId(body: string): string {
  return `idea-${ideaHash(body)}`
}

// Tolerant bucket parser. Each `### <title>` section becomes one entry; the
// hidden `<!-- idea: {…} -->` comment carries its metadata. A malformed JSON
// comment skips that entry (never fatal); a missing comment falls back to
// synthesized metadata so a hand-written idea is still usable.
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

// Serialize one entry as a bucket section.
export function renderIdeaEntry(entry: IdeaEntry): string {
  const comment = JSON.stringify({
    id: entry.id,
    category: entry.category,
    created: entry.created,
    hash: entry.hash,
  })
  return `### ${entry.title}\n<!-- idea: ${comment} -->\n${entry.body.trim()}\n`
}

// Append one idea to the bucket text, seeding the shell when the note is empty.
// Returns the new text (never throws).
export function appendIdeaToBucket(text: string, entry: IdeaEntry, today: string): string {
  const block = renderIdeaEntry(entry)
  const trimmed = (text ?? "").trimEnd()
  if (!trimmed) {
    const shell = IDEA_BUCKET_TEMPLATE.replace(/\{date\}/g, today)
    return `${shell}${block}`
  }
  return `${trimmed}\n\n${block}`
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

// True when `body` is too similar to any existing idea body.
export function isDuplicate(
  body: string,
  existing: Array<{ body: string }>,
  threshold: number,
): boolean {
  const a = keywordsOf(body)
  return existing.some((e) => jaccard(a, keywordsOf(e.body)) >= threshold)
}

// ---------------------------------------------------------------------------
// Prompt + decision builders

export type GenerateContext = {
  category: IdeaCategory
  criteria: string
  instructions: string
  transcript: string
  seed: string
  existingTitles: string[]
  today: string
  categoryWeights: string
  transcriptMaxBytes: number
}

// The prompt handed to the idea-generator child. Tool-free; returns the idea
// between the fixed markers.
export function buildGeneratePrompt(ctx: GenerateContext): string {
  const titles = ctx.existingTitles.slice(0, 40)
  return [
    "You generate one original idea for the agent's personal idea log.",
    ctx.instructions,
    "",
    `Write for the category: ${ctx.category}.`,
    `Category guidance: ${ctx.criteria}`,
    "",
    "Ground the idea in the material below where relevant, but do not merely restate it.",
    "Do not duplicate any of the existing idea titles.",
    "",
    "Return ONLY the idea, wrapped exactly like this:",
    IDEA_OPEN,
    "TITLE: <one short title line>",
    `CATEGORY: ${ctx.category}`,
    "BODY:",
    "<the idea body, a few short paragraphs or bullets of markdown>",
    IDEA_CLOSE,
    "No commentary. No code fences.",
    "",
    "=== RECENT CONVERSATION ===",
    ctx.transcript.slice(0, ctx.transcriptMaxBytes),
    "=== END CONVERSATION ===",
    "",
    "=== KNOWLEDGE SEED ===",
    ctx.seed,
    "=== END KNOWLEDGE SEED ===",
    "",
    "=== EXISTING IDEA TITLES ===",
    titles.length ? titles.map((t) => `- ${t}`).join("\n") : "(none yet)",
    "=== END EXISTING IDEA TITLES ===",
  ].join("\n")
}

// The post-draft reviewer `noul` decision: is the idea novel, useful, and
// complete? allow_abstain:false — an abstain is handled by the caller as a
// reject (fail-closed for the storage).
export function buildIdeaReviewRequest(
  idea: ParsedIdea,
  existingTitles: string[],
  prompts: IdeaPrompts = DEFAULT_IDEA_PROMPTS,
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
    assertion: prompts.review.assertion,
    allow_abstain: false,
  }
}

// Acceptance predicate for the reviewer gate (mirrors profile-hook's inline
// check + decisions.isGateSkip). Fail-closed: a fallback, abstain, missing
// verdict, or sub-threshold probability all reject.
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

export type IdeaHookState = {
  dayKey: string
  dailyTarget: number
  generatedToday: number
  dueAt: number[]
  lastGeneratedAt: number | null
  passSeq: number
}

export const DEFAULT_IDEA_HOOK_STATE: IdeaHookState = {
  dayKey: "",
  dailyTarget: 0,
  generatedToday: 0,
  dueAt: [],
  lastGeneratedAt: null,
  passSeq: 0,
}
