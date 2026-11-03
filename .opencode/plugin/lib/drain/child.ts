// Child execution seam for the drain pass.
//
// One executor per pass owns every summarizer/writer child: create, prompt,
// poll for completion, abort, and telemetry. The coordinator calls it under a
// task policy; the summarizer and writer adapters call the same interface, so
// there is exactly one completion mechanism (persisted state, polled).
//
// Loaded via relative import only.
import { newestUserMessageID, observeSession } from "./observe.ts"
import { sessionAccounting } from "../transcript.ts"
import { SUMMARIZER_SESSION_TITLE, WRITER_SESSION_TITLE } from "./automation.ts"

export type ChildKind = "summarize" | "write" | "correct"

export type ChildClient = {
  session: {
    create(args: any): Promise<{ data?: { id?: string } }>
    promptAsync(args: any): Promise<{ error?: unknown; response?: { ok?: boolean } }>
    messages(args: any): Promise<{ data?: any }>
    abort(args: any): Promise<{ error?: unknown; response?: { ok?: boolean; status?: number } }>
  }
}

export type ChildRequest = {
  /** Task id from the coordinator; the outcome keeps it. */
  id?: string
  kind: ChildKind
  prompt: string
  agent?: string
  model?: string
  title?: string
  /** Hard deadline for this child, in ms. */
  deadlineMs: number
}

export type ChildOutcome = {
  jobId: string
  sessionID: string | null
  phase: "complete" | "failed" | "timeout"
  ok: boolean
  /** Work may have started (the prompt was accepted). */
  started: boolean
  rows: unknown[]
  replies: string[]
  /** A reply was present when the deadline hit. */
  late: boolean
  timedOut: boolean
  error?: string
  errorKind?: "transient" | "permanent"
  attempts: number
  spawnMs?: number | null
  queueMs?: number | null
  runMs?: number | null
  steps?: number | null
  spanMs?: number | null
  modelMs?: number | null
  toolMs?: number | null
  tokens?: number | null
  cost?: number | null
}

export type ChildExecutor = {
  spawn(job: ChildRequest): Promise<ChildOutcome>
  prompt(sessionID: string, job: ChildRequest): Promise<ChildOutcome>
  abort(sessionID: string): Promise<void>
}

export type ChildExecutorHandle = ChildExecutor & {
  /** Abort every active child and settle their observers. */
  cancelAll(): Promise<void>
  activeSessions(): string[]
}

export type ChildExecutorDeps = {
  client: ChildClient
  directory: string
  registerChild?: (sessionID: string) => void
  unregisterChild?: (sessionID: string) => void
  onStart?: (sessionID: string, request: ChildRequest) => void
  onEnd?: (outcome: ChildOutcome) => void
  titles?: Partial<Record<ChildKind, string>>
}

const DEFAULT_TITLES: Record<ChildKind, string> = {
  summarize: SUMMARIZER_SESSION_TITLE,
  write: WRITER_SESSION_TITLE,
  correct: WRITER_SESSION_TITLE,
}

function errorText(err: unknown): string {
  if (typeof err === "string" && err) return err
  const message = (err as { message?: unknown } | undefined)?.message
  if (typeof message === "string" && message) return message
  return "child failed"
}

function isPromptError(res: { error?: unknown; response?: { ok?: boolean } } | undefined): boolean {
  return !!res?.error || !!(res?.response && !res.response.ok)
}

function usage(rows: unknown[]): { tokens: number | null; cost: number | null } {
  let tokens: number | null = null
  let cost: number | null = null
  for (const row of rows ?? []) {
    const info = (row as { info?: Record<string, any> })?.info
    if (!info || info.role !== "assistant") continue
    const t = info.tokens
    if (t && typeof t === "object") {
      const sum = Number(t.input ?? 0) + Number(t.output ?? 0) + Number(t.reasoning ?? 0)
      if (Number.isFinite(sum)) tokens = (tokens ?? 0) + sum
    }
    const c = Number(info.cost ?? NaN)
    if (Number.isFinite(c)) cost = (cost ?? 0) + c
  }
  return { tokens, cost }
}

function failure(
  jobId: string,
  message: string,
  started: boolean,
  sessionID: string | null,
  extra: Partial<ChildOutcome> = {},
): ChildOutcome {
  return {
    jobId,
    sessionID,
    phase: "failed",
    ok: false,
    started,
    rows: [],
    replies: [],
    late: false,
    timedOut: false,
    error: message,
    errorKind: "transient",
    attempts: 1,
    ...extra,
  }
}

export function createChildExecutor(deps: ChildExecutorDeps): ChildExecutorHandle {
  const controllers = new Map<string, AbortController>()
  const sessions = new Set<string>()

  const read = async (sessionID: string): Promise<unknown[]> => {
    const res = await deps.client.session.messages({
      path: { id: sessionID },
      query: { directory: deps.directory },
    })
    return Array.isArray(res?.data) ? res.data : []
  }

  const prePromptUserID = async (sessionID: string): Promise<string | null> => {
    try {
      return newestUserMessageID(await read(sessionID))
    } catch {
      return null
    }
  }

  const abort = async (sessionID: string): Promise<void> => {
    try {
      await deps.client.session.abort({
        path: { id: sessionID },
        query: { directory: deps.directory },
      })
    } catch {
      /* best effort */
    }
  }

  const finish = (outcome: ChildOutcome): ChildOutcome => {
    deps.onEnd?.(outcome)
    if (outcome.sessionID) {
      sessions.delete(outcome.sessionID)
      controllers.delete(outcome.sessionID)
      deps.unregisterChild?.(outcome.sessionID)
    }
    return outcome
  }

  const observe = async (
    request: ChildRequest,
    sessionID: string,
    promptUserID: string | null,
    setupStartedAt: number,
    acceptedAt: number,
  ): Promise<ChildOutcome> => {
    const controller = new AbortController()
    controllers.set(sessionID, controller)
    const observeStarted = performance.now()
    let observation
    try {
      observation = await observeSession(deps.client, deps.directory, sessionID, {
        promptUserID,
        timeoutMs: request.deadlineMs,
        signal: controller.signal,
      })
    } catch (err) {
      await abort(sessionID)
      return finish(
        failure(request.id ?? sessionID, errorText(err), true, sessionID, {
          phase: "failed",
        }),
      )
    }
    const runMs = performance.now() - observeStarted
    if (observation.phase === "timeout" && !controller.signal.aborted) await abort(sessionID)

    const acct = sessionAccounting(observation.rows)
    const account = usage(observation.rows)
    const firstCreated = observation.rows
      .map((row) => Number((row as any)?.info?.time?.created ?? NaN))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b)[0]

    const failedRow = observation.rows
      .slice()
      .reverse()
      .find((row) => (row as any)?.info?.role === "assistant")

    return finish({
      jobId: request.id ?? sessionID,
      sessionID,
      phase: observation.phase,
      ok: observation.phase === "complete",
      started: true,
      rows: observation.rows,
      replies: observation.replies,
      late: observation.phase === "timeout" && observation.replies.length > 0,
      timedOut: observation.phase === "timeout",
      ...(observation.phase === "failed"
        ? {
            error: errorText((failedRow as any)?.info?.error ?? "child failed"),
            errorKind: "transient" as const,
          }
        : {}),
      attempts: 1,
      spawnMs: Math.round(acceptedAt - setupStartedAt),
      queueMs:
        firstCreated === undefined ? null : Math.max(0, Math.round(firstCreated - acceptedAt)),
      runMs: Math.round(runMs),
      steps: acct.assistantSteps,
      spanMs: acct.spanMs,
      modelMs: acct.modelMs,
      toolMs: acct.toolMs,
      tokens: account.tokens,
      cost: account.cost,
    })
  }

  const spawn = async (request: ChildRequest): Promise<ChildOutcome> => {
    const setupStartedAt = performance.now()
    let sessionID = ""
    try {
      const created = await deps.client.session.create({
        body: { title: request.title ?? deps.titles?.[request.kind] ?? DEFAULT_TITLES[request.kind] },
        query: { directory: deps.directory },
      })
      sessionID = String(created?.data?.id ?? "")
      if (!sessionID) return failure(request.id ?? "", "session.create returned no id", false, null)
      sessions.add(sessionID)
      deps.registerChild?.(sessionID)
      deps.onStart?.(sessionID, request)

      const promptUserID = await prePromptUserID(sessionID)
      const res = await deps.client.session.promptAsync({
        path: { id: sessionID },
        body: {
          ...(request.agent ? { agent: request.agent } : {}),
          ...(request.model ? { model: request.model } : {}),
          parts: [{ type: "text", text: request.prompt }],
        },
        query: { directory: deps.directory },
      })
      const acceptedAt = Date.now()
      if (isPromptError(res)) {
        await abort(sessionID)
        return finish(
          failure(request.id ?? sessionID, "promptAsync failed", false, sessionID, {
            spawnMs: Math.round(acceptedAt - setupStartedAt),
          }),
        )
      }
      return await observe(request, sessionID, promptUserID, setupStartedAt, acceptedAt)
    } catch (err) {
      if (sessionID) await abort(sessionID)
      return finish(
        failure(request.id ?? sessionID, errorText(err), false, sessionID || null, {
          spawnMs: Math.round(performance.now() - setupStartedAt),
        }),
      )
    }
  }

  const prompt = async (sessionID: string, request: ChildRequest): Promise<ChildOutcome> => {
    const setupStartedAt = performance.now()
    try {
      const promptUserID = await prePromptUserID(sessionID)
      const res = await deps.client.session.promptAsync({
        path: { id: sessionID },
        body: {
          ...(request.agent ? { agent: request.agent } : {}),
          ...(request.model ? { model: request.model } : {}),
          parts: [{ type: "text", text: request.prompt }],
        },
        query: { directory: deps.directory },
      })
      const acceptedAt = Date.now()
      if (isPromptError(res)) {
        return finish(
          failure(request.id ?? sessionID, "promptAsync failed", false, sessionID, {
            spawnMs: Math.round(acceptedAt - setupStartedAt),
          }),
        )
      }
      return await observe(request, sessionID, promptUserID, setupStartedAt, acceptedAt)
    } catch (err) {
      return finish(
        failure(request.id ?? sessionID, errorText(err), false, sessionID, {
          spawnMs: Math.round(performance.now() - setupStartedAt),
        }),
      )
    }
  }

  const cancelAll = async (): Promise<void> => {
    for (const controller of controllers.values()) controller.abort()
    await Promise.all([...sessions].map((sessionID) => abort(sessionID)))
  }

  return {
    spawn,
    prompt,
    abort,
    cancelAll,
    activeSessions: () => [...sessions],
  }
}
