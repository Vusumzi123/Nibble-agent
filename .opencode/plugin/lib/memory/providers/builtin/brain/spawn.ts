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

export type ConsolidationClient = {
  session: {
    create(args: any): Promise<{ data?: { id?: string } }>
    promptAsync(args: any): Promise<{ error?: unknown; response?: { ok?: boolean } }>
    messages(args: any): Promise<{ data?: any }>
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
}

export type SpawnResult = {
  ok: boolean
  sessionID: string
  reply: string
  tokens: number | null
  cost: number | null
  error?: string
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
      body: { title: "knowledge-consolidate" },
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
