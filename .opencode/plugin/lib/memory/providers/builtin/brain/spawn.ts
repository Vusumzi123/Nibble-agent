// Writer spawn for the drain pipe (knowledge-pipeline-redesign §A.9).
//
// One hop: create a top-level session, then prompt `rag-brain` directly with
// the consolidation prompt. The model comes from drain.writer_model; no default
// agent sits in between. The idle wait is supplied by the caller (the mission
// runner owns the event hook), and a timeout is non-fatal: the caller decides
// whether to retry or poison the batch.
//
// Loaded via relative import only.
import { textOf } from "../../../../sessions.ts"
import { sessionAccounting } from "../../../../transcript.ts"
import { WRITER_SESSION_TITLE } from "../../../../drain/automation.ts"

export type ConsolidationClient = {
  session: {
    create(args: any): Promise<{ data?: { id?: string } }>
    promptAsync(args: any): Promise<{ error?: unknown; response?: { ok?: boolean } }>
    messages(args: any): Promise<{ data?: any }>
    abort(args: any): Promise<{ error?: unknown; response?: { ok?: boolean; status?: number } }>
  }
}

export type SpawnOptions = {
  directory: string
  prompt: string
  /** Writer agent; defaults to rag-brain for interactive-compatible callers. */
  agent?: string
  /** Model from `drain.writer_model`; "" = the agent default. */
  model?: string
  /** Bounded wait for the child to go idle; false = timeout. */
  waitForIdle: (sessionID: string) => Promise<boolean>
  registerChild?: (sessionID: string) => void
  /** Post-abort idle confirmation budget (default 10 s, abortSession discipline). */
  abortConfirmMs?: number
}

export type SpawnResult = {
  ok: boolean
  sessionID: string
  /** Newest assistant reply (kept for telemetry/excerpts). */
  reply: string
  /** Assistant replies newest-first; the last valid report wins. */
  replies: string[]
  /** A reply arrived after the idle deadline but was used anyway. */
  lateReply: boolean
  /** The child was aborted after the wait timed out; its reply is untrusted. */
  aborted: boolean
  tokens: number | null
  cost: number | null
  error?: string
  /** Child create + prompt setup observed by the caller (ms). */
  spawnMs?: number | null
  /** Prompt accepted -> first assistant message (queue + TTFT, ms). */
  queueMs?: number | null
  /** Caller wait from prompt accepted to idle (ms). */
  runMs?: number | null
  /** Assistant steps in the child session. */
  steps?: number | null
  /** Assistant wall span from first start to last completion (ms). */
  spanMs?: number | null
  /** Sum of assistant generation time (ms). */
  modelMs?: number | null
  /** Sum of tool-call execution time (ms). */
  toolMs?: number | null
}

const ABORT_CONFIRM_MS = 10_000

/** Race a bounded idle wait against a fresh confirmation budget. */
function waitWithin(wait: Promise<boolean>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = ms > 0 ? setTimeout(() => resolve(false), ms) : null
    timer?.unref?.()
    const settle = (value: boolean): void => {
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    wait.then(settle, () => settle(false))
  })
}

async function abortChild(
  client: ConsolidationClient,
  directory: string,
  sessionID: string,
): Promise<string | null> {
  try {
    const res = await client.session.abort({
      path: { id: sessionID },
      query: { directory },
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

export function assistantReplies(rows: unknown[]): string[] {
  const replies: string[] = []
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i] as { info?: { role?: unknown }; parts?: unknown[] }
    if (row?.info?.role !== "assistant") continue
    const text = textOf(row.parts ?? []).trim()
    if (text) replies.push(text)
  }
  return replies
}

function usage(rows: unknown[]): { tokens: number | null; cost: number | null } {
  let tokens: number | null = null
  let cost: number | null = null

  for (const row of rows) {
    const info = (row as { info?: Record<string, any> })?.info
    if (!info || info.role !== "assistant") continue

    const t = info.tokens
    if (t && typeof t === "object") {
      const sum =
        Number(t.input ?? 0) + Number(t.output ?? 0) + Number(t.reasoning ?? 0)
      if (Number.isFinite(sum)) tokens = (tokens ?? 0) + sum
    }
    const c = Number(info.cost ?? NaN)
    if (Number.isFinite(c)) cost = (cost ?? 0) + c
  }

  return { tokens, cost }
}

/**
 * Spawn the writer and wait for its reply. Never throws for expected failures
 * (create/prompt/timeout); the result carries `ok: false` and an error string.
 */
export async function spawnConsolidationChild(
  client: ConsolidationClient,
  opts: SpawnOptions,
): Promise<SpawnResult> {
  let sessionID = ""
  let timing: Pick<
    SpawnResult,
    "spawnMs" | "queueMs" | "runMs" | "steps" | "spanMs" | "modelMs" | "toolMs"
  > = {
    spawnMs: null,
    queueMs: null,
    runMs: null,
    steps: null,
    spanMs: null,
    modelMs: null,
    toolMs: null,
  }
  const timingFromRows = (rows: unknown[], acceptedAt: number): void => {
    const acct = sessionAccounting(rows)
    const times = rows
      .map((row) => Number((row as any)?.info?.time?.created ?? NaN))
      .filter((value) => Number.isFinite(value))
    const first = times.length > 0 ? Math.min(...times) : null
    timing = {
      ...timing,
      queueMs: first === null ? null : Math.max(0, Math.round(first - acceptedAt)),
      steps: acct.assistantSteps,
      spanMs: acct.spanMs,
      modelMs: acct.modelMs,
      toolMs: acct.toolMs,
    }
  }
  try {
    const createStarted = performance.now()
    const created = await client.session.create({
      body: { title: WRITER_SESSION_TITLE },
      query: { directory: opts.directory },
    })
    sessionID = String(created?.data?.id ?? "")
    timing.spawnMs = Math.round(performance.now() - createStarted)
    if (!sessionID) {
      return {
        ok: false,
        sessionID,
        reply: "",
        replies: [],
        lateReply: false,
        aborted: false,
        tokens: null,
        cost: null,
        error: "session.create returned no id",
        ...timing,
      }
    }
    opts.registerChild?.(sessionID)

    const res = await client.session.promptAsync({
      path: { id: sessionID },
      body: {
        agent: opts.agent ?? "rag-brain",
        ...(opts.model ? { model: opts.model } : {}),
        parts: [{ type: "text", text: opts.prompt }],
      },
      query: { directory: opts.directory },
    })
    const acceptedAt = Date.now()
    if (res?.error || (res?.response && !res.response.ok)) {
      return {
        ok: false,
        sessionID,
        reply: "",
        replies: [],
        lateReply: false,
        aborted: false,
        tokens: null,
        cost: null,
        error: "promptAsync failed",
        ...timing,
      }
    }

    const read = async (): Promise<unknown[]> => {
      const messages = await client.session.messages({
        path: { id: sessionID },
        query: { directory: opts.directory },
      })
      return Array.isArray(messages?.data) ? messages.data : []
    }

    const waitStarted = performance.now()
    const idled = await opts.waitForIdle(sessionID)
    timing.runMs = Math.round(performance.now() - waitStarted)
    if (!idled) {
      // LATE REPLY: read before aborting so a report that landed just after the
      // deadline is still used. The child never outlives the wait either way.
      const lateRows = await read().catch(() => [] as unknown[])
      const abortError = await abortChild(client, opts.directory, sessionID)
      const lateReplies = assistantReplies(lateRows)
      timingFromRows(lateRows, acceptedAt)
      if (lateReplies.length > 0) {
        const { tokens, cost } = usage(lateRows)
        return {
          ok: true,
          sessionID,
          reply: lateReplies[0] ?? "",
          replies: lateReplies,
          lateReply: true,
          aborted: true,
          tokens,
          cost,
          ...timing,
        }
      }
      if (abortError) {
        return {
          ok: false,
          sessionID,
          reply: "",
          replies: [],
          lateReply: false,
          aborted: false,
          tokens: null,
          cost: null,
          error: `timeout; abort failed: ${abortError}`,
          ...timing,
        }
      }
      const confirmMs = opts.abortConfirmMs ?? ABORT_CONFIRM_MS
      const confirmed = await waitWithin(opts.waitForIdle(sessionID), confirmMs)
      if (!confirmed) {
        return {
          ok: false,
          sessionID,
          reply: "",
          replies: [],
          lateReply: false,
          aborted: false,
          tokens: null,
          cost: null,
          error: `timeout; abort not confirmed within ${confirmMs}ms`,
          ...timing,
        }
      }
      return {
        ok: false,
        sessionID,
        reply: "",
        replies: [],
        lateReply: false,
        aborted: false,
        tokens: null,
        cost: null,
        error: "timeout",
        ...timing,
      }
    }

    const rows = await read()
    const replies = assistantReplies(rows)
    const { tokens, cost } = usage(rows)
    timingFromRows(rows, acceptedAt)

    return {
      ok: true,
      sessionID,
      reply: replies[0] ?? "",
      replies,
      lateReply: false,
      aborted: false,
      tokens,
      cost,
      ...timing,
    }
  } catch (err) {
    return {
      ok: false,
      sessionID,
      reply: "",
      replies: [],
      lateReply: false,
      aborted: false,
      tokens: null,
      cost: null,
      error: err instanceof Error ? err.message : String(err),
      ...timing,
    }
  }
}
