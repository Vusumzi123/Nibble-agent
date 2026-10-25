// Session summarizer for the drain pipe (knowledge-pipeline-redesign §A.6).
//
// Spawns the tool-free `session-summarizer` agent, parses its plain-text
// `=== ITEM ===` blocks deterministically, and normalizes the items (unique
// titles, lowercased tags, capped count, stable content hashes). The model
// never writes JSON, so there is no schema, repair, or truncation handling.
// Any parse/spawn/timeout failure degrades to a deterministic per-turn
// fallback built from extractKeywords + atoms — the pipe never throws and
// never loses a turn.
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

/** Structured failure class so a fallback is measurable, not just a string. */
export type SummarizeFailure = "parse-failure" | "late-reply" | "timeout" | "spawn"

export type SummarizeResult = {
  items: SummaryItem[]
  degraded?: SummarizeDegraded
  error?: string
  /** Set when the deterministic fallback ran; identifies why. */
  errorCode?: SummarizeFailure
  /** A reply arrived after the idle deadline but was used anyway. */
  lateReply?: boolean
  model?: string | null
  promptBytes: number
  wallMs: number
  tokens?: number | null
  /** Reply size in bytes before parsing. */
  replyBytes: number
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
export function buildSummarizerPrompt(
  priorSummary: string | null | undefined,
  delta: string,
): string {
  const prior = priorSummary?.trim() || "none"
  return `Summarize this session delta into durable knowledge items.
Reply with plain-text blocks, nothing else. Use exactly this shape per item:

=== ITEM ===
TITLE: <one line>
TAGS: <comma-separated tags>
SUMMARY: <1-3 sentences>
ATOMS:
- <command, path, URL, KEY=value or flag, verbatim>

Rules:
- one item per distinct durable topic (1..N), "one thought per note";
- repeat the block for every item; no JSON and no prose outside the blocks;
- preserve every command, path, URL, KEY=value and flag verbatim in ATOMS;
- tags are lowercase-hierarchical;
- skip chatter, questions with no answer, and transient status;
- prior summary (if any) is context only; do not repeat it verbatim;
- if nothing durable happened, reply with exactly: NO_ITEMS

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

const TEXT_ITEM_MARKER = /^=+\s*ITEM\s*=+$/i

/** Strip a single wrapping markdown fence from a plain-text reply. */
function stripTextEnvelope(reply: string): string {
  const text = reply.trim()
  if (!text.startsWith("```")) return text
  const firstNewline = text.indexOf("\n")
  if (firstNewline === -1) return text
  const body = text.slice(firstNewline + 1)
  const end = body.lastIndexOf("```")
  return (end === -1 ? body : body.slice(0, end)).trim()
}

/**
 * Parse the summarizer's deterministic line-block reply.
 *
 * The model never writes JSON: one `=== ITEM ===` block per topic, with
 * TITLE/TAGS/SUMMARY lines and ATOMS bullets. Parsing is forgiving (case,
 * fences, wrapped summaries) but structural: a block without a TITLE is
 * dropped, and a reply with no blocks returns null so the caller can retry.
 */
export function parseSummaryReply(reply: string): RawItem[] | null {
  const text = stripTextEnvelope(reply)
  if (!text) return null
  if (/^NO_ITEMS\.?$/i.test(text)) return []

  type Draft = { title?: string; summary: string[]; tags: string[]; atoms: string[] }
  const items: RawItem[] = []
  let current: Draft | null = null
  let section: "summary" | "atoms" | null = null

  const flush = () => {
    if (!current) return
    const draft = current
    current = null
    section = null
    const title = asString(draft.title)
    if (!title) return
    items.push({
      title,
      summary: draft.summary.join(" ").trim(),
      tags: draft.tags,
      atoms: draft.atoms,
    })
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (TEXT_ITEM_MARKER.test(line)) {
      flush()
      current = { summary: [], tags: [], atoms: [] }
      section = null
      continue
    }
    if (!current) continue

    const title = /^TITLE:\s*(.*)$/i.exec(line)
    if (title) {
      current.title = title[1].trim()
      section = null
      continue
    }
    const tags = /^TAGS:\s*(.*)$/i.exec(line)
    if (tags) {
      current.tags = tags[1]
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag !== "")
      section = null
      continue
    }
    const summary = /^SUMMARY:\s*(.*)$/i.exec(line)
    if (summary) {
      if (summary[1].trim()) current.summary.push(summary[1].trim())
      section = "summary"
      continue
    }
    if (/^ATOMS:\s*$/i.test(line)) {
      section = "atoms"
      continue
    }
    if (section === "atoms") {
      const bullet = /^[-*]\s*(.+)$/.exec(line)
      if (bullet) current.atoms.push(bullet[1].trim())
      continue
    }
    if (section === "summary" && line) current.summary.push(line)
  }
  flush()

  return items.length > 0 ? items : null
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

/** Assistant reply texts, newest first. The last valid block wins; a trailing
 *  acknowledgement must not discard an earlier, well-formed summary. */
function assistantReplies(rows: unknown[]): string[] {
  const replies: string[] = []
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i] as { info?: { role?: unknown }; parts?: unknown[] }
    if (row?.info?.role !== "assistant") continue
    const text = textOf(row.parts ?? []).trim()
    if (text) replies.push(text)
  }
  return replies
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
  let lastReplyBytes = 0

  const fallback = (
    error: string,
    wallMs: number,
    errorCode: SummarizeFailure,
    lateReply = false,
  ): SummarizeResult => {
    deps.onWarn?.(`drain summarizer: ${error}`)
    return {
      items: deterministicItems(input.rendered, deps.maxItems),
      degraded: "summarizer-fallback",
      error,
      errorCode,
      ...(lateReply ? { lateReply: true } : {}),
      model: deps.model || null,
      promptBytes,
      wallMs,
      tokens: null,
      replyBytes: lastReplyBytes,
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
    ): Promise<{ rows: unknown[]; replies: string[]; late: boolean }> => {
      const spawn = async (): Promise<string> => {
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
          },
          query: { directory: deps.directory },
        })
        if (isPromptError(res)) throw new Error(promptErrorText(res?.error))
        return childID
      }

      const read = async (
        id: string,
      ): Promise<{ rows: unknown[]; replies: string[]; late: boolean }> => {
        const messages = await deps.client.session.messages({
          path: { id },
          query: { directory: deps.directory },
        })
        const rows = Array.isArray(messages?.data) ? messages.data : []
        return { rows, replies: assistantReplies(rows), late: false }
      }

      const collect = async (
        id: string,
      ): Promise<{ rows: unknown[]; replies: string[]; late: boolean }> => {
        if (await deps.waitForIdle(id)) return read(id)

        // LATE REPLY: the child may have answered just after the deadline.
        // Read before aborting so a valid reply is never discarded.
        const late = await read(id).catch(() => null)
        const usable = late?.replies.some((reply) => parseSummaryReply(reply) !== null)
        // A timed-out child must not outlive its own wait (§5.2).
        const abortError = await abortChild(id)
        if (late && usable) return { ...late, late: true }
        throw new SummarizeError(
          abortError ? `summarizer timed out; abort failed: ${abortError}` : "summarizer timed out",
          "timeout",
        )
      }

      const childID = await spawn()
      return collect(childID)
    }

    // A malformed block reply gets exactly one correction attempt before the
    // deterministic per-turn fallback (§3.4).
    for (let attempt = 1; ; attempt++) {
      const text =
        attempt === 1
          ? prompt
          : `${prompt}\n\nYour previous reply did not follow the block format. Reply again with only \`=== ITEM ===\` blocks, one per durable topic.`
      const { rows, replies, late } = await ask(text)
      const tokens = usageTokens(rows)

      // Newest first: accept the last block that parses; a trailing "done"
      // acknowledgement falls through to the earlier, well-formed reply.
      const reply =
        replies.find((candidate) => parseSummaryReply(candidate) !== null) ??
        replies[0] ??
        ""
      lastReplyBytes = Buffer.byteLength(reply, "utf8")
      const raw = parseSummaryReply(reply)

      if (!raw) {
        if (attempt < 2) continue
        const suffix = ` (bytes=${lastReplyBytes})`
        if (late) {
          return fallback(
            `late-reply did not parse${suffix}`,
            Date.now() - started,
            "late-reply",
            true,
          )
        }
        return fallback(
          `malformed summarizer reply${suffix}`,
          Date.now() - started,
          "parse-failure",
        )
      }
      if (raw.length === 0) {
        // NO_ITEMS: a clean no-op, not a failure.
        return {
          items: [],
          ...(late ? { lateReply: true } : {}),
          model: deps.model || null,
          promptBytes,
          wallMs: Date.now() - started,
          tokens,
          replyBytes: lastReplyBytes,
        }
      }

      const items = normalizeItems(raw, deps.maxItems, input.rendered.atoms)
      if (items.length === 0) {
        return fallback("no valid items", Date.now() - started, "parse-failure", late)
      }

      return {
        items,
        ...(late ? { lateReply: true } : {}),
        model: deps.model || null,
        promptBytes,
        wallMs: Date.now() - started,
        tokens,
        replyBytes: lastReplyBytes,
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const code: SummarizeFailure =
      err instanceof SummarizeError ? err.code : message.includes("timed out") ? "timeout" : "spawn"
    return fallback(message, Date.now() - started, code)
  }
}


/** Internal marker so the outer catch can classify timeouts without parsing text. */
class SummarizeError extends Error {
  readonly code: SummarizeFailure
  constructor(message: string, code: SummarizeFailure) {
    super(message)
    this.name = "SummarizeError"
    this.code = code
  }
}
