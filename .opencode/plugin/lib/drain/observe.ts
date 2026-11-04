// Completion observer for drain children.
//
// The drain pass is event-independent: after `promptAsync` the coordinator
// polls `client.session.messages` and reads message state. A reply is done when
// `info.time.completed` is set and `finish` is not `tool-calls`. The observer is
// anchored to the prompt's user message (`promptUserID` is the newest user row
// read immediately before the prompt), so a correction prompt on a reused
// session waits for the new reply instead of returning the previous one.
//
// Loaded via relative import only.
import { textOf } from "../sessions.ts"

export type ObservationPhase = "running" | "complete" | "failed" | "timeout"

export type Observation = {
  phase: ObservationPhase
  /** Assistant replies for the prompt's user message, newest first. */
  replies: string[]
  rows: unknown[]
  progress: {
    messages: number
    newestId: string | null
    newestPartAt: number | null
  }
}

export type ObserveOptions = {
  /** Newest user message id read immediately before `promptAsync`. */
  promptUserID?: string | null
  /** Absolute ceiling for this child, in ms. */
  timeoutMs: number
  /** Kill only after this long with no new progress; 0 = deadline-only. */
  stallMs?: number
  /** Poll interval (default 1000 ms). */
  pollMs?: number
  /** Clock seam for tests. */
  now?: () => number
  /** Sleep seam for tests; timers are unref'd by default. */
  sleep?: (ms: number) => Promise<void>
  /** Cancels the poll promptly on coordinator disposal. */
  signal?: AbortSignal
}

type Row = {
  info?: {
    id?: unknown
    role?: unknown
    parentID?: unknown
    finish?: unknown
    error?: unknown
    time?: { created?: unknown; completed?: unknown }
  }
  parts?: unknown[]
}

type ObserveClient = {
  session: { messages(args: any): Promise<{ data?: any }> }
}

function infoOf(row: unknown): Row["info"] {
  return (row as Row | null)?.info ?? {}
}

function partsOf(row: unknown): unknown[] {
  const parts = (row as Row | null)?.parts
  return Array.isArray(parts) ? parts : []
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function createdOf(row: unknown): number | null {
  return numberOrNull(infoOf(row).time?.created)
}

function isUser(row: unknown): boolean {
  return infoOf(row)?.role === "user"
}

function isAssistant(row: unknown): boolean {
  return infoOf(row)?.role === "assistant"
}

/** Newest user message id in a row array, or null. */
export function newestUserMessageID(rows: unknown[]): string | null {
  let best: { id: string; at: number; index: number } | null = null
  for (const [index, row] of (rows ?? []).entries()) {
    if (!isUser(row)) continue
    const id = infoOf(row)?.id
    if (typeof id !== "string" || !id) continue
    const at = createdOf(row) ?? index
    if (!best || at >= best.at) best = { id, at, index }
  }
  return best?.id ?? null
}

/**
 * Pick the prompt's user row (the newest user row that is not the pre-prompt
 * one), then the newest assistant reply whose `parentID` is that user message.
 */
function selectTurn(
  rows: unknown[],
  promptUserID: string | null,
): { userID: string; assistant: unknown | null } | null {
  let user: { id: string; at: number; index: number } | null = null
  for (const [index, row] of (rows ?? []).entries()) {
    if (!isUser(row)) continue
    const id = infoOf(row)?.id
    if (typeof id !== "string" || !id) continue
    if (promptUserID !== null && id === promptUserID) continue
    const at = createdOf(row) ?? index
    if (!user || at >= user.at) user = { id, at, index }
  }
  if (!user) return null

  let assistant: { row: unknown; at: number; index: number } | null = null
  for (const [index, row] of (rows ?? []).entries()) {
    if (!isAssistant(row)) continue
    if (infoOf(row)?.parentID !== user.id) continue
    const at = createdOf(row) ?? index
    if (!assistant || at >= assistant.at) assistant = { row, at, index }
  }
  return { userID: user.id, assistant: assistant?.row ?? null }
}

function repliesFor(rows: unknown[], userID: string): string[] {
  const replies: string[] = []
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (!isAssistant(row) || infoOf(row)?.parentID !== userID) continue
    const text = textOf(partsOf(row)).trim()
    if (text) replies.push(text)
  }
  return replies
}

function progressOf(rows: unknown[]): Observation["progress"] {
  let newestId: string | null = null
  let newestPartAt: number | null = null

  for (const row of rows) {
    const info = infoOf(row) ?? {}
    const id = typeof info.id === "string" && info.id ? info.id : null
    if (id) newestId = id

    const at = createdOf(row)
    if (at !== null) newestPartAt = newestPartAt === null ? at : Math.max(newestPartAt, at)

    const completed = numberOrNull(info.time?.completed)
    if (completed !== null) {
      newestPartAt = newestPartAt === null ? completed : Math.max(newestPartAt, completed)
    }

    for (const part of partsOf(row)) {
      const time = (part as { state?: { time?: { start?: unknown; end?: unknown } } } | null)
        ?.state?.time
      for (const value of [numberOrNull(time?.start), numberOrNull(time?.end)]) {
        if (value !== null) newestPartAt = newestPartAt === null ? value : Math.max(newestPartAt, value)
      }
    }
  }

  return { messages: rows.length, newestId, newestPartAt }
}

function evaluate(
  rows: unknown[],
  promptUserID: string | null,
  timedOut: boolean,
): Observation {
  const progress = progressOf(rows)
  const turn = selectTurn(rows, promptUserID)
  const replies = turn ? repliesFor(rows, turn.userID) : []

  if (!turn || !turn.assistant) {
    return { phase: timedOut ? "timeout" : "running", replies, rows, progress }
  }

  const info = infoOf(turn.assistant) ?? {}
  const completed = numberOrNull(info.time?.completed) !== null
  const finish = info.finish
  const running = !completed || finish === "tool-calls"
  if (running) {
    return { phase: timedOut ? "timeout" : "running", replies, rows, progress }
  }

  const failed = !!info.error || finish === "error"
  return {
    phase: timedOut ? "timeout" : failed ? "failed" : "complete",
    replies,
    rows,
    progress,
  }
}

function progressKey(progress: Observation["progress"]): string {
  return `${progress.messages}:${progress.newestId ?? ""}:${progress.newestPartAt ?? ""}`
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    timer.unref?.()
    function done(): void {
      signal?.removeEventListener("abort", done)
      resolve()
    }
    signal?.addEventListener("abort", done, { once: true })
  })
}

/**
 * Poll one child session until its reply is complete, failed, or the deadline
 * passes. On the deadline the rows are read once more; a reply that landed
 * late is returned with `phase: "timeout"` so the caller can accept it as
 * `late: true`. The observer never aborts the child.
 */
export async function observeSession(
  client: ObserveClient,
  directory: string,
  sessionID: string,
  opts: ObserveOptions,
): Promise<Observation> {
  const pollMs = Math.max(1, Math.floor(opts.pollMs ?? 1000))
  const now = opts.now ?? Date.now
  const sleep = (ms: number) =>
    opts.sleep ? opts.sleep(ms) : defaultSleep(ms, opts.signal)
  const promptUserID = opts.promptUserID ?? null
  const timeoutMs = Math.max(0, opts.timeoutMs)
  const stallMs = Math.max(0, Math.floor(opts.stallMs ?? 0))
  const deadline = now() + timeoutMs
  let lastProgressKey = ""
  let lastProgressAt = now()

  const read = async (): Promise<unknown[]> => {
    const res = await client.session.messages({
      path: { id: sessionID },
      query: { directory },
    })
    return Array.isArray(res?.data) ? res.data : []
  }

  for (;;) {
    const rows = await read()
    const observation = evaluate(rows, promptUserID, false)
    if (observation.phase !== "running") return observation

    const at = now()
    const key = progressKey(observation.progress)
    if (key !== lastProgressKey) {
      lastProgressKey = key
      lastProgressAt = at
    }
    const idleMs = at - lastProgressAt
    const stalled = stallMs > 0 && idleMs >= stallMs
    if (at >= deadline || stalled) {
      const finalRows = await read()
      return evaluate(finalRows, promptUserID, true)
    }

    const remaining = Math.min(
      deadline - at,
      stallMs > 0 ? stallMs - idleMs : Number.POSITIVE_INFINITY,
    )
    await sleep(Math.max(1, Math.min(pollMs, remaining)))
    if (opts.signal?.aborted) {
      const finalRows = await read()
      return evaluate(finalRows, promptUserID, true)
    }
  }
}
