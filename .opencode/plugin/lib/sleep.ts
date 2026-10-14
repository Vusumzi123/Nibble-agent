// Sleep state machine (docs/autonomy-harness-plan.md §17 — kanban card G).
//
// One StateStore at `<state>/sleep.json` drives the quiet-hours system:
//
//   awake ↔ dreaming → woken → (resume_cooldown silence) → dreaming
//
// Writers are disjoint by transition class (§17.1): sleep-hook.ts owns
// user-turn transitions only (applyWake); dream-hook.ts owns window and
// cooldown transitions (reconcileSleep) plus the tick/noop counters. A lost
// update surfaces as a skipped tick (fail-safe: never a double mission).
//
// Also home to the dream timer's due math and the §17.8 backoff brake
// (30m → 60m → 120m on consecutive no-ops, reset by any executed mission, a
// wake, or window start).
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.
import type { MoodEvent } from "./mood.ts"
import { atomicRead } from "./fsx.ts"
import { createStateStore, type StateStore } from "./state.ts"

export type SleepStatus = "awake" | "dreaming" | "woken"

export type SleepState = {
  version: number
  status: SleepStatus
  /** ISO — when the status was entered; while woken, the last user activity. */
  since: string
  /** ISO — the first wake of this window (stable across activity refreshes). */
  woken_at: string | null
  /** ISO — when the current quiet window opened (null outside the window). */
  window_opened_at: string | null
  /** Dream missions dispatched since window start (§17.3 nightly cap). */
  dreams_tonight: number
  /** Epoch ms of the last dream tick (due math; 0 = never). */
  last_tick: number
  /** Dream tick counter (the ledger's `tick` field). */
  ticks: number
  /** Consecutive ticks with no mission execution (§17.8 backoff). */
  noop_streak: number
}

export const SLEEP_VERSION = 1

export function defaultSleepState(nowIso: string = new Date().toISOString()): SleepState {
  return {
    version: SLEEP_VERSION,
    status: "awake",
    since: nowIso,
    woken_at: null,
    window_opened_at: null,
    dreams_tonight: 0,
    last_tick: 0,
    ticks: 0,
    noop_streak: 0,
  }
}

/** The shared `<state>/sleep.json` store (atomic rename, merged defaults). */
export function createSleepStore(
  stateDir: string,
  opts?: { onError?: (err: unknown) => void },
): StateStore<SleepState> {
  return createStateStore<SleepState>(
    `${stateDir.replace(/\/$/, "")}/sleep.json`,
    defaultSleepState(),
    opts,
  )
}

/** Tolerant read: missing/broken file yields the defaults (never throws). */
export async function readSleepState(file: string): Promise<SleepState> {
  try {
    const parsed = JSON.parse(await atomicRead(file))
    const merged: SleepState = {
      ...defaultSleepState(),
      ...(typeof parsed === "object" && parsed ? parsed : {}),
    }
    if (merged.status !== "awake" && merged.status !== "dreaming" && merged.status !== "woken") {
      merged.status = "awake"
    }
    if (!Number.isFinite(merged.last_tick)) merged.last_tick = 0
    merged.dreams_tonight = Number.isFinite(merged.dreams_tonight) ? Math.max(0, merged.dreams_tonight) : 0
    merged.noop_streak = Number.isFinite(merged.noop_streak) ? Math.max(0, merged.noop_streak) : 0
    merged.ticks = Number.isFinite(merged.ticks) ? Math.max(0, merged.ticks) : 0
    return merged
  } catch {
    return defaultSleepState()
  }
}

export type SleepTransition = {
  changed: boolean
  state: SleepState
  /** Mood events the caller must feed, in order (§17.7). */
  mood_events: MoodEvent[]
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function parseMs(value: string): number {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : NaN
}

/**
 * Window + cooldown transitions (§17.1 table) — dream-hook's writer class:
 *
 *   window start:  awake → dreaming   (+ fell_asleep; window_opened_at set,
 *                                      dreams_tonight and noop_streak reset)
 *   window end:    dreaming → awake   (+ well_rested — ONLY from dreaming)
 *                  woken → awake      (no well_rested: a night chatting is not
 *                                      a night slept)
 *   resume_cooldown elapsed while still quiet:
 *                  woken → dreaming   (no mood event)
 */
export function reconcileSleep(
  state: SleepState,
  opts: { nowMs: number; quiet: boolean; resumeCooldownMs: number },
): SleepTransition {
  const { nowMs, quiet, resumeCooldownMs } = opts
  const nowIso = iso(nowMs)

  if (quiet) {
    if (state.status === "awake") {
      return {
        changed: true,
        state: {
          ...state,
          status: "dreaming",
          since: nowIso,
          window_opened_at: nowIso,
          dreams_tonight: 0,
          noop_streak: 0,
        },
        mood_events: ["fell_asleep"],
      }
    }
    if (state.status === "woken") {
      const lastActivity = parseMs(state.since)
      const elapsed = Number.isFinite(lastActivity) ? nowMs - lastActivity : Infinity
      if (elapsed >= resumeCooldownMs) {
        return {
          changed: true,
          state: { ...state, status: "dreaming", since: nowIso, woken_at: null },
          mood_events: [],
        }
      }
    }
    return { changed: false, state, mood_events: [] }
  }

  if (state.status === "dreaming") {
    return {
      changed: true,
      state: {
        ...state,
        status: "awake",
        since: nowIso,
        window_opened_at: null,
        dreams_tonight: 0,
      },
      mood_events: ["well_rested"],
    }
  }
  if (state.status === "woken") {
    return {
      changed: true,
      state: { ...state, status: "awake", since: nowIso, woken_at: null },
      mood_events: [],
    }
  }
  return { changed: false, state, mood_events: [] }
}

/**
 * User-turn transitions (§17.1) — sleep-hook's writer class:
 *
 *   dreaming → woken  (+ woken mood event; woken_at stamped once per wake)
 *   woken → woken     activity refresh: `since` advances so resume_cooldown
 *                      measures from the LAST user message
 *   awake → awake     a turn outside a sleep period is not a wake
 */
export function applyWake(state: SleepState, nowMs: number): SleepTransition {
  const nowIso = iso(nowMs)
  if (state.status === "dreaming") {
    return {
      changed: true,
      state: { ...state, status: "woken", since: nowIso, woken_at: nowIso, noop_streak: 0 },
      mood_events: ["woken"],
    }
  }
  if (state.status === "woken") {
    if (state.since === nowIso) return { changed: false, state, mood_events: [] }
    return {
      changed: true,
      state: { ...state, since: nowIso },
      mood_events: [],
    }
  }
  return { changed: false, state, mood_events: [] }
}

/** The injected `[wake]` block for the waking turn (§17.7). */
export function buildWakeLine(
  prevSince: string,
  moodLine: string,
  nowIso: string = new Date().toISOString(),
): string {
  const since = Number.isFinite(Date.parse(prevSince)) ? prevSince : nowIso
  return `[wake] You were dreaming since ${since}; your message woke you at ${nowIso}. Resume cooldown before the dream timer re-engages. ${moodLine}`.trim()
}

// ---------------------------------------------------------------------------
// §17.8 brake: adaptive backoff — 30m → 60m → 120m on consecutive no-ops.

/** The cadence ceiling no backoff step may exceed (§17.8 "capped"). */
export const DREAM_BACKOFF_CAP_MS = 120 * 60_000

/**
 * The shared backoff ladder (§17.8): steps at streak 2 (×2) and streak 3+
 * (×4). The heartbeat's day-side B7 twin (missions-plan §7) reuses it on the
 * day cadence; "steps the cadence after 2 no-ops" is the acceptance shape.
 */
export function backoffMultiplier(noopStreak: number): 1 | 2 | 4 {
  if (noopStreak < 2) return 1
  return noopStreak === 2 ? 2 : 4
}

/**
 * Effective dream cadence after backoff, capped at 120m (§17.8). `backoff:
 * false` pins the base cadence.
 */
export function dreamTickDelayMs(cadenceMs: number, noopStreak: number, backoff: boolean): number {
  if (!backoff || noopStreak < 2) return cadenceMs
  return Math.min(cadenceMs * backoffMultiplier(noopStreak), DREAM_BACKOFF_CAP_MS)
}

/** `30m`/`1h` → ms; malformed/zero → the supplied default (never throws). */
export function durationToMs(value: string, fallbackMs: number): number {
  const m = /^(\d+)([mh])$/.exec(String(value ?? "").trim())
  if (!m) return fallbackMs
  const n = parseInt(m[1], 10)
  if (!Number.isFinite(n) || n <= 0) return fallbackMs
  return n * (m[2] === "h" ? 3_600_000 : 60_000)
}

/** The self-rescheduling wake is capped here (hot config, like heartbeat). */
export const DREAM_WAKE_CAP_MS = 60_000

export type DreamWakeInput = {
  /** autonomy.level hot-read; L0 sleeps the timer entirely. */
  level: number
  /** isQuietNow() over autonomy.quiet.window. */
  quiet: boolean
  /** sleep.json status after reconcile. */
  status: SleepStatus
  /** autonomy.quiet.dream_cadence in ms. */
  cadenceMs: number
  /** sleep.json last_tick epoch ms; 0 = never ticked. */
  lastTickMs: number
  nowMs: number
  noopStreak: number
  backoff: boolean
}

/**
 * Pure due math for one dream wake:
 *
 *   L0 / outside window / not dreaming → the 60s cap (poll for window start,
 *     cooldown end, or a hot dial flip — zero cost between wakes)
 *   dreaming, not yet due              → min(remaining, cap)
 *   due or never ticked                → 0 (missed ticks coalesce, never replay)
 */
export function computeDreamWakeDelayMs(input: DreamWakeInput): number {
  if (input.level <= 0) return DREAM_WAKE_CAP_MS
  if (!input.quiet || input.status !== "dreaming") return DREAM_WAKE_CAP_MS
  if (input.lastTickMs <= 0) return 0
  const delay = dreamTickDelayMs(input.cadenceMs, input.noopStreak, input.backoff)
  const remaining = input.lastTickMs + delay - input.nowMs
  if (remaining <= 0) return 0
  return Math.min(remaining, DREAM_WAKE_CAP_MS)
}
