// Writer spawn for the drain pipe (knowledge-pipeline-redesign §A.9).
//
// One hop: create a top-level session and prompt the writer through the pass
// executor, then hand the child rows back to the caller. Completion, deadline,
// and abort live in the executor; this module only maps the outcome to the
// provider's telemetry shape.
//
// Loaded via relative import only.
import type { ChildExecutor, ChildOutcome, ChildRequest } from "../../../../drain/child.ts"

export type SpawnOptions = {
  directory: string
  prompt: string
  /** Writer agent; defaults to rag-brain for interactive-compatible callers. */
  agent?: string
  /** Model from `drain.writer_model`; "" = the agent default. */
  model?: string
  /** Absolute ceiling for the child, in ms. */
  deadlineMs?: number
  /** Kill only after this long with no new progress; 0 = deadline-only. */
  stallMs?: number
}

export type SpawnResult = {
  ok: boolean
  sessionID: string
  /** Newest assistant reply (kept for telemetry/excerpts). */
  reply: string
  /** Assistant replies newest-first. */
  replies: string[]
  /** The child rows, for the typed report parser. */
  rows: unknown[]
  /** A reply arrived after the deadline but was used anyway. */
  lateReply: boolean
  /** The child hit its deadline and was aborted. */
  aborted: boolean
  /** Work may have started (the prompt was accepted). */
  started: boolean
  tokens: number | null
  cost: number | null
  error?: string
  /** Child create + prompt setup observed by the caller (ms). */
  spawnMs?: number | null
  /** Prompt accepted -> first assistant message (queue + TTFT, ms). */
  queueMs?: number | null
  /** Caller wait from prompt accepted to completion (ms). */
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

function toSpawnResult(outcome: ChildOutcome): SpawnResult {
  return {
    ok: outcome.ok,
    sessionID: outcome.sessionID ?? "",
    reply: outcome.replies[0] ?? "",
    replies: outcome.replies,
    rows: outcome.rows,
    lateReply: outcome.late,
    aborted: outcome.timedOut,
    started: outcome.started,
    tokens: outcome.tokens ?? null,
    cost: outcome.cost ?? null,
    ...(outcome.error ? { error: outcome.error } : {}),
    spawnMs: outcome.spawnMs ?? null,
    queueMs: outcome.queueMs ?? null,
    runMs: outcome.runMs ?? null,
    steps: outcome.steps ?? null,
    spanMs: outcome.spanMs ?? null,
    modelMs: outcome.modelMs ?? null,
    toolMs: outcome.toolMs ?? null,
  }
}

/** Spawn the writer once. Never throws for expected failures. */
export async function spawnConsolidationChild(
  executor: ChildExecutor,
  opts: SpawnOptions,
): Promise<SpawnResult> {
  const request: ChildRequest = {
    kind: "write",
    prompt: opts.prompt,
    agent: opts.agent ?? "rag-brain",
    ...(opts.model ? { model: opts.model } : {}),
    deadlineMs: opts.deadlineMs ?? 600_000,
    stallMs: opts.stallMs ?? 0,
  }
  return toSpawnResult(await executor.spawn(request))
}

/** Send one follow-up turn on the same writer session (report correction). */
export async function promptConsolidationChild(
  executor: ChildExecutor,
  sessionID: string,
  opts: SpawnOptions,
): Promise<SpawnResult> {
  const request: ChildRequest = {
    kind: "correct",
    prompt: opts.prompt,
    agent: opts.agent ?? "rag-brain",
    ...(opts.model ? { model: opts.model } : {}),
    deadlineMs: opts.deadlineMs ?? 600_000,
    stallMs: opts.stallMs ?? 0,
  }
  return toSpawnResult(await executor.prompt(sessionID, request))
}
