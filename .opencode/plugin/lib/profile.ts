// Profile-hook helpers: config parsing, the externalized prompts file, the
// first-turn system-prompt block, the JEV choice + reviewer decision requests,
// and the pure extract/validate/rewrite helpers used by the direct profile-note
// write path.
//
// Everything here is deterministic and side-effect-light (no LLM, no network)
// except `atomicWriteFile`. The decision call and the profile-writer child live
// in profile-hook.ts; this module stays unit-testable without a live client.
//
// Loaded via relative import only (same convention as the other lib files).
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { expandHome } from "./paths.ts"
import { parseFlatBlock, readSection, sectionCoercer } from "./config.ts"
import { createNotifier } from "./notify.ts"
import type { DecisionRequest } from "./decisions.ts"

export type ProfileConfig = {
  enabled: boolean
  agent_file: string
  user_file: string
  inject: boolean
  inject_max_bytes: number
  decide: boolean
  cooldown_turns: number
  decision_turns: number
  decision_max_bytes: number
  skip_triage: boolean
  skip_triage_max_bytes: number
  notify: boolean
  writer_agent: string
  writer_model: string
  child_timeout_ms: number
  note_max_bytes: number
  prompts_file: string
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

export const DEFAULT_PROFILE: ProfileConfig = {
  enabled: true,
  agent_file: "Agent.md",
  user_file: "User.md",
  inject: true,
  inject_max_bytes: 4000,
  decide: true,
  cooldown_turns: 3,
  decision_turns: 3,
  decision_max_bytes: 24000,
  skip_triage: true,
  skip_triage_max_bytes: 800,
  notify: true,
  writer_agent: "profile-writer",
  writer_model: "deepseek/deepseek-flash",
  child_timeout_ms: 90000,
  note_max_bytes: 6000,
  prompts_file: ".opencode/profile-prompts.json",
  review: true,
  review_threshold: 0.6,
  log: "profile-hook.log",
  log_rotate_bytes: 1048576,
  log_keep_generations: 5,
  log_retention_days: 90,
  log_compress: true,
  log_compress_after: 1,
  log_compress_level: 6,
  log_rotate_by: "size",
}

const KNOWN_KEYS = new Set(Object.keys(DEFAULT_PROFILE))
const BOOL_KEYS = new Set([
  "enabled",
  "inject",
  "decide",
  "skip_triage",
  "notify",
  "review",
  "log_compress",
])
const FLOAT_KEYS = new Set(["review_threshold"])
const INT_KEYS = new Set([
  "inject_max_bytes",
  "cooldown_turns",
  "decision_turns",
  "decision_max_bytes",
  "skip_triage_max_bytes",
  "child_timeout_ms",
  "note_max_bytes",
  "log_rotate_bytes",
  "log_keep_generations",
  "log_retention_days",
  "log_compress_after",
  "log_compress_level",
])

// `profile:` strips any quotes before type checks, so `"true"` is a boolean and
// `""` is dropped; its float key accepts anything `Number` can parse.
const PROFILE_COERCE = sectionCoercer({
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

// Parse a `profile:` block out of sysop-config.yaml text. Only flat `key:
// value` scalars are supported. Unrecognized keys are ignored.
export function parseProfileConfig(yamlText: string): Partial<ProfileConfig> {
  return parseFlatBlock(yamlText, "profile", {
    knownKeys: KNOWN_KEYS,
    coerce: PROFILE_COERCE,
  }) as Partial<ProfileConfig>
}

// Read the effective `profile:` config for a project directory, overlaying the
// block on the defaults. Never throws: a missing or malformed config yields the
// defaults.
export async function readProfileConfig(directory: string): Promise<ProfileConfig> {
  const cfg = await readSection(directory, "profile", DEFAULT_PROFILE, {
    coerce: PROFILE_COERCE,
  })
  if (!Number.isFinite(cfg.review_threshold) || cfg.review_threshold < 0 || cfg.review_threshold > 1) {
    cfg.review_threshold = DEFAULT_PROFILE.review_threshold
  }
  if (typeof cfg.prompts_file !== "string" || !cfg.prompts_file.trim()) {
    cfg.prompts_file = DEFAULT_PROFILE.prompts_file
  }
  return cfg
}

// Resolve the profile prompts-file leaf. Absolute paths pass through; a leading
// `~` is home-expanded; anything else is project-relative.
export function resolveProfilePrompts(directory: string, leaf: string): string {
  const expanded = expandHome(leaf, homedir())
  return isAbsolute(expanded) ? expanded : join(directory, expanded)
}

// Resolve a profile-note leaf against the vault root. Absolute leaves pass
// through unchanged (config override).
export function resolveProfileFile(vaultRoot: string, leaf: string): string {
  return isAbsolute(leaf) ? leaf : join(vaultRoot, leaf)
}

// ---------------------------------------------------------------------------
// Externalized prompts (`.opencode/profile-prompts.json`)
//
// The `choice` gate's candidate set is the criteria keys, so they must remain
// exactly none/agent/user/both (the server maps keys -> candidates via
// `_choice_from_criteria`); parseProfilePrompts rejects anything else. The
// `noul` reviewer ignores `criteria`, so its guidance lives in `review.assertion`.

export const CHOICE_KEYS = ["none", "agent", "user", "both"] as const

export type ProfilePrompts = {
  choice: { instructions: string; criteria: Record<string, string> }
  review: { assertion: string }
}

export const DEFAULT_PROFILE_PROMPTS: ProfilePrompts = {
  choice: {
    instructions: "Which pairing profile note(s), if any, should be updated from this exchange?",
    criteria: {
      none: "no durable, lasting information; reserve for exchanges with nothing worth remembering",
      agent: "agent persona or behavior traits (voice, style, operating rules, personality)",
      user: "user identity, preferences, stack, projects, career, hardware",
      both: "spans persona and user facts",
    },
  },
  review: {
    assertion:
      "Every change in the proposed note — additions, updates, merges, and removals alike — is consistent with the note's charter: the note curates durable, globally-applicable facts and standing preferences (identity, contact, stack, career, persona/behavior traits, response-style rules phrased as general rules), and carries no one-off task decision, session-specific instruction, project status/implementation detail, or job-application record. Pruning, compaction, and restructuring are expected and welcome; a removal is acceptable when the content is redundant, stale, out of charter, or its facts remain reachable elsewhere in the note. The single failure mode to reject is silent loss of a durable fact or the introduction of out-of-charter content — not deletion as such.",
  },
}

// Validate a parsed prompts file. Strict: required keys must all be present, no
// unknown candidate keys, and every string must be non-empty. Returns null on
// any deviation so the caller falls back to DEFAULT_PROFILE_PROMPTS.
export function parseProfilePrompts(json: unknown): ProfilePrompts | null {
  if (!json || typeof json !== "object") return null
  const root = json as Record<string, unknown>
  const choice = root.choice
  const review = root.review
  if (!choice || typeof choice !== "object" || !review || typeof review !== "object") return null
  const c = choice as Record<string, unknown>
  const r = review as Record<string, unknown>
  if (typeof c.instructions !== "string" || !c.instructions.trim()) return null
  if (typeof r.assertion !== "string" || !r.assertion.trim()) return null
  const criteriaRaw = c.criteria
  if (!criteriaRaw || typeof criteriaRaw !== "object" || Array.isArray(criteriaRaw)) return null
  const criteria: Record<string, string> = {}
  for (const [key, value] of Object.entries(criteriaRaw as Record<string, unknown>)) {
    if (typeof value !== "string" || !value.trim()) return null
    criteria[key] = value
  }
  const keys = Object.keys(criteria)
  if (keys.length !== CHOICE_KEYS.length || !CHOICE_KEYS.every((k) => keys.includes(k))) return null
  return { choice: { instructions: c.instructions, criteria }, review: { assertion: r.assertion } }
}

// Read + parse the prompts file. Never throws: a missing/unreadable/malformed
// file yields null and the caller uses the built-in defaults.
export async function readProfilePrompts(file: string): Promise<ProfilePrompts | null> {
  try {
    return parseProfilePrompts(JSON.parse(await readFile(file, "utf8")))
  } catch {
    return null
  }
}

// Turn-based cooldown for the idle profile decision. Every top-level idle turn
// increments the persisted counter; the pass is `ready` once it reaches
// `cooldownTurns`. The caller resets the counter to 0 only when it actually runs
// a decision, so a triage-skipped or empty turn at the boundary keeps the pass
// armed for the next turn. Pure: returns the next counter, never mutates.
export function tickIdleTurn(
  idleTurns: number,
  cooldownTurns: number,
): { idleTurns: number; ready: boolean } {
  const next = idleTurns + 1
  return { idleTurns: next, ready: next >= cooldownTurns }
}

export type SessionTurn = { user: string; assistant: string }

// Format the most recent turns (oldest first) into the transcript handed to the
// JEV decision and the profile-writer child, capped at `maxBytes`.
export function buildTurnTranscript(turns: SessionTurn[], maxBytes: number): string {
  const text = turns
    .map((t) => `User:\n${t.user}\n\nAssistant:\n${t.assistant}`)
    .join("\n\n---\n\n")
  return text.slice(0, maxBytes)
}

// Strip a vault note down to its directive content before injection: drop the
// YAML frontmatter, the `## Related` wikilink block (navigation, not
// instruction), and the trailing `<<<END_PROFILE_NOTE` writer marker. Only
// `## Related` is removed (to the next `##` heading or EOF); all other
// sections pass through untouched. Pure.
export function stripNoteForInjection(note: string): string {
  let out = note
  if (out.startsWith("---")) {
    const end = out.indexOf("\n---", 3)
    if (end !== -1) out = out.slice(out.indexOf("\n", end + 1) + 1)
    else out = out.replace(/^---[ \t]*\r?\n/, "")
  }
  const kept: string[] = []
  let inRelated = false
  for (const line of out.split("\n")) {
    if (/^## Related[ \t]*$/.test(line)) {
      inRelated = true
      continue
    }
    if (inRelated && /^## /.test(line)) inRelated = false
    if (inRelated) continue
    if (/^[ \t]*<<<END_PROFILE_NOTE\b/.test(line)) continue
    kept.push(line)
  }
  return kept.join("\n")
}

// The block appended to the system prompt on the first turn. The vault notes
// are prompt-style operating instructions, so they are injected as directives
// (persona/behavior for the agent, working context for the user), stripped of
// frontmatter/Related/marker noise and capped at `maxBytes` per note.
export function buildInjectionBlock(agent: string, user: string, maxBytes: number): string {
  const k = stripNoteForInjection(agent).slice(0, maxBytes).trim()
  const u = stripNoteForInjection(user).slice(0, maxBytes).trim()
  if (!k && !u) return ""
  return [
    "[profile] Operating instructions loaded from the Brain vault. Follow them as directives for this session unless they conflict with the system prompt or an explicit user request.",
    "",
    "## Agent (persona & behavior)",
    k,
    "",
    "## User (user context)",
    u,
  ].join("\n")
}

// Human-readable line for the success toast when a profile note is written,
// e.g. "Agent.md updated (1770 → 2147 B)".
export function formatProfileUpdate(
  leaf: string,
  beforeBytes: number,
  afterBytes: number,
): string {
  return `${leaf} updated (${beforeBytes} → ${afterBytes} B)`
}

export type ProfileToastVariant = "info" | "success" | "warning" | "error"

// Minimal structural view of the opencode client the toaster needs. Loose on
// purpose: keeps this module free of SDK imports and unit-testable with a plain
// mock, while the real client remains assignable.
export type ProfileToastClient = {
  tui: { showToast: (args: any) => Promise<unknown> }
}

// Build the emitter the profile hook uses to surface update outcomes in the TUI.
// Gated by `notify`; a missing/headless renderer is a silent no-op, so a toast
// failure can never disturb the write path. Shared implementation: lib/notify.ts.
export function createProfileToast(opts: {
  notify: boolean
  client: ProfileToastClient
  directory: string
  title?: string
}): (message: string, variant: ProfileToastVariant) => Promise<void> {
  const notifier = createNotifier({
    client: opts.client,
    directory: opts.directory,
    enabled: opts.notify,
    channel: opts.title ?? "profile-hook",
  })
  return (message, variant) => notifier.toast(message, variant)
}

export const PROFILE_NOTE_OPEN = "<<<PROFILE_NOTE"
export const PROFILE_NOTE_CLOSE = ">>>"

// The JEV `choice` decision: which profile note(s), if any, the latest turn
// should update. Candidates come from the prompts-file criteria keys (soft bias
// lives entirely in the `none` description); instructions/criteria are
// externalized so update frequency is tunable from the file, not the TS.
// Deterministic RulesProvider abstains on choice requests, so a provider
// failure/abstain always falls back to "no write" (fail-open).
export function buildProfileDecisionRequest(
  transcript: string,
  prompts: ProfilePrompts = DEFAULT_PROFILE_PROMPTS,
): DecisionRequest {
  return {
    kind: "choice",
    state: transcript,
    candidates: Object.keys(prompts.choice.criteria),
    instructions: prompts.choice.instructions,
    criteria: Object.entries(prompts.choice.criteria)
      .map(([key, value]) => `${key}: ${value}`)
      .join("; "),
    allow_abstain: true,
  }
}

// The post-draft reviewer `noul` decision: are the writer's additions durable
// and globally applicable rather than session-specific? The current + proposed
// note and the session excerpt are all embedded so the model can spot additions
// that only make sense for this conversation. `allow_abstain:false` — an abstain
// is handled by the caller as a reject (fail-closed for the write).
export function buildProfileReviewRequest(
  leaf: string,
  current: string,
  draft: string,
  transcript: string,
  prompts: ProfilePrompts = DEFAULT_PROFILE_PROMPTS,
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
    assertion: prompts.review.assertion,
    allow_abstain: false,
  }
}

// Line-level compare ignoring the frontmatter `updated:` line, so a draft that
// only bumps the date is not treated as a substantive change (no date-only
// churn). Pure.
export function hasSubstantiveChange(current: string, draft: string): boolean {
  const stripUpdated = (note: string): string =>
    note
      .split("\n")
      .filter((line) => !/^[ \t]*updated[ \t]*:/.test(line))
      .join("\n")
  return stripUpdated(current) !== stripUpdated(draft)
}

// Normalize the model verdict into the profile targets it names. Unknown /
// negative verdicts yield [].
export function parseProfileTargets(value: unknown): Array<"agent" | "user"> {
  if (typeof value !== "string") return []
  const v = value.trim().toLowerCase()
  if (v === "both") return ["agent", "user"]
  if (v === "agent") return ["agent"]
  if (v === "user") return ["user"]
  return []
}

export type PassResult =
  | "updated"
  | "no-op"
  | "no-update"
  | "update-failed"
  | "prefilter-skip"
  | "no-transcript"
  | "decision-fallback"
  | "decision-abstain"

export type PassSummaryInput = {
  pass: string
  session: string
  result: PassResult
  idleTurns: number
  cooldownTurns: number
  durationMs: number
  verdict?: string
  confidence?: number
  fallback?: boolean
  fallbackReason?: string
  targets?: string[]
  updated?: string[]
  failed?: string[]
  noop?: string[]
  transcriptTurns?: number
  transcriptBytes?: number
}

// Terminal one-line summary for a profile decision pass. Emitted only when a
// pass clears the cooldown gate (below-threshold turns keep `profile-cooldown`).
// `result` is the single field that answers "did this pass update a profile?":
// `updated` (>=1 note written), `no-update` (verdict none), `update-failed`
// (targets named but nothing written), or `no-op` (drafts carried no substantive
// change); the other results are the fail-open / skip branches. Undefined
// optional keys are omitted for a clean NDJSON line.
export function summarizePass(input: PassSummaryInput): Record<string, unknown> {
  const out: Record<string, unknown> = {
    event: "profile-pass",
    pass: input.pass,
    session: input.session,
    result: input.result,
    idleTurns: input.idleTurns,
    cooldownTurns: input.cooldownTurns,
    durationMs: input.durationMs,
  }
  const optional: Array<[string, unknown]> = [
    ["verdict", input.verdict],
    ["confidence", input.confidence],
    ["fallback", input.fallback],
    ["fallbackReason", input.fallbackReason],
    ["targets", input.targets],
    ["updated", input.updated],
    ["failed", input.failed],
    ["noop", input.noop],
    ["transcriptTurns", input.transcriptTurns],
    ["transcriptBytes", input.transcriptBytes],
  ]
  for (const [key, value] of optional) {
    if (value !== undefined) out[key] = value
  }
  return out
}

// The prompt handed to the profile-writer child. It receives the current note
// plus the conversation excerpt and must return the complete updated file
// between the markers. The writer OWNS the note: it may rewrite, merge,
// compact, and prune (evolution mandate) as long as durable facts survive and
// the note stays inside its byte budget — the profile is curated, never
// append-only.
export function buildWriterPrompt(
  fileName: string,
  current: string,
  transcript: string,
  today: string,
  maxBytes: number = 6000,
): string {
  return [
    "You curate a personal knowledge-vault profile note. You are given its full current contents and a conversation excerpt. This note is injected into the agent's system prompt every session, so it must stay lean.",
    "FIRST, read the current note and identify how it is written: its frontmatter fields, section headings and their order, bullet vs prose style, and its register — either authoritative (written as instructions/directives to the agent) or descriptive (written as neutral notes).",
    "THEN evolve the note so it reflects durable information from the excerpt while matching that same structure and register. If the note is authoritative, every addition must also read as an authoritative instruction in the same voice (e.g. \"Do X\", \"Never Y\"); if it is descriptive, keep additions descriptive. Never convert one register into the other.",
    `You OWN this note: you may rewrite, merge, compact, restructure, and prune it — not only append. HARD BUDGET: the complete note must stay under ${maxBytes} bytes; when adding anything, first compact or merge existing bullets that say the same thing, and prefer one tight bullet over three loose ones.`,
    "Never silently lose a durable fact: when removing or merging content, keep every identity fact, contact detail, standing preference, and operating rule reachable in the result. Stale facts are updated or replaced, not accumulated. Structure, wording, section order, and wikilinks may evolve freely.",
    "Add only durable facts (identity, preferences, stack, career, persona traits) and durable response-improvement instructions — general feedback on how the agent should respond (format, structure, detail level, tone) phrased as a standing rule, when the excerpt carries such feedback. Ignore ephemeral task progress, one-off commands, and small talk.",
    "Out of scope for this note — route these away instead of storing them here: project implementation or status detail (belongs in its own linked project note), job applications (own linked note), and anything that will be stale next quarter. If the excerpt only carries out-of-scope material, return the note unchanged.",
    "If nothing durable is present and no compaction is needed, return the note unchanged.",
    `Set the frontmatter \`updated:\` field to ${today}.`,
    "",
    "Return ONLY the complete updated file, wrapped exactly like this:",
    PROFILE_NOTE_OPEN,
    "<full updated note>",
    PROFILE_NOTE_CLOSE,
    "No commentary. No code fences.",
    "",
    `=== FILE: ${fileName} ===`,
    current,
    "=== END FILE ===",
    "",
    "=== CONVERSATION EXCERPT ===",
    transcript,
    "=== END EXCERPT ===",
  ].join("\n")
}

// Extract the note body from the writer reply. Strict: without the exact
// markers we treat the reply as unusable (never write commentary to the vault).
export function extractNote(reply: string): string | null {
  const m = reply.match(/<<<PROFILE_NOTE[ \t]*\r?\n([\s\S]*?)\r?\n?>>>/)
  if (!m) return null
  const body = m[1].trim()
  return body ? body + "\n" : null
}

// Deterministic safety gate before writing: the note must be non-empty, within
// the size cap (the writer's hard budget), keep frontmatter if the original had
// it, carry no output markers, and only contain well-formed wikilinks. Links
// may be added or removed (the writer curates; it is not append-only) — only
// malformed `[[` fragments are rejected.
export function validateNote(current: string, next: string, maxBytes: number): boolean {
  if (!next.trim()) return false
  if (Buffer.byteLength(next, "utf8") > maxBytes) return false
  if (next.includes(PROFILE_NOTE_OPEN) || next.includes(PROFILE_NOTE_CLOSE)) return false
  if (current.startsWith("---") && !next.startsWith("---")) return false
  const opens = (next.match(/\[\[/g) ?? []).length
  const closes = (next.match(/\]\]/g) ?? []).length
  if (opens !== closes) return false
  for (const link of next.match(/\[\[[^\]]*\]\]/g) ?? []) {
    if (!/^\[\[[^\[\]]+\]\]$/.test(link)) return false
  }
  return true
}

// Deterministically set the `updated:` frontmatter date to `value`. No-op when
// the note has no frontmatter; inserts the field when absent.
export function setFrontmatterDate(note: string, value: string): string {
  if (!note.startsWith("---")) return note
  const end = note.indexOf("\n---", 3)
  if (end === -1) return note
  const head = note.slice(0, end)
  const body = note.slice(end)
  const re = /(^|\n)([ \t]*updated[ \t]*:[ \t]*).*$/m
  const newHead = re.test(head)
    ? head.replace(re, (_m, p1: string, p2: string) => `${p1}${p2}${value}`)
    : `${head}\nupdated: ${value}`
  return newHead + body
}

// Split a "provider/model" spec into the SDK's model shape, or null when empty
// or malformed (caller then omits `model` and the agent default applies).
export function splitWriterModel(model: string): { providerID: string; modelID: string } | null {
  const m = model.trim()
  const i = m.indexOf("/")
  if (i <= 0 || i === m.length - 1) return null
  return { providerID: m.slice(0, i), modelID: m.slice(i + 1) }
}

// Write via a same-directory temp file + rename so a crash can never leave a
// half-written profile note. Shared implementation: lib/fsx.ts.
export { atomicWrite as atomicWriteFile } from "./fsx.ts"
