// Shared drain eligibility check.
//
// The pipe, the agent tool, and the memory providers all need the same
// answer: is there work, and can this lane actually consume it? The cursor
// seed here matches runDrainPipe (a fresh cursor starts `initial_lookback_hours`
// back), so the digest and the tool cannot disagree about "in sync".
//
// Loaded via relative import only.
import { join } from "node:path"
import type { DrainConfig } from "./config.ts"
import { countUnconsumed } from "./db.ts"
import { loadCursor, resolveCursorFile, sessionMarks } from "./cursor.ts"
import { atomicRead, atomicWrite } from "../fsx.ts"
import type { MemoryProvider } from "../memory/types.ts"

export const DRAIN_STATUS_FILE = "drain.current.json"

export type DrainStatusFile = {
  state: string
  trigger?: string | null
  pass?: number | null
  pending?: number | null
  oldest_pending_age_ms?: number | null
  next_due?: string | null
  updated_at: string
  pass_id?: string
  phase?: string
  started_at?: string
  finished_at?: string
  outcome?: string
  counts?: Record<string, number>
  tasks?: unknown[]
  tasks_updated_at?: string
  [key: string]: unknown
}

function parseStatus(text: string): Partial<DrainStatusFile> {
  try {
    const value = JSON.parse(text)
    return value && typeof value === "object" && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

/**
 * Merge one live-status patch into `drain.current.json` atomically.
 *
 * `updated_at` changes only at pass boundaries (`idle`, `starting`,
 * `finishing`, an outcome, or an explicit value); task transitions only move
 * `tasks_updated_at`, so `drainHealth.last_wake_age_ms` stays meaningful.
 */
export async function writeDrainStatus(
  stateDir: string,
  patch: Partial<DrainStatusFile> & { state: string },
): Promise<void> {
  const file = join(stateDir, DRAIN_STATUS_FILE)
  const existing = parseStatus(await atomicRead(file))
  const now = new Date().toISOString()
  const boundary =
    patch.updated_at !== undefined ||
    patch.state === "idle" ||
    patch.phase === "starting" ||
    patch.phase === "finishing" ||
    patch.finished_at !== undefined ||
    patch.outcome !== undefined
  const next: DrainStatusFile = {
    ...existing,
    ...patch,
    state: patch.state,
    updated_at: boundary ? (patch.updated_at ?? now) : (existing.updated_at ?? now),
  }
  await atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`)
}

export type DrainSkipReason =
  | "disabled"
  | "no-provider"
  | "paused"
  | "in-sync"
  | "unavailable"
  | "lock-held"

export type DrainStatus = {
  enabled: boolean
  writer: boolean
  /** Effective unconsumed-turn count; null when it could not be read. */
  pending: number | null
  /** Effective lower bound (cursor or seeded lookback). */
  cursorLastTs: number | null
  seeded: boolean
  available: boolean
  /** True when the drain must not run (any reason below). */
  locked: boolean
  reason: DrainSkipReason | null
  error?: string
}

/** The pipe's effective discovery bound: a fresh cursor starts at the
 *  configured lookback, not at epoch. Read-only; the pipe owns the save. */
export async function effectiveCursorLastTs(
  stateDir: string,
  config: DrainConfig,
  now: number = Date.now(),
): Promise<{ lastTs: number; seeded: boolean; marks: Record<string, number> }> {
  const cursor = await loadCursor(resolveCursorFile(stateDir, config.cursor_file))
  const marks = sessionMarks(cursor)
  if (cursor.watermark_ts <= 0 && config.initial_lookback_hours > 0) {
    return { lastTs: now - config.initial_lookback_hours * 3_600_000, seeded: true, marks }
  }
  return { lastTs: cursor.watermark_ts, seeded: false, marks }
}

/**
 * Read-only eligibility snapshot. A provider without a writer is paused, not
 * in sync: there is nothing the drain can do about the pending turns. An
 * unreadable store is unavailable, never a silent zero.
 */
export async function readDrainStatus(opts: {
  directory: string
  stateDir: string
  config: DrainConfig
  provider?: MemoryProvider
  dbFile?: string
  now?: number
}): Promise<DrainStatus> {
  const writer = !!opts.provider?.consolidate && opts.provider?.capabilities.write !== false
  const base = {
    enabled: opts.config.enabled,
    writer,
    cursorLastTs: null as number | null,
    seeded: false,
  }

  if (!opts.config.enabled) {
    return { ...base, pending: null, available: true, locked: true, reason: "disabled" }
  }
  if (!opts.provider) {
    return { ...base, pending: null, available: true, locked: true, reason: "no-provider" }
  }
  if (!writer) {
    return { ...base, pending: null, available: true, locked: true, reason: "paused" }
  }

  try {
    const { lastTs, seeded, marks } = await effectiveCursorLastTs(
      opts.stateDir,
      opts.config,
      opts.now,
    )
    const pending = await countUnconsumed({
      projectDir: opts.directory,
      lastTs,
      marks,
      dbFile: opts.dbFile,
      excludeMissions: opts.config.exclude_missions,
    })
    const inSync = pending === 0
    return {
      ...base,
      pending,
      cursorLastTs: lastTs,
      seeded,
      available: true,
      locked: inSync,
      reason: inSync ? "in-sync" : null,
    }
  } catch (err) {
    return {
      ...base,
      pending: null,
      available: false,
      locked: true,
      reason: "unavailable",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
