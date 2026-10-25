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
// `blocked` is the batch-level backoff only: a run that cannot be fully
// reported increments `attempts` and sets `blocked_until`, which backs the
// step off instead of hot-looping it at poll cadence. Poisoning is per
// session (`failures`): at `poison_attempts` only the sessions whose items
// failed advance past their batch, so a bad session can never push the global
// watermark over another session's unreported turns.
//
// `written` remembers the content hashes a writer reported as consolidated, so
// a retried pass that re-reads the same turns (after a crash between the note
// write and the cursor save) does not create duplicate notes.
//
// All reads are total (corrupt/missing -> defaults + warn) and all writes are
// atomic through lib/fsx.ts. Pure mutators return a new object; `saveCursor`
// stamps `updated_at`.
//
// Loaded via relative import only.
import { join } from "node:path"
import { atomicRead, atomicWrite } from "../fsx.ts"

export const CURSOR_VERSION = 3 as const
export const DEFAULT_CURSOR_FILE = "drain-cursor.json"
/** How many consolidated-content hashes to remember for idempotent re-runs. */
export const WRITTEN_LIMIT = 5000

/** Per-session consumption mark + continuity summary. */
export type SessionMark = {
  /** Activity time of the last consolidated turn for this session (ms). */
  last_ts: number
  /** Last consolidated summary text ("" when none / pruned). */
  summary: string
}

/** Per-session poison accounting: the pipe retries a session's batch a few
 *  times, then advances only that session past it. */
export type SessionFailure = {
  /** Batch boundary (activity time of the session's failing items). */
  ts: number
  attempts: number
  blocked_until: number
}

export type DrainCursor = {
  version: typeof CURSOR_VERSION
  /** Global discovery bound: every message newer is un-consolidated. */
  watermark_ts: number
  /** Per-session consumption marks (fetch lower bound per session). */
  sessions: Record<string, SessionMark>
  /** Batch-level backoff (never advances the watermark by itself). */
  blocked: { ts: number; attempts: number; blocked_until: number }
  /** Per-session poison attempts, keyed by session id. */
  failures: Record<string, SessionFailure>
  /** Consolidated item hashes (idempotency), hash -> activity time. */
  written: Record<string, number>
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
    failures: {},
    written: {},
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
    failures: {},
    written: {},
    updated_at: typeof value.updated_at === "string" ? value.updated_at : new Date(0).toISOString(),
    migrated_from: 1,
    migrated_at: new Date(nowMs).toISOString(),
  }
}

function normalizeFailures(value: unknown): Record<string, SessionFailure> {
  const failures: Record<string, SessionFailure> = {}
  if (!value || typeof value !== "object") return failures
  for (const [sid, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!sid || !entry || typeof entry !== "object") continue
    const raw = entry as Record<string, unknown>
    if (!isNonNegativeInt(raw.ts) || !isNonNegativeInt(raw.attempts)) continue
    failures[sid] = {
      ts: raw.ts,
      attempts: raw.attempts,
      blocked_until: isNonNegativeInt(raw.blocked_until) ? raw.blocked_until : 0,
    }
  }
  return failures
}

function normalizeWritten(value: unknown): Record<string, number> {
  const written: Record<string, number> = {}
  if (!value || typeof value !== "object") return written
  for (const [hash, ts] of Object.entries(value as Record<string, unknown>)) {
    if (!hash || !isNonNegativeInt(ts)) continue
    written[hash] = ts
  }
  return written
}

/** Total normalization: any invalid field falls back to its default. */
export function normalizeCursor(raw: unknown, nowMs: number = Date.now()): DrainCursor {
  if (!raw || typeof raw !== "object") return defaultCursor()
  const value = raw as Record<string, unknown>

  if (value.version === 1) return migrateV1(value, nowMs)
  // v2 is the same shape without `failures`/`written`; normalize it in place.
  if (value.version !== 2 && value.version !== CURSOR_VERSION) return defaultCursor()

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
    failures: normalizeFailures(value.failures),
    written: normalizeWritten(value.written),
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
  if (version !== CURSOR_VERSION && version !== 2 && version !== 1) {
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

/** Per-session fetch lower bounds, for the counting queries that must not
 *  treat already-consolidated turns as pending (§2.3). */
export function sessionMarks(cursor: DrainCursor): Record<string, number> {
  const marks: Record<string, number> = {}
  for (const [sid, mark] of Object.entries(cursor.sessions)) marks[sid] = mark.last_ts
  return marks
}

/** Move the watermark forward (monotonic), clear the batch backoff, and drop
 *  failure records that are now behind the consumed bound. */
export function advanceWatermark(cursor: DrainCursor, ts: number): DrainCursor {
  if (!isFiniteNumber(ts)) return cursor
  const watermark_ts = Math.max(cursor.watermark_ts, ts)
  let failures = cursor.failures
  if (Object.keys(failures).length > 0) {
    failures = {}
    for (const [sid, failure] of Object.entries(cursor.failures)) {
      if (failure.ts > watermark_ts) failures[sid] = failure
    }
  }
  return {
    ...cursor,
    watermark_ts,
    blocked: { ts: watermark_ts, attempts: 0, blocked_until: 0 },
    failures,
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
  const failure = cursor.failures[sessionID]
  const cleared = failure
    ? { ...cursor, failures: Object.fromEntries(Object.entries(cursor.failures).filter(([id]) => id !== sessionID)) }
    : cursor
  if (current && current.last_ts >= ts) {
    if (summary === undefined || summary === current.summary) return cleared
    return { ...cleared, sessions: { ...cleared.sessions, [sessionID]: { last_ts: current.last_ts, summary } } }
  }
  return {
    ...cleared,
    sessions: {
      ...cleared.sessions,
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

/**
 * Count one incomplete batch for a single session.
 *
 * - Boundary already consumed for that session: no-op.
 * - At/over `poisonAttempts` (> 0): drop the record and report `dropped`; the
 *   caller advances only this session, never the global watermark.
 */
export function recordSessionFailure(
  cursor: DrainCursor,
  sessionID: string,
  ts: number,
  poisonAttempts: number,
  opts: { nowMs?: number; backoffMs?: number } = {},
): { cursor: DrainCursor; dropped: boolean } {
  const mark = cursor.sessions[sessionID]?.last_ts ?? 0
  if (!sessionID || !isFiniteNumber(ts) || ts <= mark) return { cursor, dropped: false }

  const nowMs = opts.nowMs ?? Date.now()
  const backoffMs = Math.max(0, opts.backoffMs ?? 0)
  const current = cursor.failures[sessionID]
  const attempts = current && current.ts === ts ? current.attempts + 1 : 1

  if (poisonAttempts > 0 && attempts >= poisonAttempts) {
    return {
      cursor: {
        ...cursor,
        failures: Object.fromEntries(
          Object.entries(cursor.failures).filter(([id]) => id !== sessionID),
        ),
      },
      dropped: true,
    }
  }

  return {
    cursor: {
      ...cursor,
      failures: {
        ...cursor.failures,
        [sessionID]: { ts, attempts, blocked_until: nowMs + backoffMs },
      },
    },
    dropped: false,
  }
}

/** Remember consolidated item hashes so a retried pass cannot duplicate notes. */
export function markWritten(
  cursor: DrainCursor,
  hashes: Iterable<string>,
  ts: number,
  limit: number = WRITTEN_LIMIT,
): DrainCursor {
  if (!isFiniteNumber(ts)) return cursor
  const written: Record<string, number> = { ...cursor.written }
  let changed = false
  for (const hash of hashes) {
    if (!hash) continue
    written[hash] = Math.max(written[hash] ?? 0, ts)
    changed = true
  }
  if (!changed) return cursor
  return { ...cursor, written: capWritten(written, limit) }
}

/** True when this content hash was already consolidated by an earlier pass. */
export function isWritten(cursor: DrainCursor, hash: string): boolean {
  return !!hash && Object.hasOwn(cursor.written, hash)
}

function capWritten(written: Record<string, number>, limit: number): Record<string, number> {
  const keep = Math.max(0, Math.floor(limit))
  const entries = Object.entries(written)
  if (entries.length <= keep) return written
  entries.sort((a, b) => b[1] - a[1])
  return Object.fromEntries(entries.slice(0, keep))
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
  if (keep === 0) {
    return { ...cursor, sessions: {}, failures: {}, blocked: { ts: cursor.watermark_ts, attempts: 0, blocked_until: 0 } }
  }

  const entries = Object.entries(cursor.sessions)
  if (entries.length <= keep) return cursor

  entries.sort((a, b) => b[1].last_ts - a[1].last_ts)
  const sessions = Object.fromEntries(entries.slice(0, keep))
  const failures: Record<string, SessionFailure> = {}
  for (const [sid, failure] of Object.entries(cursor.failures)) {
    if (Object.hasOwn(sessions, sid)) failures[sid] = failure
  }
  return { ...cursor, sessions, failures }
}

/** True while a recorded failure's backoff has not elapsed. */
export function blockedBackoffActive(cursor: DrainCursor, nowMs: number = Date.now()): boolean {
  return cursor.blocked.blocked_until > nowMs
}
