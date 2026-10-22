// Durable state for the drain pipe (drain-consumer-plan §2.3).
//
// Cursor v2 replaces the single activity-time high-water mark with
// **per-session marks**: discovery stays watermark-based (cheap), but fetch
// uses each session's own mark, so a resumed or late-discovered session is
// re-read from its mark and no turn can fall below a global mark and be
// skipped. Message ids are NOT time-ordered, so an id cursor is never valid.
//
// v1 → v2 migration (§2.3.1) is exact where evidence exists: every v1
// `summaries[sid]` entry becomes `sessions[sid].last_ts = min(v1.last_ts,
// summary.ts)` (the summary ts IS the per-session consumption point), carrying
// the summary text. Sessions with no v1 entry get no mark and fall back to the
// watermark at discovery (conservative: historical skips persist).
//
// `blocked` bounds head-of-line blocking: a batch that cannot be fully
// reported increments `attempts`; at `poison_attempts` the pipe advances past
// the batch and records a dropped run instead of retrying forever.
// `blocked_until` backs the consumer off after a failure instead of
// hot-looping it at poll cadence.
//
// All reads are total (corrupt/missing -> defaults + warn) and all writes are
// atomic through lib/fsx.ts. Pure mutators return a new object; `saveCursor`
// stamps `updated_at`.
//
// Loaded via relative import only.
import { join } from "node:path"
import { atomicRead, atomicWrite } from "../fsx.ts"

export const CURSOR_VERSION = 2 as const
export const DEFAULT_CURSOR_FILE = "drain-cursor.json"

/** Per-session consumption mark + continuity summary. */
export type SessionMark = {
  /** Activity time of the last consolidated turn for this session (ms). */
  last_ts: number
  /** Last consolidated summary text ("" when none / pruned). */
  summary: string
}

export type DrainCursor = {
  version: typeof CURSOR_VERSION
  /** Global discovery bound: every message newer is un-consolidated. */
  watermark_ts: number
  /** Per-session consumption marks (fetch lower bound per session). */
  sessions: Record<string, SessionMark>
  /** Consecutive failed runs at the current boundary. */
  blocked: { ts: number; attempts: number; blocked_until: number }
  updated_at: string
  /** Set when this record was migrated from a v1 cursor. */
  migrated_from?: 1
  migrated_at?: string
}

export type CursorWarn = (message: string, err?: unknown) => void

export function defaultCursor(): DrainCursor {
  return {
    version: CURSOR_VERSION,
    watermark_ts: 0,
    sessions: {},
    blocked: { ts: 0, attempts: 0, blocked_until: 0 },
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

function normalizeSessionMark(value: unknown): SessionMark | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  if (!isNonNegativeInt(raw.last_ts)) return null
  return { last_ts: raw.last_ts, summary: typeof raw.summary === "string" ? raw.summary : "" }
}

/** v1 `summaries` entry: `{ ts, text }`. */
function normalizeV1Summary(value: unknown): { ts: number; text: string } | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  if (!isNonNegativeInt(raw.ts) || typeof raw.text !== "string") return null
  return { ts: raw.ts, text: raw.text }
}

/**
 * v1 → v2 migration (§2.3.1). Exact where evidence exists: a v1 summary's ts
 * is the activity time of the last consolidated turn for that session, so it
 * becomes the session's mark, floored at the global last_ts (never above what
 * the v1 cursor had consumed). Sessions without a v1 entry get no mark — the
 * pipe falls back to the watermark at discovery. Records `migrated_from`.
 */
function migrateV1(value: Record<string, unknown>, nowMs: number): DrainCursor {
  const last_ts = isNonNegativeInt(value.last_ts) ? value.last_ts : 0
  const sessions: Record<string, SessionMark> = {}
  if (value.summaries && typeof value.summaries === "object") {
    for (const [sid, entry] of Object.entries(value.summaries as Record<string, unknown>)) {
      const summary = normalizeV1Summary(entry)
      if (!summary) continue
      sessions[sid] = { last_ts: Math.min(last_ts, summary.ts), summary: summary.text }
    }
  }

  let blocked = { ts: last_ts, attempts: 0, blocked_until: 0 }
  if (value.blocked && typeof value.blocked === "object") {
    const rawBlocked = value.blocked as Record<string, unknown>
    if (isNonNegativeInt(rawBlocked.ts) && isNonNegativeInt(rawBlocked.attempts)) {
      blocked =
        rawBlocked.ts >= last_ts
          ? { ts: rawBlocked.ts, attempts: rawBlocked.attempts, blocked_until: 0 }
          : { ts: last_ts, attempts: 0, blocked_until: 0 }
    }
  }

  return {
    version: CURSOR_VERSION,
    watermark_ts: last_ts,
    sessions,
    blocked,
    updated_at: typeof value.updated_at === "string" ? value.updated_at : new Date(0).toISOString(),
    migrated_from: 1,
    migrated_at: new Date(nowMs).toISOString(),
  }
}

/** Total normalization: any invalid field falls back to its default. */
export function normalizeCursor(raw: unknown, nowMs: number = Date.now()): DrainCursor {
  if (!raw || typeof raw !== "object") return defaultCursor()
  const value = raw as Record<string, unknown>

  if (value.version === 1) return migrateV1(value, nowMs)
  if (value.version !== CURSOR_VERSION) return defaultCursor()

  const watermark_ts = isNonNegativeInt(value.watermark_ts) ? value.watermark_ts : 0

  let blocked = { ts: watermark_ts, attempts: 0, blocked_until: 0 }
  if (value.blocked && typeof value.blocked === "object") {
    const rawBlocked = value.blocked as Record<string, unknown>
    if (isNonNegativeInt(rawBlocked.ts) && isNonNegativeInt(rawBlocked.attempts)) {
      // A blocked boundary behind the cursor is stale (the batch already
      // advanced); never let it resurrect old work.
      blocked =
        rawBlocked.ts >= watermark_ts
          ? {
              ts: rawBlocked.ts,
              attempts: rawBlocked.attempts,
              blocked_until: isNonNegativeInt(rawBlocked.blocked_until) ? rawBlocked.blocked_until : 0,
            }
          : { ts: watermark_ts, attempts: 0, blocked_until: 0 }
    }
  }

  const sessions: Record<string, SessionMark> = {}
  if (value.sessions && typeof value.sessions === "object") {
    for (const [sid, entry] of Object.entries(value.sessions as Record<string, unknown>)) {
      const mark = normalizeSessionMark(entry)
      if (mark) sessions[sid] = mark
    }
  }

  return {
    version: CURSOR_VERSION,
    watermark_ts,
    sessions,
    blocked,
    updated_at: typeof value.updated_at === "string" ? value.updated_at : new Date(0).toISOString(),
  }
}

/**
 * Load the cursor. Missing/empty -> defaults, silently (first run). Corrupt or
 * unsupported -> defaults + warn. A v1 cursor migrates in place (the caller
 * should save it back). Never throws.
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
  if (version !== CURSOR_VERSION && version !== 1) {
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

/** The consumption mark a session fetch should use: its own, else the
 *  watermark (conservative — no re-read of sub-watermark turns). */
export function sessionMarkTs(cursor: DrainCursor, sessionID: string): number {
  return cursor.sessions[sessionID]?.last_ts ?? cursor.watermark_ts
}

/** Move the watermark forward (monotonic) and clear the blocked counter. */
export function advanceWatermark(cursor: DrainCursor, ts: number): DrainCursor {
  if (!isFiniteNumber(ts)) return cursor
  const watermark_ts = Math.max(cursor.watermark_ts, ts)
  return {
    ...cursor,
    watermark_ts,
    blocked: { ts: watermark_ts, attempts: 0, blocked_until: 0 },
  }
}

/**
 * Advance one session's mark (monotonic per session). When `summary` is
 * provided it replaces the continuity text; otherwise the existing text is
 * kept. Returns the cursor unchanged when the mark would move backwards.
 */
export function advanceSession(
  cursor: DrainCursor,
  sessionID: string,
  ts: number,
  summary?: string,
): DrainCursor {
  if (!sessionID || !isFiniteNumber(ts)) return cursor
  const current = cursor.sessions[sessionID]
  if (current && current.last_ts >= ts) {
    if (summary === undefined || summary === current.summary) return cursor
    return { ...cursor, sessions: { ...cursor.sessions, [sessionID]: { last_ts: current.last_ts, summary } } }
  }
  return {
    ...cursor,
    sessions: {
      ...cursor.sessions,
      [sessionID]: { last_ts: ts, summary: summary ?? current?.summary ?? "" },
    },
  }
}

/**
 * Record an incomplete run at `boundaryTs`.
 *
 * - Boundary already consumed (<= watermark): no-op, `dropped: false`.
 * - First failure at this boundary: attempts = 1, `blocked_until` set.
 * - At/over `poisonAttempts` (> 0): advance past the boundary, clear blocked,
 *   report `dropped: true`.
 */
export function recordFailure(
  cursor: DrainCursor,
  boundaryTs: number,
  poisonAttempts: number,
  opts: { nowMs?: number; backoffMs?: number } = {},
): { cursor: DrainCursor; dropped: boolean } {
  if (!isFiniteNumber(boundaryTs) || boundaryTs <= cursor.watermark_ts) {
    return { cursor, dropped: false }
  }

  const nowMs = opts.nowMs ?? Date.now()
  const backoffMs = Math.max(0, opts.backoffMs ?? 0)
  const attempts = cursor.blocked.ts === boundaryTs ? cursor.blocked.attempts + 1 : 1
  if (poisonAttempts > 0 && attempts >= poisonAttempts) {
    return {
      cursor: {
        ...cursor,
        watermark_ts: boundaryTs,
        blocked: { ts: boundaryTs, attempts: 0, blocked_until: 0 },
      },
      dropped: true,
    }
  }
  return {
    cursor: {
      ...cursor,
      blocked: { ts: boundaryTs, attempts, blocked_until: nowMs + backoffMs },
    },
    dropped: false,
  }
}

/** Store/replace the continuity summary for one session (mark untouched). */
export function setSummary(
  cursor: DrainCursor,
  sessionID: string,
  ts: number,
  text: string,
): DrainCursor {
  return advanceSession(cursor, sessionID, ts, text)
}

/**
 * Keep the newest `limit` session entries by mark; `0` clears the map.
 * NOTE: pruning drops a session's mark along with its summary — a later
 * rediscovery falls back to the watermark (the documented v1 gap, §2.3.1);
 * `drain.cursor_migration: "recover"` repairs such sessions at discovery.
 */
export function pruneSessions(cursor: DrainCursor, limit: number): DrainCursor {
  const keep = Math.max(0, Math.floor(limit))
  if (keep === 0) return { ...cursor, sessions: {} }

  const entries = Object.entries(cursor.sessions)
  if (entries.length <= keep) return cursor

  entries.sort((a, b) => b[1].last_ts - a[1].last_ts)
  return { ...cursor, sessions: Object.fromEntries(entries.slice(0, keep)) }
}

/** True while a recorded failure's backoff has not elapsed. */
export function blockedBackoffActive(cursor: DrainCursor, nowMs: number = Date.now()): boolean {
  return cursor.blocked.blocked_until > nowMs
}
