// Durable state for the drain pipe (knowledge-pipeline-redesign §A.1).
//
// The cursor is activity-time based: every message with `time_created >
// last_ts` is un-consolidated. Message ids are NOT time-ordered, so an id
// cursor is never valid.
//
// `blocked` bounds head-of-line blocking: a batch that cannot be fully
// reported increments `attempts`; at `poison_attempts` the pipe advances past
// the batch and records a dropped run instead of retrying forever.
//
// `summaries` keeps the last consolidated summary per session for continuity;
// entries older than `continuity_sessions` are pruned.
//
// All reads are total (corrupt/missing -> defaults + warn) and all writes are
// atomic through lib/fsx.ts. Pure mutators return a new object; `saveCursor`
// stamps `updated_at`.
//
// Loaded via relative import only.
import { join } from "node:path"
import { atomicRead, atomicWrite } from "../fsx.ts"

export const CURSOR_VERSION = 1 as const
export const DEFAULT_CURSOR_FILE = "drain-cursor.json"

export type CursorSummary = {
  /** Activity time of the last consolidated turn for this session (ms). */
  ts: number
  text: string
}

export type DrainCursor = {
  version: typeof CURSOR_VERSION
  /** Activity-time cursor; every message newer than this is un-consolidated. */
  last_ts: number
  /** Consecutive failed runs at the current boundary. */
  blocked: { ts: number; attempts: number }
  /** Last consolidated summary per session id (continuity). */
  summaries: Record<string, CursorSummary>
  updated_at: string
}

export type CursorWarn = (message: string, err?: unknown) => void

export function defaultCursor(): DrainCursor {
  return {
    version: CURSOR_VERSION,
    last_ts: 0,
    blocked: { ts: 0, attempts: 0 },
    summaries: {},
    updated_at: new Date(0).toISOString(),
  }
}

/** Resolve the config leaf under the project-local state root. */
export function resolveCursorFile(stateDir: string, leaf = DEFAULT_CURSOR_FILE): string {
  return join(stateDir, leaf)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isNonNegativeInt(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0
}

function normalizeSummary(value: unknown): CursorSummary | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  if (!isNonNegativeInt(raw.ts) || typeof raw.text !== "string") return null
  return { ts: raw.ts, text: raw.text }
}

/** Total normalization: any invalid field falls back to its default. */
export function normalizeCursor(raw: unknown): DrainCursor {
  if (!raw || typeof raw !== "object") return defaultCursor()
  const value = raw as Record<string, unknown>
  if (value.version !== CURSOR_VERSION) return defaultCursor()

  const last_ts = isNonNegativeInt(value.last_ts) ? value.last_ts : 0

  let blocked = { ts: last_ts, attempts: 0 }
  if (value.blocked && typeof value.blocked === "object") {
    const rawBlocked = value.blocked as Record<string, unknown>
    if (isNonNegativeInt(rawBlocked.ts) && isNonNegativeInt(rawBlocked.attempts)) {
      // A blocked boundary behind the cursor is stale (the batch already
      // advanced); never let it resurrect old work.
      blocked =
        rawBlocked.ts >= last_ts
          ? { ts: rawBlocked.ts, attempts: rawBlocked.attempts }
          : { ts: last_ts, attempts: 0 }
    }
  }

  const summaries: Record<string, CursorSummary> = {}
  if (value.summaries && typeof value.summaries === "object") {
    for (const [session, entry] of Object.entries(value.summaries as Record<string, unknown>)) {
      const summary = normalizeSummary(entry)
      if (summary) summaries[session] = summary
    }
  }

  return {
    version: CURSOR_VERSION,
    last_ts,
    blocked,
    summaries,
    updated_at: typeof value.updated_at === "string" ? value.updated_at : new Date(0).toISOString(),
  }
}

/**
 * Load the cursor. Missing/empty -> defaults, silently (first run). Corrupt or
 * unsupported -> defaults + warn. Never throws.
 */
export async function loadCursor(file: string, onWarn?: CursorWarn): Promise<DrainCursor> {
  const text = await atomicRead(file)
  if (text.trim() === "") return defaultCursor()

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    onWarn?.(`drain cursor: corrupt JSON at ${file}`, err)
    return defaultCursor()
  }

  const cursor = normalizeCursor(parsed)
  const version = (parsed as { version?: unknown } | null)?.version
  if (version !== CURSOR_VERSION) {
    onWarn?.(`drain cursor: unsupported version ${String(version)} at ${file}`)
  }
  return cursor
}

/** Persist atomically, stamping `updated_at`. */
export async function saveCursor(
  file: string,
  cursor: DrainCursor,
  now: () => Date = () => new Date(),
): Promise<DrainCursor> {
  const next: DrainCursor = { ...cursor, updated_at: now().toISOString() }
  await atomicWrite(file, JSON.stringify(next, null, 2) + "\n")
  return next
}

/** Move the cursor forward (monotonic) and clear the blocked counter. */
export function advanceCursor(cursor: DrainCursor, ts: number): DrainCursor {
  if (!isFiniteNumber(ts)) return cursor
  const last_ts = Math.max(cursor.last_ts, ts)
  return {
    ...cursor,
    last_ts,
    blocked: { ts: last_ts, attempts: 0 },
  }
}

/**
 * Record an incomplete run at `boundaryTs`.
 *
 * - Boundary already consumed (<= last_ts): no-op, `dropped: false`.
 * - First failure at this boundary: attempts = 1.
 * - At/over `poisonAttempts` (> 0): advance past the boundary, clear blocked,
 *   report `dropped: true`.
 */
export function recordFailure(
  cursor: DrainCursor,
  boundaryTs: number,
  poisonAttempts: number,
): { cursor: DrainCursor; dropped: boolean } {
  if (!isFiniteNumber(boundaryTs) || boundaryTs <= cursor.last_ts) {
    return { cursor, dropped: false }
  }

  const attempts = cursor.blocked.ts === boundaryTs ? cursor.blocked.attempts + 1 : 1
  if (poisonAttempts > 0 && attempts >= poisonAttempts) {
    return {
      cursor: { ...cursor, last_ts: boundaryTs, blocked: { ts: boundaryTs, attempts: 0 } },
      dropped: true,
    }
  }
  return { cursor: { ...cursor, blocked: { ts: boundaryTs, attempts } }, dropped: false }
}

/** Store/replace the continuity summary for one session. */
export function setSummary(
  cursor: DrainCursor,
  sessionID: string,
  ts: number,
  text: string,
): DrainCursor {
  return {
    ...cursor,
    summaries: { ...cursor.summaries, [sessionID]: { ts, text } },
  }
}

/** Keep the newest `limit` session summaries; `0` clears the map. */
export function pruneSummaries(cursor: DrainCursor, limit: number): DrainCursor {
  const keep = Math.max(0, Math.floor(limit))
  if (keep === 0) return { ...cursor, summaries: {} }

  const entries = Object.entries(cursor.summaries)
  if (entries.length <= keep) return cursor

  entries.sort((a, b) => b[1].ts - a[1].ts)
  return { ...cursor, summaries: Object.fromEntries(entries.slice(0, keep)) }
}

/** Convenience for the pipe: advance + prune, still unsaved. */
export function consumeBatch(
  cursor: DrainCursor,
  boundaryTs: number,
  continuitySessions: number,
): DrainCursor {
  return pruneSummaries(advanceCursor(cursor, boundaryTs), continuitySessions)
}
