// Drain pipe orchestration (knowledge-pipeline-redesign §A.12).
//
// One run: load cursor -> discover/fetch -> render -> summarize -> hand the
// items to the active memory provider's writer -> map its WriteReport to the
// cursor.
//
// The pipe writes no vault notes and knows nothing about the writer's prompt
// internals: the only contract is `WriteReport` (memory/types.ts). A run that
// cannot report every item does not advance the cursor; transient failures back
// off, permanent failures count toward poison.
//
// Loaded via relative import only.
import type { DrainConfig } from "./config.ts"
import {
  advanceCursor,
  defaultCursor,
  loadCursor,
  pruneSummaries,
  recordFailure,
  resolveCursorFile,
  saveCursor,
  setSummary,
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
} from "../memory/types.ts"

export type DrainOutcome = "completed" | "nothing" | "degraded" | "error" | "dropped"

export type DrainPipeResult = {
  outcome: DrainOutcome
  sessions: number
  items: number
  consolidated: number
  skipped: number
  cursorBefore: number
  cursorAfter: number
  degraded?: "schema-mismatch" | "summarizer-fallback" | "sdk-fallback"
  error?: string
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
  if (result.degraded) bits.push(`degraded:${result.degraded}`)
  if (result.error) bits.push(`error:${result.error}`)
  return bits.join(", ")
}

export type DrainPipeClient = SummarizerClient & MemoryWriteClient

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

/**
 * Run one drain cycle. Always resolves with a result; expected failures are
 * outcomes, not throws. The cursor is saved only on advance or failure
 * accounting.
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
  const cursorBefore = cursor.last_ts
  let promptBytes: number | undefined
  let totalTokens = 0

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
        wall_ms: Date.now() - started,
      })
    } catch {
      /* fail-open */
    }
    return result
  }

  const stuck = async (error?: string, degraded?: DrainPipeResult["degraded"]): Promise<DrainPipeResult> =>
    emit({
      outcome: "nothing",
      sessions: 0,
      items: 0,
      consolidated: 0,
      skipped: 0,
      cursorBefore,
      cursorAfter: cursor.last_ts,
      degraded,
      ...(error ? { error } : {}),
    })

  if (!cfg.enabled) return stuck()
  // Complete-disable / read-only profiles: never open the DB, never advance.
  if (!deps.provider || !deps.provider.consolidate) {
    return stuck("memory provider has no writer")
  }

  let source: DrainSource
  try {
    source = await openDrainSource({
      projectDir: deps.directory,
      client: deps.client,
      dbFile: deps.dbFile,
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
      cursorAfter: cursor.last_ts,
      error: errorText(err),
    })
  }

  let degraded: DrainPipeResult["degraded"] = source.degraded

  try {
    const sessions = await source.discover(cursor.last_ts, cfg.batch_sessions)
    const renderings: RenderedSession[] = []

    for (const session of sessions) {
      const turns = await source.fetch(session.id, cursor.last_ts, cfg.max_turns_per_session)
      if (turns.length === 0) continue
      const rendered = renderSession(session.id, turns, {
        maxBytes: cfg.max_session_bytes,
        priorSummary: cursor.summaries[session.id]?.text ?? null,
      })
      if (rendered) renderings.push(rendered)
    }

    if (renderings.length === 0) return stuck(undefined, degraded)

    const planned: PlannedItem[] = []
    for (const rendered of renderings) {
      const summary = await summarizeSession(
        {
          sessionID: rendered.sessionID,
          rendered,
          priorSummary: cursor.summaries[rendered.sessionID]?.text ?? null,
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
      totalTokens += summary.tokens ?? 0

      const ts = Math.max(...rendered.turns.map((turn) => turn.time))
      for (const item of summary.items) {
        planned.push({ item, sessionID: rendered.sessionID, ts })
      }
    }

    if (planned.length === 0) return stuck("summarizer produced no items", degraded)

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

    const writerStarted = Date.now()
    const report = await deps.provider!.consolidate!(items, ctx)
    promptBytes = report.promptBytes ?? undefined
    totalTokens += report.tokens ?? 0

    try {
      await deps.ledger?.write({
        source: "writer",
        outcome: report.ok ? "ok" : "error",
        model: cfg.writer_model || null,
        prompt_bytes: report.promptBytes ?? null,
        wall_ms: Date.now() - writerStarted,
        tokens: report.tokens ?? null,
        cost: report.cost ?? null,
        cursor_before: cursorBefore,
        cursor_after: cursorBefore,
        session: report.session ?? null,
        error: report.detail ?? null,
      })
    } catch {
      /* fail-open */
    }

    const boundary = maxTurnTime(renderings)
    const complete =
      report.atomic === true || report.consumed.length + report.skipped.length === items.length

    if (!report.ok || !complete) {
      // Transient provider failures back off without poisoning the boundary.
      if (report.errorKind !== "transient") {
        const failed = recordFailure(cursor, boundary, cfg.poison_attempts)
        cursor = failed.cursor
        await saveCursor(cursorFile, cursor)
        return emit({
          outcome: failed.dropped ? "dropped" : "error",
          sessions: renderings.length,
          items: planned.length,
          consolidated: report.consumed.length,
          skipped: report.skipped.length,
          cursorBefore,
          cursorAfter: cursor.last_ts,
          degraded,
          error: report.detail ?? (report.ok ? "incomplete report" : "writer failed"),
        })
      }
      return emit({
        outcome: "error",
        sessions: renderings.length,
        items: planned.length,
        consolidated: report.consumed.length,
        skipped: report.skipped.length,
        cursorBefore,
        cursorAfter: cursor.last_ts,
        degraded,
        error: report.detail ?? "writer failed (transient)",
      })
    }

    cursor = advanceCursor(cursor, boundary)

    const bySession = new Map<string, { ts: number; parts: string[] }>()
    for (const entry of planned) {
      const current = bySession.get(entry.sessionID) ?? { ts: entry.ts, parts: [] }
      current.ts = Math.max(current.ts, entry.ts)
      if (entry.item.summary.trim()) current.parts.push(entry.item.summary.trim())
      bySession.set(entry.sessionID, current)
    }
    for (const [sessionID, entry] of bySession) {
      const text = entry.parts.join("\n\n").slice(0, 2000)
      if (text) cursor = setSummary(cursor, sessionID, entry.ts, text)
    }
    cursor = pruneSummaries(cursor, cfg.continuity_sessions)
    await saveCursor(cursorFile, cursor)

    return emit({
      outcome: degraded ? "degraded" : "completed",
      sessions: renderings.length,
      items: planned.length,
      consolidated: report.consumed.length,
      skipped: report.skipped.length,
      cursorBefore,
      cursorAfter: cursor.last_ts,
      degraded,
    })
  } catch (err) {
    return emit({
      outcome: "error",
      sessions: 0,
      items: 0,
      consolidated: 0,
      skipped: 0,
      cursorBefore,
      cursorAfter: cursor.last_ts,
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
