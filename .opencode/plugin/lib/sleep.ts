// Sleep state machine (docs/autonomy-harness-plan.md §17 — kanban card G).
//
// One StateStore at `<state>/sleep.json` drives the quiet-hours system:
//
//   awake ↔ dreaming → woken → (resume_cooldown silence) → dreaming
//
// Writers are disjoint by transition class (§17.1): sleep-hook.ts owns
// user-turn transitions only (applyWake); heartbeat-hook.ts owns window and
// cooldown transitions (reconcileSleep) plus the nightly dream counter. A lost
// update surfaces as a skipped tick (fail-safe: never a double mission).
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.
import type { MoodEvent } from "./mood.ts"
import { atomicRead } from "./fsx.ts"
import { createStateStore, type StateStore } from "./state.ts"
import { DEFAULT_SLEEP_PROMPTS, type SleepPrompts } from "./sleep-prompts.ts"

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
  /** Epoch ms of the last dream tick (diagnostics; 0 = never). */
  last_tick: number
  /** Dream tick counter (the ledger's `tick` field). */
  ticks: number
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
 * Window + cooldown transitions (§17.1 table) — heartbeat-hook's writer class:
 *
 *   window start:  awake → dreaming   (+ fell_asleep; window_opened_at set,
 *                                      dreams_tonight reset)
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
      state: { ...state, status: "woken", since: nowIso, woken_at: nowIso },
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
  return `[wake] You were dreaming since ${since}; the user's message woke you at ${nowIso}. ${moodLine}`.trim()
}

/**
 * The `[sleepState]` directive: the clock (`quiet`) wins over a stale status.
 * The text comes from the externalized prompt file, falling back to the
 * compiled defaults.
 */
export function sleepDirective(
  status: SleepStatus,
  quiet: boolean,
  prompts: SleepPrompts = DEFAULT_SLEEP_PROMPTS,
): string {
  if (!quiet) return prompts.awake
  if (status === "dreaming") return prompts.dreaming
  if (status === "woken") return prompts.woken
  return prompts.quiet_awake
}

/** The complete line injected into the system prompt / mission brief. */
export function buildSleepLine(
  status: SleepStatus,
  quiet: boolean,
  prompts: SleepPrompts = DEFAULT_SLEEP_PROMPTS,
): string {
  return `[sleepState] ${sleepDirective(status, quiet, prompts)}`
}

// ---------------------------------------------------------------------------
// Shared cadence helpers.

/**
 * The B7 backoff ladder (missions-plan §7): steps at streak 2 (×2) and streak
 * 3+ (×4). The heartbeat's day cadence reuses it; "steps the cadence after 2
 * no-ops" is the acceptance shape.
 */
export function backoffMultiplier(noopStreak: number): 1 | 2 | 4 {
  if (noopStreak < 2) return 1
  return noopStreak === 2 ? 2 : 4
}

/** `30m`/`1h` → ms; malformed/zero → the supplied default (never throws). */
export function durationToMs(value: string, fallbackMs: number): number {
  const m = /^(\d+)([mh])$/.exec(String(value ?? "").trim())
  if (!m) return fallbackMs
  const n = parseInt(m[1], 10)
  if (!Number.isFinite(n) || n <= 0) return fallbackMs
  return n * (m[2] === "h" ? 3_600_000 : 60_000)
}
