// Drain pipe orchestration (knowledge-pipeline-redesign §A.12).
//
// One run: load cursor -> discover/fetch -> render -> summarize -> prefetch
// candidates -> build the consolidation prompt -> spawn rag-brain -> parse the
// report -> advance the cursor.
//
// The pipe writes no vault notes and knows nothing about the writer's prompt
// internals: the only contract is `Consolidation mode.` in and a
// consolidated/skipped fence out. A run that cannot report every item does not
// advance the cursor; poison handling bounds head-of-line blocking.
//
// Loaded via relative import only.
import { extractKeywords } from "../transcript.ts"
import { extractTitlePhrases, findCandidateNotes, type CandidateNote } from "./candidates.ts"
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
import { buildConsolidationPrompt } from "./prompt.ts"
import { renderSession, type RenderedSession } from "./render.ts"
import { parseConsolidationReport } from "./report.ts"
import { spawnConsolidationChild, type ConsolidationClient } from "./spawn.ts"
import { summarizeSession, type SummaryItem, type SummarizerClient } from "./summarize.ts"

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

export type DrainPipeClient = SummarizerClient & ConsolidationClient

export type DrainPipeDeps = {
  directory: string
  stateDir: string
  vaultDir: string
  config: DrainConfig
  client: DrainPipeClient
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
    let candidates: CandidateNote[] = []
    try {
      candidates = await findCandidateNotes({
        vaultDir: deps.vaultDir,
        keywords: extractKeywords(allText, 24),
        phrases: extractTitlePhrases(allText, 12),
        limit: cfg.prefetch_candidates,
      })
    } catch (err) {
      deps.onWarn?.("drain pipe: candidate prefetch failed", err)
    }

    const prompt = buildConsolidationPrompt(
      planned.map((entry) => entry.item),
      candidates,
      { maxBytes: cfg.drain_prompt_max_bytes },
    )
    promptBytes = Buffer.byteLength(prompt, "utf8")

    const writerStarted = Date.now()
    const spawned = await spawnConsolidationChild(deps.client, {
      directory: deps.directory,
      prompt,
      model: cfg.writer_model,
      waitForIdle: deps.waitForIdle,
      registerChild: deps.registerChild,
    })
    totalTokens += spawned.tokens ?? 0

    try {
      await deps.ledger?.write({
        source: "writer",
        outcome: spawned.ok ? "ok" : "error",
        model: cfg.writer_model || null,
        prompt_bytes: promptBytes,
        wall_ms: Date.now() - writerStarted,
        tokens: spawned.tokens,
        cost: spawned.cost,
        cursor_before: cursorBefore,
        cursor_after: cursorBefore,
        session: spawned.sessionID || null,
        error: spawned.error ?? null,
      })
    } catch {
      /* fail-open */
    }

    const boundary = maxTurnTime(renderings)

    if (!spawned.ok) {
      const failed = recordFailure(cursor, boundary, cfg.poison_attempts)
      cursor = failed.cursor
      await saveCursor(cursorFile, cursor)
      return emit({
        outcome: failed.dropped ? "dropped" : "error",
        sessions: renderings.length,
        items: planned.length,
        consolidated: 0,
        skipped: 0,
        cursorBefore,
        cursorAfter: cursor.last_ts,
        degraded,
        error: spawned.error ?? "writer failed",
      })
    }

    const report = parseConsolidationReport(spawned.reply, planned.length)
    if (!report.valid) {
      const failed = recordFailure(cursor, boundary, cfg.poison_attempts)
      cursor = failed.cursor
      await saveCursor(cursorFile, cursor)
      return emit({
        outcome: failed.dropped ? "dropped" : "error",
        sessions: renderings.length,
        items: planned.length,
        consolidated: report.consolidated.length,
        skipped: report.skipped.length,
        cursorBefore,
        cursorAfter: cursor.last_ts,
        degraded,
        error: `invalid report: ${report.error ?? "incomplete"}`,
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
      consolidated: report.consolidated.length,
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
