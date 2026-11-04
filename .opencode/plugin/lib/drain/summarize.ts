// Session summarizer for the drain pipe (knowledge-pipeline-redesign §A.6).
//
// Spawns the `session-summarizer` agent through the pass executor, reads its
// `summary_items` tool call from the transcript, and normalizes the items
// (unique titles, lowercased tags, capped count, stable content hashes). A
// missing or invalid tool call gets one correction prompt; a still-missing
// call degrades to a deterministic per-turn fallback built from
// extractKeywords + atoms — the pipe never throws and never loses a turn.
//
// Loaded via relative import only.
import { lastToolCall } from "../tools/tool-call.ts"
import { extractKeywords } from "../transcript.ts"
import { hashContent, extractAtoms, type RenderedSession } from "./render.ts"
import type { ChildExecutor, ChildOutcome, ChildRequest } from "./child.ts"

export const SUMMARY_ITEMS_TOOL = "summary_items"

/** The typed item shape the `summary_items` tool accepts. */
export type RawSummaryItem = {
  title: string
  summary: string
  tags: string[]
  atoms: string[]
}

export type SummaryItemsValidation =
  | { ok: true; items: RawSummaryItem[] }
  | { ok: false; error: string }

function stringList(value: unknown): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== "string") return null
    const text = entry.trim()
    if (text) out.push(text)
  }
  return out
}

/** Validate the `summary_items` arguments. An empty array is the no-items case. */
export function validateSummaryItems(raw: unknown): SummaryItemsValidation {
  let value: unknown = raw
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return { ok: false, error: "summary_items arguments must be an object" }
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "summary_items arguments must be an object" }
  }
  const items = (value as { items?: unknown }).items
  if (!Array.isArray(items)) return { ok: false, error: "items must be an array" }

  const out: RawSummaryItem[] = []
  for (const [index, entry] of items.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: `item ${index + 1} must be an object` }
    }
    const item = entry as Record<string, unknown>
    const title = typeof item.title === "string" ? item.title.trim() : ""
    if (!title) return { ok: false, error: `item ${index + 1}: title must be a non-empty string` }
    const summary = typeof item.summary === "string" ? item.summary.trim() : ""
    const tags = stringList(item.tags)
    if (tags === null) return { ok: false, error: `item ${index + 1}: tags must be a string array` }
    const atoms = stringList(item.atoms)
    if (atoms === null) return { ok: false, error: `item ${index + 1}: atoms must be a string array` }
    out.push({ title, summary, tags, atoms })
  }
  return { ok: true, items: out }
}

/** Last valid `summary_items` call in the child transcript, or null. */
export function parseSummaryItems(rows: unknown[]): RawSummaryItem[] | null {
  const raw = lastToolCall(rows, SUMMARY_ITEMS_TOOL)
  if (raw === null) return null
  const result = validateSummaryItems(raw)
  return result.ok ? result.items : null
}

export type SummaryItem = {
  title: string
  summary: string
  tags: string[]
  atoms: string[]
  hash: string
}

export type SummarizeDegraded = "summarizer-fallback"

/** Structured failure class so a fallback is measurable, not just a string. */
export type SummarizeFailure = "parse-failure" | "late-reply" | "timeout" | "spawn"

export type SummarizeResult = {
  items: SummaryItem[]
  degraded?: SummarizeDegraded
  error?: string
  /** Set when the deterministic fallback ran; identifies why. */
  errorCode?: SummarizeFailure
  /** A reply arrived after the deadline but was used anyway. */
  lateReply?: boolean
  model?: string | null
  promptBytes: number
  wallMs: number
  tokens?: number | null
  /** Reply size in bytes before parsing. */
  replyBytes: number
  /** Child session created for the last attempt. */
  sessionID?: string | null
  /** Create + prompt setup observed by the caller (ms). */
  spawnMs?: number | null
  /** Caller wait from prompt accepted to completion (ms). */
  runMs?: number | null
  /** Prompt accepted -> first assistant message (queue + TTFT, ms). */
  queueMs?: number | null
  /** Assistant steps in the child session. */
  steps?: number | null
  /** Assistant wall span from first start to last completion (ms). */
  spanMs?: number | null
  /** Sum of assistant generation time (ms). */
  modelMs?: number | null
  /** Sum of tool-call execution time (ms). */
  toolMs?: number | null
  /** Attempts spent on this session (coordinator retries). */
  attempts?: number
}

export type SummarizerClient = {
  session: {
    create(args: any): Promise<{ data?: { id?: string } }>
    promptAsync(args: any): Promise<{ error?: unknown; response?: { ok?: boolean } }>
    messages(args: any): Promise<{ data?: any }>
    abort(args: any): Promise<{ error?: unknown; response?: { ok?: boolean; status?: number } }>
  }
}

export type SummarizeDeps = {
  executor: ChildExecutor
  /** Model from `drain.summarize_model`; "" = the agent default. */
  model?: string
  maxItems: number
  /** Absolute ceiling for this child, in ms. */
  deadlineMs?: number
  /** Kill only after this long with no new progress; 0 = deadline-only. */
  stallMs?: number
  onWarn?: (message: string, err?: unknown) => void
}

export type SummarizeInput = {
  sessionID: string
  rendered: RenderedSession
  priorSummary?: string | null
}

/** The exact input contract from the design doc. */
export function buildSummarizerPrompt(
  priorSummary: string | null | undefined,
  delta: string,
): string {
  const prior = priorSummary?.trim() || "none"
  return `Summarize this session delta into durable knowledge items.
Call the \`summary_items\` tool exactly once. Each item has:
- title: one line, never empty;
- tags: lowercase-hierarchical tags;
- summary: 1-3 sentences;
- atoms: commands, paths, URLs, KEY=value and flags, verbatim.

Rules:
- Summarize only what the delta says. Do not verify, correct, fact-check, or
  add outside knowledge.
- Write summary as plain sentences: no markdown, headings, bullets, code
  fences, or emphasis.
- one item per distinct durable topic (1..N), "one thought per note";
- preserve every command, path, URL, KEY=value and flag verbatim in atoms;
- skip chatter, questions with no answer, and transient status;
- the prior summary (if any) is context only; do not repeat it verbatim;
- if nothing durable happened, call \`summary_items\` with an empty items array.

## Prior summary
${prior}

## Session delta
${delta}`
}

/** One correction turn for a child that finished without calling the tool. */
export const SUMMARY_ITEMS_CORRECTION =
  "Your previous reply completed without calling `summary_items`. " +
  "Call `summary_items` now with the items you extracted (or an empty items array " +
  "if nothing durable happened). Do not reply with prose."

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(asString).filter((v) => v !== "")
}

function uniqueTitle(title: string, used: Set<string>): string {
  let candidate = title
  let n = 2
  while (used.has(candidate.toLowerCase())) {
    candidate = `${title} (${n})`
    n++
  }
  used.add(candidate.toLowerCase())
  return candidate
}

function normalizeItems(
  raw: RawSummaryItem[],
  maxItems: number,
  renderedAtoms: string[],
): SummaryItem[] {
  const usedTitles = new Set<string>()
  const items: SummaryItem[] = []

  for (const entry of raw) {
    if (items.length >= Math.max(1, maxItems)) break
    const title = asString(entry.title)
    if (!title) continue

    const tags = [...new Set(asStringList(entry.tags).map((t) => t.toLowerCase()))]
    const atoms = asStringList(entry.atoms)
    items.push({
      title: uniqueTitle(title, usedTitles),
      summary: asString(entry.summary),
      tags,
      atoms,
      hash: "",
    })
  }

  if (items.length === 0) return []

  // Fidelity rule: every deterministic atom survives summarization. Missing
  // ones are attached to the first item rather than dropped.
  const present = new Set(items.flatMap((item) => item.atoms))
  for (const atom of renderedAtoms) {
    if (!present.has(atom)) {
      items[0].atoms.push(atom)
      present.add(atom)
    }
  }

  for (const item of items) item.hash = hashContent(item.summary, item.atoms)
  return items
}

function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value
}

function titleFromTurn(text: string, keywords: string[]): string {
  if (keywords.length > 0) return keywords.slice(0, 6).map(capitalize).join(" ")
  const head = text.trim().replace(/\s+/g, " ").slice(0, 60)
  return head ? capitalize(head) : "Session turn"
}

/**
 * Deterministic fallback: one item per turn, built without a model.
 * Atoms per turn come from the same extractor the renderer uses.
 */
export function deterministicItems(rendered: RenderedSession, maxItems: number): SummaryItem[] {
  const usedTitles = new Set<string>()
  const items: SummaryItem[] = []

  for (const turn of rendered.turns) {
    if (items.length >= Math.max(1, maxItems)) break
    const text = turn.text.trim()
    if (!text) continue

    const keywords = extractKeywords(text, 6)
    items.push({
      title: uniqueTitle(titleFromTurn(text, keywords), usedTitles),
      summary: text.slice(0, 600),
      tags: keywords.slice(0, 3),
      atoms: extractAtoms(text),
      hash: "",
    })
  }

  if (items.length === 0) {
    items.push({
      title: uniqueTitle("Session turn", usedTitles),
      summary: rendered.text.slice(0, 600),
      tags: [],
      atoms: [...rendered.atoms],
      hash: "",
    })
  }

  const present = new Set(items.flatMap((item) => item.atoms))
  for (const atom of rendered.atoms) {
    if (!present.has(atom)) {
      items[0].atoms.push(atom)
      present.add(atom)
    }
  }

  for (const item of items) item.hash = hashContent(item.summary, item.atoms)
  return items
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function timingOf(outcome: ChildOutcome): Pick<
  SummarizeResult,
  "sessionID" | "spawnMs" | "runMs" | "queueMs" | "steps" | "spanMs" | "modelMs" | "toolMs"
> {
  return {
    sessionID: outcome.sessionID,
    spawnMs: outcome.spawnMs ?? null,
    runMs: outcome.runMs ?? null,
    queueMs: outcome.queueMs ?? null,
    steps: outcome.steps ?? null,
    spanMs: outcome.spanMs ?? null,
    modelMs: outcome.modelMs ?? null,
    toolMs: outcome.toolMs ?? null,
  }
}

function replyBytesOf(outcome: ChildOutcome): number {
  let bytes = 0
  for (const reply of outcome.replies) {
    bytes = Math.max(bytes, Buffer.byteLength(reply, "utf8"))
  }
  return bytes
}

/**
 * Summarize one rendered session. Never throws: spawn/parse/timeout failures
 * return the deterministic fallback with `degraded: "summarizer-fallback"`.
 * The coordinator owns retries (respawn); this function makes one attempt plus
 * one in-child correction when the tool call is missing.
 */
export async function summarizeSession(
  input: SummarizeInput,
  deps: SummarizeDeps,
): Promise<SummarizeResult> {
  const started = performance.now()
  const prompt = buildSummarizerPrompt(input.priorSummary, input.rendered.text)
  const promptBytes = Buffer.byteLength(prompt, "utf8")
  const request: ChildRequest = {
    id: input.sessionID,
    kind: "summarize",
    prompt,
    agent: "session-summarizer",
    ...(deps.model ? { model: deps.model } : {}),
    deadlineMs: deps.deadlineMs ?? 600_000,
    stallMs: deps.stallMs ?? 0,
  }

  let outcome: ChildOutcome
  try {
    outcome = await deps.executor.spawn(request)
  } catch (err) {
    const error = `summarizer spawn failed: ${errorText(err)}`
    deps.onWarn?.(`drain summarizer: ${error}`)
    return {
      items: deterministicItems(input.rendered, deps.maxItems),
      degraded: "summarizer-fallback",
      error,
      errorCode: "spawn",
      model: deps.model || null,
      promptBytes,
      wallMs: Math.round(performance.now() - started),
      tokens: null,
      replyBytes: 0,
      attempts: 1,
    }
  }

  let items = parseSummaryItems(outcome.rows)
  if (items === null && outcome.sessionID && !outcome.timedOut && outcome.phase !== "failed") {
    try {
      outcome = await deps.executor.prompt(outcome.sessionID, {
        ...request,
        kind: "correct",
        prompt: SUMMARY_ITEMS_CORRECTION,
      })
      items = parseSummaryItems(outcome.rows)
    } catch {
      /* keep the original outcome */
    }
  }

  const wallMs = Math.round(performance.now() - started)
  const telemetry = {
    model: deps.model || null,
    promptBytes,
    wallMs,
    tokens: outcome.tokens ?? null,
    replyBytes: replyBytesOf(outcome),
    ...timingOf(outcome),
    attempts: 1,
  }
  // A timeout with a valid tool call is a late report even when the child
  // produced no text reply (the report itself is the tool call).
  const late = outcome.late || (outcome.timedOut && items !== null)
  const lateField = late ? { lateReply: true as const } : {}

  if (items === null) {
    const error = outcome.error ?? "summarizer did not call summary_items"
    const code: SummarizeFailure = outcome.timedOut
      ? late
        ? "late-reply"
        : "timeout"
      : outcome.phase === "failed"
        ? "spawn"
        : "parse-failure"
    deps.onWarn?.(`drain summarizer: ${error}`)
    return {
      items: deterministicItems(input.rendered, deps.maxItems),
      degraded: "summarizer-fallback",
      error,
      errorCode: code,
      ...lateField,
      ...telemetry,
    }
  }

  if (items.length === 0) {
    return { items: [], ...lateField, ...telemetry }
  }

  const normalized = normalizeItems(items, deps.maxItems, input.rendered.atoms)
  if (normalized.length === 0) {
    const error = "no valid items"
    deps.onWarn?.(`drain summarizer: ${error}`)
    return {
      items: deterministicItems(input.rendered, deps.maxItems),
      degraded: "summarizer-fallback",
      error,
      errorCode: "parse-failure",
      ...lateField,
      ...telemetry,
    }
  }

  return { items: normalized, ...lateField, ...telemetry }
}
