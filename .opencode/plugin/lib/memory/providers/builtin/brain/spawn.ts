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
  reply: string
  tokens: number | null
  cost: number | null
  error?: string
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

function lastAssistantText(rows: unknown[]): string {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i] as { info?: { role?: unknown }; parts?: unknown[] }
    if (row?.info?.role !== "assistant") continue
    const text = textOf(row.parts ?? []).trim()
    if (text) return text
  }
  return ""
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
  try {
    const created = await client.session.create({
      body: { title: WRITER_SESSION_TITLE },
      query: { directory: opts.directory },
    })
    sessionID = String(created?.data?.id ?? "")
    if (!sessionID) return { ok: false, sessionID, reply: "", tokens: null, cost: null, error: "session.create returned no id" }
    opts.registerChild?.(sessionID)

    const res = await client.session.promptAsync({
      path: { id: sessionID },
      body: {
        agent: "rag-brain",
        ...(opts.model ? { model: opts.model } : {}),
        parts: [{ type: "text", text: opts.prompt }],
      },
      query: { directory: opts.directory },
    })
    if (res?.error || (res?.response && !res.response.ok)) {
      return { ok: false, sessionID, reply: "", tokens: null, cost: null, error: "promptAsync failed" }
    }

    if (!(await opts.waitForIdle(sessionID))) {
      // Never leave the writer alive past its own timeout (§5.2): abort, then
      // confirm with a FRESH bounded idle wait before reporting the timeout.
      const abortError = await abortChild(client, opts.directory, sessionID)
      if (abortError) {
        return {
          ok: false,
          sessionID,
          reply: "",
          tokens: null,
          cost: null,
          error: `timeout; abort failed: ${abortError}`,
        }
      }
      const confirmMs = opts.abortConfirmMs ?? ABORT_CONFIRM_MS
      const confirmed = await waitWithin(opts.waitForIdle(sessionID), confirmMs)
      if (!confirmed) {
        return {
          ok: false,
          sessionID,
          reply: "",
          tokens: null,
          cost: null,
          error: `timeout; abort not confirmed within ${confirmMs}ms`,
        }
      }
      return { ok: false, sessionID, reply: "", tokens: null, cost: null, error: "timeout" }
    }

    const messages = await client.session.messages({
      path: { id: sessionID },
      query: { directory: opts.directory },
    })
    const rows = Array.isArray(messages?.data) ? messages.data : []
    const reply = lastAssistantText(rows)
    const { tokens, cost } = usage(rows)

    return { ok: true, sessionID, reply, tokens, cost }
  } catch (err) {
    return {
      ok: false,
      sessionID,
      reply: "",
      tokens: null,
      cost: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
