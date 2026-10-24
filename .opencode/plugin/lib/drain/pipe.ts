// Drain pipe orchestration (knowledge-pipeline-redesign §A.12,
// drain-consumer-plan §2.2–§2.7).
//
// One run: load cursor -> discover/fetch -> render -> summarize -> hand the
// items to the active memory provider's writer -> map its WriteReport to
// per-session cursor marks. There is no lock: the single heartbeat loop runs
// one work unit at a time, so every caller (tick step, `drain_run` tool) is
// already serialized against the rest of the harness (deconcurrency plan,
// Phase 1).
//
// Cursor v2 (§2.3): discovery is watermark-based; fetch uses each session's
// own mark. The watermark never advances past a marked session that still has
// unconsumed work (its mark floors the advance), so pending counts and
// rediscovery stay correct; fully-consumed sessions contribute their marks as
// the new candidate bound. A per-pass `token_budget` is checked between units
// — never mid-unit — and a budget-stopped pass advances only the sessions
// whose items were fully reported (§2.2).
//
// The pipe writes no vault notes and knows nothing about the writer's prompt
// internals: the only contract is `WriteReport` (memory/types.ts). A run that
// cannot report every item does not advance the affected session; transient
// failures back off, permanent failures count toward poison.
//
// Loaded via relative import only.
import type { DrainConfig } from "./config.ts"
import {
  advanceSession,
  advanceWatermark,
  defaultCursor,
  loadCursor,
  pruneSessions,
  recordFailure,
  resolveCursorFile,
  saveCursor,
  sessionMarkTs,
  sessionMarks,
  type DrainCursor,
} from "./cursor.ts"
import { openDrainSource, type DrainSource } from "./db.ts"
import type { DrainLedger } from "./ledger.ts"
import { renderSession, type RenderedSession } from "./render.ts"
import { summarizeSession, type SummaryItem, type SummarizerClient } from "./summarize.ts"
import type {
  MemoryProvider,
  MemoryWriteClient,
  WriteContext,
  WriteItem,
  WriteReport,
} from "../memory/types.ts"

export type DrainOutcome = "completed" | "nothing" | "degraded" | "error" | "dropped"

/** Why the pass stopped early (§2.2). */
export type DrainStopReason = "token-budget"

export type DrainPipeResult = {
  outcome: DrainOutcome
  sessions: number
  items: number
  consolidated: number
  skipped: number
  cursorBefore: number
  cursorAfter: number
  /** Writer child session (the UI's output/thoughts transcript). */
  session?: string | null
  /** Billable tokens (summarizer + writer) spent by the run. */
  tokens?: number | null
  degraded?: "schema-mismatch" | "summarizer-fallback" | "sdk-fallback" | "budget-exhausted"
  error?: string
  /** Early stop: the per-pass budget ran out between units (§2.2). */
  stopped?: DrainStopReason | null
  pendingBefore?: number | null
  pendingAfter?: number | null
  oldestPendingAgeMs?: number | null
  budgetRemaining?: number | null
}

/** One-line mission summary for the heartbeat/dream ledger and backlog. */
export function formatDrainResult(result: DrainPipeResult): string {
  const bits = [
    `drain:${result.outcome}`,
    `${result.sessions} session(s)`,
    `${result.items} item(s)`,
    `${result.consolidated} consolidated`,
    `${result.skipped} skipped`,
    `cursor ${result.cursorBefore}->${result.cursorAfter}`,
  ]
  if (result.stopped) bits.push(`stopped:${result.stopped}`)
  if (result.degraded) bits.push(`degraded:${result.degraded}`)
  if (result.error) bits.push(`error:${result.error}`)
  return bits.join(", ")
}

export type DrainPipeClient = SummarizerClient & MemoryWriteClient

/** Where this pass was invoked from (§5.1 `trigger`). */
export type DrainTrigger = "consumer" | "tick" | "tool" | "dream"

export type DrainPipeDeps = {
  directory: string
  stateDir: string
  vaultDir: string
  config: DrainConfig
  client: DrainPipeClient
  /** The single active memory provider; its writer owns consolidation. */
  provider?: MemoryProvider
  /** Bounded wait for a child session to go idle. */
  waitForIdle: (sessionID: string) => Promise<boolean>
  registerChild?: (sessionID: string) => void
  /** Test/E2E override; defaults to the opencode data dir. */
  dbFile?: string
  ledger?: DrainLedger
  /** Invocation source recorded on the pipe ledger line (§5.1). */
  trigger?: DrainTrigger
  /** Index within the current consumer wake (§5.1). */
  pass?: number
  onWarn?: (message: string, err?: unknown) => void
}

type PlannedItem = { item: SummaryItem; sessionID: string; ts: number }

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function maxTurnTime(renderings: RenderedSession[]): number {
  let max = 0
  for (const rendered of renderings) {
    for (const turn of rendered.turns) max = Math.max(max, turn.time)
  }
  return max
}

type PlannedChunk = { offset: number; items: PlannedItem[] }

/** Split planned items into writer-sized chunks. Each chunk is a complete
 *  `#1..N` batch for the provider, so a spawn never exceeds the step budget;
 *  `offset` maps chunk-local labels back to the run-wide labels. */
export function chunkPlanned(planned: PlannedItem[], size: number): PlannedChunk[] {
  if (planned.length === 0) return []
  const cap = Number.isFinite(size) && size > 0 ? Math.floor(size) : planned.length
  const chunks: PlannedChunk[] = []
  for (let i = 0; i < planned.length; i += cap) {
    chunks.push({ offset: i, items: planned.slice(i, i + cap) })
  }
  return chunks
}

/**
 * Run one drain cycle. Always resolves with a result; expected failures are
 * outcomes, not throws. The cursor is saved only on advance or failure
 * accounting. There is no lock: the single heartbeat loop is the executor.
 */
export async function runDrainPipe(deps: DrainPipeDeps): Promise<DrainPipeResult> {
  const started = Date.now()
  const cfg = deps.config
  const cursorFile = resolveCursorFile(deps.stateDir, cfg.cursor_file)

  let cursor: DrainCursor
  try {
    cursor = await loadCursor(cursorFile, deps.onWarn)
  } catch (err) {
    // loadCursor is total, but a broken state dir must not crash the mission.
    deps.onWarn?.("drain pipe: cursor load failed", err)
    cursor = defaultCursor()
  }

  // A fresh cursor starts at epoch and would replay every session in the DB,
  // oldest first. Seed it to a bounded lookback instead; 0 keeps the
  // historical behavior (consolidate from the beginning of history).
  if (cursor.watermark_ts <= 0 && cfg.initial_lookback_hours > 0) {
    cursor = advanceWatermark(cursor, Date.now() - cfg.initial_lookback_hours * 3_600_000)
    try {
      await saveCursor(cursorFile, cursor)
    } catch (err) {
      deps.onWarn?.("drain pipe: cursor bootstrap save failed", err)
    }
  }

  const cursorBefore = cursor.watermark_ts
  const budget = cfg.token_budget > 0 ? cfg.token_budget : Infinity
  let promptBytes: number | undefined
  let totalTokens = 0
  let summarizeReplyBytes: number | null = null
  let pendingBefore: number | null = null
  let pendingAfter: number | null = null
  let oldestAgeMs: number | null = null
  let stopped: DrainStopReason | null = null

  const budgetRemaining = (): number | null =>
    Number.isFinite(budget) ? Math.max(0, Math.floor(budget - totalTokens)) : null

  const emit = async (result: DrainPipeResult): Promise<DrainPipeResult> => {
    try {
      await deps.ledger?.write({
        source: "pipe",
        outcome: result.outcome,
        model: cfg.writer_model || null,
        summarize_model: cfg.summarize_model || null,
        prompt_bytes: promptBytes ?? null,
        tokens: totalTokens || null,
        sessions: result.sessions,
        items: result.items,
        cursor_before: result.cursorBefore,
        cursor_after: result.cursorAfter,
        degraded: result.degraded ?? null,
        error: result.error ?? null,
        ...(summarizeReplyBytes !== null ? { reply_bytes: summarizeReplyBytes } : {}),
        wall_ms: Date.now() - started,
        ...(deps.trigger ? { trigger: deps.trigger } : {}),
        ...(deps.pass !== undefined ? { pass: deps.pass } : {}),
        ...(pendingBefore !== null ? { pending_before: pendingBefore } : {}),
        ...(pendingAfter !== null ? { pending_after: pendingAfter } : {}),
        ...(oldestAgeMs !== null ? { oldest_pending_age_ms: oldestAgeMs } : {}),
        ...(stopped ? { stopped } : {}),
        ...(Number.isFinite(budget) ? { budget_remaining: budgetRemaining() } : {}),
      })
    } catch {
      /* fail-open */
    }
    return result
  }

  const stuck = async (
    error?: string,
    degraded: DrainPipeResult["degraded"] = undefined,
    sessions: number = 0,
  ): Promise<DrainPipeResult> =>
    emit({
      outcome: "nothing",
      sessions,
      items: 0,
      consolidated: 0,
      skipped: 0,
      cursorBefore,
      cursorAfter: cursor.watermark_ts,
      tokens: totalTokens || null,
      degraded,
      ...(error ? { error } : {}),
    })

  if (!cfg.enabled) return stuck()
  // Complete-disable / read-only profiles: never open the DB, never advance.
  if (!deps.provider || !deps.provider.consolidate) {
    return stuck("memory provider has no writer")
  }

  // The single heartbeat loop is the executor: no drain.lock, no mission.lock.
  let source: DrainSource
  try {
    source = await openDrainSource({
      projectDir: deps.directory,
      client: deps.client,
      dbFile: deps.dbFile,
      excludeMissions: cfg.exclude_missions,
      onWarn: deps.onWarn,
    })
  } catch (err) {
    return emit({
      outcome: "error",
      sessions: 0,
      items: 0,
      consolidated: 0,
      skipped: 0,
      cursorBefore,
      cursorAfter: cursor.watermark_ts,
      error: errorText(err),
    })
  }

  let degraded: DrainPipeResult["degraded"] = source.degraded
  let error: string | undefined

  try {
    pendingBefore = await source.unconsumedCount(cursor.watermark_ts, sessionMarks(cursor))
    const sessions = await source.discover(cursor.watermark_ts, cfg.batch_sessions)
    const renderings: RenderedSession[] = []
    // Per-session fetch marks + the watermark floor rule (§2.3): a discovered
    // session with unconsumed work above its mark floors the watermark so it
    // is re-discovered; a fully-consumed session contributes its mark as the
    // candidate bound.
    const floorMarks: number[] = []
    const consumedMarks: number[] = []
    // Activity time of sessions with no renderable turns: they are consumed, so
    // the watermark may advance over them even though their mark does not.
    const consumedUpTo: number[] = []
    const settleCutoff = Date.now() - Math.max(0, cfg.settle_seconds) * 1000

    for (const session of sessions) {
      // Settle guard (§2.3): only consume a session that has been idle for
      // settle_seconds — a streaming assistant message is never read mid-flight.
      if (cfg.settle_seconds > 0 && session.timeUpdated >= settleCutoff) {
        floorMarks.push(sessionMarkTs(cursor, session.id))
        continue
      }

      let mark = sessionMarkTs(cursor, session.id)
      // Unknown mark + recover mode (§2.3.1): start at the session's own
      // creation time, floored at watermark - lookback. Carry mode keeps the
      // watermark (conservative: no re-read).
      if (cfg.cursor_migration === "recover" && !cursor.sessions[session.id]) {
        const floor = Math.max(0, cursor.watermark_ts - cfg.initial_lookback_hours * 3_600_000)
        mark = Math.max(session.timeCreated || 0, floor)
      }

      const turns = await source.fetch(session.id, mark, cfg.max_turns_per_session)
      if (turns.length === 0) {
        consumedMarks.push(mark)
        consumedUpTo.push(Math.max(mark, session.timeUpdated || 0))
        continue
      }
      const rendered = renderSession(session.id, turns, {
        maxBytes: cfg.max_session_bytes,
        priorSummary: cursor.sessions[session.id]?.summary || null,
      })
      if (!rendered) {
        // Turn rows existed but rendered empty — treat as consumed at the mark.
        consumedMarks.push(mark)
        consumedUpTo.push(Math.max(mark, session.timeUpdated || 0))
        continue
      }
      renderings.push(rendered)
      // A full fetch page may have more turns above this mark: floor the
      // watermark so the rest is re-read next pass.
      if (turns.length >= cfg.max_turns_per_session) floorMarks.push(mark)
    }

    if (renderings.length === 0) {
      // Every discovered session is already consumed. Advance the watermark
      // over them so the oldest `batch_sessions` stop occupying the discovery
      // window — otherwise newer turns are never discovered (head-of-line).
      // Settle-guarded sessions are NOT consumed yet, so their marks floor the
      // advance.
      const bound = consumedUpTo.length > 0 ? Math.max(...consumedUpTo) : null
      const floors = floorMarks.length > 0 ? Math.min(...floorMarks) : bound
      const candidate = bound === null ? null : floors === null ? bound : Math.min(bound, floors)
      if (candidate !== null && candidate > cursor.watermark_ts) {
        cursor = advanceWatermark(cursor, candidate)
        await saveCursor(cursorFile, cursor)
      }
      pendingAfter = await source.unconsumedCount(cursor.watermark_ts, sessionMarks(cursor))
      const oldest = await source.oldestUnconsumedTs(cursor.watermark_ts, sessionMarks(cursor))
      oldestAgeMs = oldest === null ? null : Math.max(0, Date.now() - oldest)
      return stuck(undefined, degraded, sessions.length)
    }

    const planned: PlannedItem[] = []
    const sessionMaxTs = new Map<string, number>()
    for (const rendered of renderings) {
      // Budget check BEFORE the next unit (§2.2) — never mid-unit.
      if (totalTokens >= budget) {
        stopped = "token-budget"
        break
      }
      const summary = await summarizeSession(
        {
          sessionID: rendered.sessionID,
          rendered,
          priorSummary: cursor.sessions[rendered.sessionID]?.summary || null,
        },
        {
          client: deps.client,
          directory: deps.directory,
          model: cfg.summarize_model,
          maxItems: cfg.max_items_per_session,
          waitForIdle: deps.waitForIdle,
          registerChild: deps.registerChild,
          onWarn: deps.onWarn,
        },
      )
      if (summary.degraded) degraded ??= summary.degraded
      if (summary.error) error ??= summary.error
      summarizeReplyBytes = summary.replyBytes ?? summarizeReplyBytes
      totalTokens += summary.tokens ?? 0

      const ts = Math.max(...rendered.turns.map((turn) => turn.time))
      sessionMaxTs.set(rendered.sessionID, Math.max(sessionMaxTs.get(rendered.sessionID) ?? 0, ts))
      for (const item of summary.items) {
        planned.push({ item, sessionID: rendered.sessionID, ts })
      }
      if (summary.items.length === 0) {
        // Nothing durable in this session: it is consumed at its mark.
        consumedMarks.push(ts)
      }
    }

    // Sessions never summarized because the budget stopped the loop stay at
    // their marks (unconsumed above them) — floor the watermark for them.
    const summarizedIds = new Set(sessionMaxTs.keys())
    for (const rendered of renderings) {
      if (!summarizedIds.has(rendered.sessionID)) {
        floorMarks.push(sessionMarkTs(cursor, rendered.sessionID))
      }
    }

    if (planned.length === 0) {
      // Every summarized session yielded an empty item list: advance those
      // sessions (and the watermark) so the same turns are not re-ingested,
      // and spawn no writer. Sessions stopped by the budget stay unadvanced.
      if (consumedMarks.length > 0) {
        const bound = Math.max(...consumedMarks)
        for (const [sid, ts] of sessionMaxTs) cursor = advanceSession(cursor, sid, ts)
        const candidate = Math.min(
          bound,
          ...(floorMarks.length > 0 ? floorMarks : [bound]),
        )
        cursor = advanceWatermark(cursor, Math.min(candidate, bound))
        cursor = pruneSessions(cursor, cfg.continuity_sessions)
        await saveCursor(cursorFile, cursor)
      }
      pendingAfter = await source.unconsumedCount(cursor.watermark_ts, sessionMarks(cursor))
      const oldest = await source.oldestUnconsumedTs(cursor.watermark_ts, sessionMarks(cursor))
      oldestAgeMs = oldest === null ? null : Math.max(0, Date.now() - oldest)
      if (stopped === "token-budget") {
        return emit({
          outcome: "degraded",
          sessions: renderings.length,
          items: 0,
          consolidated: 0,
          skipped: 0,
          cursorBefore,
          cursorAfter: cursor.watermark_ts,
          tokens: totalTokens || null,
          degraded: "budget-exhausted",
          ...(error ? { error } : {}),
          stopped,
        })
      }
      return emit({
        outcome: "nothing",
        sessions: renderings.length,
        items: 0,
        consolidated: 0,
        skipped: 0,
        cursorBefore,
        cursorAfter: cursor.watermark_ts,
        tokens: totalTokens || null,
        degraded,
        ...(error ? { error } : {}),
        ...(stopped ? { stopped } : {}),
      })
    }

    const allText = [
      ...renderings.map((rendered) => rendered.text),
      ...planned.map((entry) =>
        [entry.item.title, entry.item.summary, entry.item.atoms.join(" ")].join("\n"),
      ),
    ].join("\n\n")

    const items: WriteItem[] = planned.map((entry) => entry.item)
    const ctx: WriteContext = {
      directory: deps.directory,
      vaultDir: deps.vaultDir,
      config: cfg,
      client: deps.client,
      waitForIdle: deps.waitForIdle,
      registerChild: deps.registerChild,
      onWarn: deps.onWarn,
      dbFile: deps.dbFile,
      searchText: allText,
    }

    // Chunk the writer so one spawn never has more items than its step budget
    // can service. On a complete run the cursor advances once after every
    // chunk reports or skips all of its items; on a budget stop only the
    // fully-reported sessions advance (§2.2).
    const chunks = chunkPlanned(planned, cfg.max_items_per_batch)
    const consumed: number[] = []
    const skipped: number[] = []
    let failure: WriteReport | null = null
    let atomicAll = false
    let writerSession: string | null = null
    promptBytes = 0

    for (const chunk of chunks) {
      // Budget check BEFORE the next writer chunk (§2.2) — never mid-chunk.
      if (totalTokens >= budget) {
        stopped = "token-budget"
        break
      }
      const writerStarted = Date.now()
      const chunkReport = await deps.provider!.consolidate!(
        chunk.items.map((entry) => entry.item),
        ctx,
      )
      promptBytes += chunkReport.promptBytes ?? 0
      totalTokens += chunkReport.tokens ?? 0
      writerSession = chunkReport.session ?? writerSession

      try {
        await deps.ledger?.write({
          source: "writer",
          outcome: chunkReport.ok ? "ok" : "error",
          model: cfg.writer_model || null,
          prompt_bytes: chunkReport.promptBytes ?? null,
          wall_ms: Date.now() - writerStarted,
          tokens: chunkReport.tokens ?? null,
          cost: chunkReport.cost ?? null,
          cursor_before: cursorBefore,
          cursor_after: cursorBefore,
          session: chunkReport.session ?? null,
          error: chunkReport.detail ?? null,
          ...(deps.trigger ? { trigger: deps.trigger } : {}),
          ...(deps.pass !== undefined ? { pass: deps.pass } : {}),
        })
      } catch {
        /* fail-open */
      }

      if (!chunkReport.ok) {
        failure = chunkReport
        break
      }
      if (chunkReport.atomic === true) {
        atomicAll = true
        break
      }
      consumed.push(...chunkReport.consumed.map((label) => label + chunk.offset))
      skipped.push(...chunkReport.skipped.map((label) => label + chunk.offset))
      if (chunkReport.consumed.length + chunkReport.skipped.length !== chunk.items.length) {
        failure = { ...chunkReport, detail: "incomplete report" }
        break
      }
    }

    const boundary = maxTurnTime(renderings)
    const reportedAll = consumed.length + skipped.length === items.length
    const complete = atomicAll || (failure === null && reportedAll)

    if (failure || (!complete && stopped === null)) {
      // Transient provider failures back off without poisoning the boundary.
      const errorKind = failure?.errorKind
      if (errorKind !== "transient") {
        const failed = recordFailure(cursor, boundary, cfg.poison_attempts, {
          backoffMs: cfg.poll_seconds * 4 * 1000,
        })
        cursor = failed.cursor
        await saveCursor(cursorFile, cursor)
        pendingAfter = await source.unconsumedCount(cursor.watermark_ts, sessionMarks(cursor))
        return emit({
          outcome: failed.dropped ? "dropped" : "error",
          sessions: renderings.length,
          items: planned.length,
          consolidated: consumed.length,
          skipped: skipped.length,
          cursorBefore,
          cursorAfter: cursor.watermark_ts,
          session: writerSession,
          tokens: totalTokens || null,
          degraded,
          error: failure?.detail ?? (failure ? "writer failed" : "incomplete report"),
        })
      }
      pendingAfter = await source.unconsumedCount(cursor.watermark_ts, sessionMarks(cursor))
      return emit({
        outcome: "error",
        sessions: renderings.length,
        items: planned.length,
        consolidated: consumed.length,
        skipped: skipped.length,
        cursorBefore,
        cursorAfter: cursor.watermark_ts,
        session: writerSession,
        tokens: totalTokens || null,
        degraded,
        error: failure?.detail ?? "writer failed (transient)",
      })
    }

    // Per-session advance (§2.3): only sessions whose items were ALL reported
    // (or that had no items) consume their mark; partial sessions floor the
    // watermark so they are re-read from their own mark next pass.
    // Report labels are 1-based (types.ts: "matching the prompt labels").
    const reportedLabels = new Set([...consumed, ...skipped])
    const bySession = new Map<string, { ts: number; parts: string[]; fully: boolean }>()
    for (let i = 0; i < planned.length; i++) {
      const entry = planned[i]
      const current =
        bySession.get(entry.sessionID) ?? { ts: entry.ts, parts: [], fully: true }
      current.ts = Math.max(current.ts, entry.ts)
      // `atomic: true` reports the whole batch consumed without labels.
      if (!atomicAll && !reportedLabels.has(i + 1)) current.fully = false
      if (entry.item.summary.trim()) current.parts.push(entry.item.summary.trim())
      bySession.set(entry.sessionID, current)
    }

    let advancedBound = 0
    for (const [sid, entry] of bySession) {
      const text = entry.parts.join("\n\n").slice(0, 2000)
      if (entry.fully) {
        cursor = advanceSession(cursor, sid, entry.ts, text || undefined)
        advancedBound = Math.max(advancedBound, entry.ts)
        consumedMarks.push(entry.ts)
      } else {
        floorMarks.push(sessionMarkTs(cursor, sid))
      }
    }
    // Sessions with zero items that were summarized this pass are consumed.
    for (const [sid, ts] of sessionMaxTs) {
      if (!bySession.has(sid)) {
        cursor = advanceSession(cursor, sid, ts)
        advancedBound = Math.max(advancedBound, ts)
        consumedMarks.push(ts)
      }
    }

    if (consumedMarks.length > 0) {
      const bound = Math.max(...consumedMarks)
      const candidate = Math.min(bound, ...(floorMarks.length > 0 ? floorMarks : [bound]))
      cursor = advanceWatermark(cursor, candidate)
    }
    cursor = pruneSessions(cursor, cfg.continuity_sessions)
    await saveCursor(cursorFile, cursor)

    pendingAfter = await source.unconsumedCount(cursor.watermark_ts, sessionMarks(cursor))
    const oldest = await source.oldestUnconsumedTs(cursor.watermark_ts, sessionMarks(cursor))
    oldestAgeMs = oldest === null ? null : Math.max(0, Date.now() - oldest)

    if (stopped === "token-budget") {
      return emit({
        outcome: "degraded",
        sessions: renderings.length,
        items: planned.length,
        consolidated: consumed.length,
        skipped: skipped.length,
        cursorBefore,
        cursorAfter: cursor.watermark_ts,
        session: writerSession,
        tokens: totalTokens || null,
        degraded: "budget-exhausted",
        stopped,
      })
    }

    return emit({
      outcome: degraded ? "degraded" : "completed",
      sessions: renderings.length,
      items: planned.length,
      consolidated: consumed.length,
      skipped: skipped.length,
      cursorBefore,
      cursorAfter: cursor.watermark_ts,
      session: writerSession,
      tokens: totalTokens || null,
      degraded,
      ...(error ? { error } : {}),
    })
  } catch (err) {
    return emit({
      outcome: "error",
      sessions: 0,
      items: 0,
      consolidated: 0,
      skipped: 0,
      cursorBefore,
      cursorAfter: cursor.watermark_ts,
      tokens: totalTokens || null,
      degraded,
      error: errorText(err),
    })
  } finally {
    try {
      await source.close()
    } catch {
      /* ignore */
    }
  }
}
