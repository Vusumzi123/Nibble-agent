// Session summarizer for the drain pipe (knowledge-pipeline-redesign §A.6).
//
// Spawns the tool-free `session-summarizer` agent, parses its strict-JSON
// reply, and normalizes the items (unique titles, lowercased tags, capped
// count, stable content hashes). Any parse/spawn/timeout failure degrades to a
// deterministic per-turn fallback built from extractKeywords + atoms — the
// pipe never throws and never loses a turn.
//
// Loaded via relative import only.
import { textOf } from "../sessions.ts"
import { extractKeywords } from "../transcript.ts"
import { hashContent, extractAtoms, type RenderedSession } from "./render.ts"
import { SUMMARIZER_SESSION_TITLE } from "./automation.ts"

export type SummaryItem = {
  title: string
  summary: string
  tags: string[]
  atoms: string[]
  hash: string
}

export type SummarizeDegraded = "summarizer-fallback"

/** Structured-output mode requested for the child prompt (§3.1). */
export type SummarizeFormat = "json_schema" | "json_object" | "off"

/**
 * The item contract as a JSON schema: the same shape `parseSummaryReply`
 * accepts. `minItems` is deliberately absent so `{"items":[]}` stays a clean
 * no-op rather than a schema violation.
 */
export const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "summary", "tags", "atoms"],
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          atoms: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const

export type SummarizeResult = {
  items: SummaryItem[]
  degraded?: SummarizeDegraded
  error?: string
  model?: string | null
  promptBytes: number
  wallMs: number
  tokens?: number | null
  /** Structured-output mode that was requested (§3.5). */
  format: SummarizeFormat
  /** Reply size in bytes before parsing. */
  replyBytes: number
  /** `true` when the reply parsed without repair. */
  closed: boolean
  /** `true` when the repair backstop salvaged the reply. */
  repaired: boolean
  /** The provider rejected `format`; the prompt was re-sent without it. */
  formatFallback?: boolean
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
  client: SummarizerClient
  directory: string
  /** Model from `drain.summarize_model`; "" = the agent default. */
  model?: string
  /** Structured-output mode from `drain.summarize_format`; default json_schema. */
  format?: SummarizeFormat
  maxItems: number
  /** Bounded wait for the child to go idle; false = timeout. */
  waitForIdle: (sessionID: string) => Promise<boolean>
  registerChild?: (sessionID: string) => void
  onWarn?: (message: string, err?: unknown) => void
}

export type SummarizeInput = {
  sessionID: string
  rendered: RenderedSession
  priorSummary?: string | null
}

/** The exact input contract from the design doc. */
export function buildSummarizerPrompt(priorSummary: string | null | undefined, delta: string): string {
  const prior = priorSummary?.trim() || "none"
  return `Summarize this session delta into durable knowledge items.
Return STRICT JSON, nothing else:
{"items":[{"title":"","summary":"","tags":[""],"atoms":[""]}]}

Rules:
- one item per distinct durable topic (1..N), "one thought per note";
- preserve every command, path, URL, KEY=value and flag verbatim in atoms;
- tags are lowercase-hierarchical;
- skip chatter, questions with no answer, and transient status.
- prior summary (if any) is context only; do not repeat it verbatim.

## Prior summary
${prior}

## Session delta
${delta}`
}

type RawItem = { title?: unknown; summary?: unknown; tags?: unknown; atoms?: unknown }

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

function parseRawItems(text: string): RawItem[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }

  const items = (parsed as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) return null
  return items.filter((item): item is RawItem => !!item && typeof item === "object")
}

/**
 * Extract and validate the strict-JSON reply. Tolerates a fenced block and
 * surrounding prose; returns null when nothing valid remains.
 */
export function parseSummaryReply(reply: string): RawItem[] | null {
  const text = reply.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim()
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  return parseRawItems(text.slice(start, end + 1))
}

/** Strip a markdown fence and any prose before the first object brace. */
function stripReplyEnvelope(reply: string): string {
  const text = reply.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim()
  const start = text.indexOf("{")
  return start === -1 ? "" : text.slice(start)
}

type RepairCandidate = { index: number; closers: string }

/**
 * Positions where the text closes a container outside a string, paired with
 * the closers still missing at that point. Scanning stops at a mismatched
 * closer — beyond that the structure cannot be trusted.
 */
function repairCandidates(text: string): RepairCandidate[] {
  const stack: string[] = []
  const out: RepairCandidate[] = []
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === "{") {
      stack.push("}")
      continue
    }
    if (ch === "[") {
      stack.push("]")
      continue
    }
    if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return out
      out.push({ index: i + 1, closers: [...stack].reverse().join("") })
    }
  }

  // A reply cut inside a string cannot be closed without inventing content;
  // fall back to the last container boundary instead (§3.3 rule 4).
  if (!inString && stack.length > 0) {
    out.push({ index: text.length, closers: [...stack].reverse().join("") })
  }
  return out
}

/**
 * Bounded repair for a reply that is a few closing tokens short (§3.3).
 * Returns the repaired JSON text, or null when nothing valid can be salvaged.
 * Never invents content: it only drops an incomplete tail and closes the
 * containers that are still open.
 */
export function repairJson(reply: string): string | null {
  const text = stripReplyEnvelope(reply)
  if (!text) return null
  if (parseRawItems(text)) return text

  const candidates = repairCandidates(text)
  for (let i = candidates.length - 1; i >= 0; i--) {
    const { index, closers } = candidates[i]
    const head = text.slice(0, index).replace(/[,\s]+$/, "")
    if (!head) continue
    const attempt = head + closers
    if (parseRawItems(attempt)) return attempt
  }
  return null
}

function normalizeItems(
  raw: RawItem[],
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

function usageTokens(rows: unknown[]): number | null {
  let total = 0
  let known = false
  for (const row of rows) {
    const tokens = (row as { info?: { tokens?: Record<string, unknown> } })?.info?.tokens
    if (!tokens) continue
    for (const key of ["input", "output", "reasoning"]) {
      const value = Number(tokens[key] ?? 0)
      if (Number.isFinite(value)) {
        total += value
        known = true
      }
    }
  }
  return known ? total : null
}

function lastAssistantText(rows: unknown[]): string {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i] as { info?: { role?: unknown }; parts?: unknown[] }
    if (row?.info?.role !== "assistant") continue
    const text = textOf(row.parts ?? []).trim()
    if (text) return text
  }
  return ""
}

function formatField(format: SummarizeFormat): unknown {
  if (format === "json_object") {
    // opencode 1.19 exposes only `text` and `json_schema` on the prompt API,
    // so validity-only JSON is expressed as a permissive object schema.
    return { type: "json_schema", schema: { type: "object", additionalProperties: true } }
  }
  return { type: "json_schema", schema: SUMMARY_SCHEMA }
}

function isPromptError(res: { error?: unknown; response?: { ok?: boolean } } | undefined): boolean {
  return !!res?.error || !!(res?.response && !res.response.ok)
}

function promptErrorText(err: unknown): string {
  if (typeof err === "string" && err) return err
  const message = (err as { message?: unknown } | undefined)?.message
  if (typeof message === "string" && message) return message
  return "promptAsync failed"
}

/** True when a provider rejection is about the structured-output field. */
function mentionsFormat(err: unknown): boolean {
  let text = ""
  try {
    text = typeof err === "string" ? err : JSON.stringify(err ?? "")
  } catch {
    text = String(err ?? "")
  }
  return /response_format|json_schema|json_object|\bformat\b/i.test(text)
}

/**
 * Summarize one rendered session. Never throws: spawn/parse/timeout failures
 * return the deterministic fallback with `degraded: "summarizer-fallback"`.
 */
export async function summarizeSession(
  input: SummarizeInput,
  deps: SummarizeDeps,
): Promise<SummarizeResult> {
  const started = Date.now()
  const prompt = buildSummarizerPrompt(input.priorSummary, input.rendered.text)
  const promptBytes = Buffer.byteLength(prompt, "utf8")
  const format = deps.format ?? "json_schema"
  let formatFallback = false
  let lastReplyBytes = 0
  let lastClosed = false
  let lastRepaired = false

  const fallback = (error: string, wallMs: number): SummarizeResult => {
    deps.onWarn?.(`drain summarizer: ${error}`)
    return {
      items: deterministicItems(input.rendered, deps.maxItems),
      degraded: "summarizer-fallback",
      error,
      model: deps.model || null,
      promptBytes,
      wallMs,
      tokens: null,
      format,
      replyBytes: lastReplyBytes,
      closed: lastClosed,
      repaired: lastRepaired,
      ...(formatFallback ? { formatFallback: true } : {}),
    }
  }

  try {
    const abortChild = async (childID: string): Promise<string | null> => {
      try {
        const res = await deps.client.session.abort({
          path: { id: childID },
          query: { directory: deps.directory },
        })
        if (res?.error || (res?.response && !res.response.ok)) {
          return (
            (res?.error as { message?: string } | undefined)?.message ??
            `session.abort failed (status ${res?.response?.status ?? "unknown"})`
          )
        }
        return null
      } catch (err) {
        return err instanceof Error ? err.message : String(err)
      }
    }

    const ask = async (
      text: string,
    ): Promise<{ rows: unknown[]; reply: string; formatFallback: boolean }> => {
      const spawn = async (useFormat: boolean) => {
        const created = await deps.client.session.create({
          body: { title: SUMMARIZER_SESSION_TITLE },
          query: { directory: deps.directory },
        })
        const childID = String(created?.data?.id ?? "")
        if (!childID) throw new Error("session.create returned no id")
        deps.registerChild?.(childID)

        const res = await deps.client.session.promptAsync({
          path: { id: childID },
          body: {
            agent: "session-summarizer",
            ...(deps.model ? { model: deps.model } : {}),
            parts: [{ type: "text", text }],
            ...(useFormat ? { format: formatField(format) } : {}),
          },
          query: { directory: deps.directory },
        })
        return { childID, res }
      }

      let useFormat = format !== "off"
      let { childID, res } = await spawn(useFormat)
      let formatFallback = false

      // A provider that rejects `format` gets exactly one retry without it —
      // never a blind loop (§3.1).
      if (isPromptError(res) && useFormat && mentionsFormat(res?.error)) {
        await abortChild(childID)
        formatFallback = true
        useFormat = false
        ;({ childID, res } = await spawn(false))
      }
      if (isPromptError(res)) throw new Error(promptErrorText(res?.error))

      const idled = await deps.waitForIdle(childID)
      if (!idled) {
        // A timed-out child must not outlive its own wait (§5.2). Stop it
        // before throwing so the fallback path never leaves a live session.
        const abortError = await abortChild(childID)
        throw new Error(
          abortError ? `summarizer timed out; abort failed: ${abortError}` : "summarizer timed out",
        )
      }

      const messages = await deps.client.session.messages({
        path: { id: childID },
        query: { directory: deps.directory },
      })
      const rows = Array.isArray(messages?.data) ? messages.data : []
      return { rows, reply: lastAssistantText(rows), formatFallback }
    }

    // Strict JSON occasionally slips even on a strong model. Structured output
    // is the primary fix; repair is the backstop; one retry is the last rung
    // before the deterministic per-turn fallback (§3.4).
    for (let attempt = 1; ; attempt++) {
      const text =
        attempt === 1
          ? prompt
          : `${prompt}\n\nYour previous reply was cut off before the closing braces. Keep atoms shorter and close the object with valid JSON only.`
      const { rows, reply, formatFallback: attemptFallback } = await ask(text)
      if (attemptFallback) formatFallback = true
      const tokens = usageTokens(rows)

      lastReplyBytes = Buffer.byteLength(reply, "utf8")
      const direct = parseSummaryReply(reply)
      let raw = direct
      lastClosed = direct !== null
      lastRepaired = false
      if (!raw) {
        const fixed = repairJson(reply)
        if (fixed) {
          raw = parseSummaryReply(fixed)
          lastRepaired = raw !== null
        }
      }

      if (!raw) {
        if (attempt < 2) continue
        return fallback(
          `malformed summarizer reply (bytes=${lastReplyBytes}, closed=${lastClosed}, format=${format})`,
          Date.now() - started,
        )
      }
      if (raw.length === 0) {
        // Valid strict JSON with no durable items: a clean no-op, not a failure.
        return {
          items: [],
          model: deps.model || null,
          promptBytes,
          wallMs: Date.now() - started,
          tokens,
          format,
          replyBytes: lastReplyBytes,
          closed: lastClosed,
          repaired: lastRepaired,
          ...(formatFallback ? { formatFallback: true } : {}),
        }
      }

      const items = normalizeItems(raw, deps.maxItems, input.rendered.atoms)
      if (items.length === 0) return fallback("no valid items", Date.now() - started)

      return {
        items,
        model: deps.model || null,
        promptBytes,
        wallMs: Date.now() - started,
        tokens,
        format,
        replyBytes: lastReplyBytes,
        closed: lastClosed,
        repaired: lastRepaired,
        ...(formatFallback ? { formatFallback: true } : {}),
      }
    }
  } catch (err) {
    return fallback(err instanceof Error ? err.message : String(err), Date.now() - started)
  }
}
