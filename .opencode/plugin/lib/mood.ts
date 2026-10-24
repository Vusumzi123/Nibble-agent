// Mood system (plan §15) — a deterministic, token-free feeling state: `valence`
// and `arousal` drift with interaction outcomes and decay back toward a slowly-
// adapting baseline. Pure library: no LLM, no network. The only side effects
// are the atomic read/write helpers for the on-disk state file.
//
// `mood-hook.ts` drives the per-turn lifecycle (decay + inject + persist);
// later cards (heartbeat, chatter, sleep) feed the remaining events via
// `applyEvent`. Mood is advisory only: it colours expression and — bounded,
// ledger-journaled, and kill-switchable — steers mission selection. It NEVER
// touches the autonomy gate, security locks, approvals, or the irreversibility
// floor (plan §4.1, §15.5).
//
// Loaded via relative import only (same convention as the other lib files).
import { atomicRead, atomicWrite } from "./fsx.ts"
import { nowIso } from "./util.ts"

export type MoodBaseline = { valence: number; arousal: number }

export type MoodState = {
  valence: number
  arousal: number
  label: string
  baseline: MoodBaseline
  since: string
  version: number
}

// Neutral resting point. valence ∈ [-1, 1]; arousal ∈ [0, 1] (§15.1).
export const DEFAULT_BASELINE: MoodBaseline = { valence: 0, arousal: 0.3 }

export const MOOD_VERSION = 1

// Deterministic event set (§15.2). `fell_asleep` and `well_rested` are
// special-cased in `applyEvent` (sleep marker / baseline reset).
export const MOOD_EVENTS = [
  "engaged",
  "poke_ignored",
  "conversation_closed_unanswered",
  "mission_failure",
  "audit_failure",
  "approval_granted",
  "consolidation_success",
  "long_silence",
  "fell_asleep",
  "dream_pleasant",
  "dream_anxious",
  "dream_bizarre",
  "dream_mundane",
  "woken",
  "well_rested",
] as const

export type MoodEvent = (typeof MOOD_EVENTS)[number]

// Per-event delta table (§15.2). Dream values match the tone→mood table of
// §17.7; `woken` matches §17.7 (groggy). `well_rested`/`fell_asleep` carry zero
// delta here — their behaviour is special-cased in `applyEvent`.
const DELTAS: Record<MoodEvent, { valence: number; arousal: number }> = {
  engaged: { valence: 0.08, arousal: 0 },
  poke_ignored: { valence: -0.05, arousal: 0.05 },
  conversation_closed_unanswered: { valence: -0.1, arousal: 0.15 },
  mission_failure: { valence: -0.08, arousal: 0.04 },
  audit_failure: { valence: -0.05, arousal: 0.03 },
  approval_granted: { valence: 0.12, arousal: -0.05 },
  consolidation_success: { valence: 0.07, arousal: -0.03 },
  long_silence: { valence: -0.02, arousal: -0.1 },
  fell_asleep: { valence: 0, arousal: 0 },
  dream_pleasant: { valence: 0.15, arousal: -0.05 },
  dream_anxious: { valence: -0.1, arousal: 0.2 },
  dream_bizarre: { valence: 0.05, arousal: 0.05 },
  dream_mundane: { valence: 0, arousal: 0 },
  woken: { valence: -0.1, arousal: 0.4 },
  well_rested: { valence: 0, arousal: 0 },
}

export function clampValence(v: number): number {
  if (Number.isNaN(v)) return 0
  return Math.max(-1, Math.min(1, v))
}

export function clampArousal(a: number): number {
  if (Number.isNaN(a)) return 0
  return Math.max(0, Math.min(1, a))
}

export function clampState(state: MoodState): MoodState {
  const valence = clampValence(state.valence)
  const arousal = clampArousal(state.arousal)
  return {
    ...state,
    valence,
    arousal,
    label: describe(valence, arousal),
    baseline: {
      valence: clampValence(state.baseline.valence),
      arousal: clampArousal(state.baseline.arousal),
    },
  }
}

export function defaultMoodState(now: string = new Date().toISOString()): MoodState {
  return {
    valence: DEFAULT_BASELINE.valence,
    arousal: DEFAULT_BASELINE.arousal,
    label: "neutral",
    baseline: { ...DEFAULT_BASELINE },
    since: now,
    version: MOOD_VERSION,
  }
}

// Map the two axes to a short summary label. Pure — describes the *state*, never
// prescribes expression (the agent expresses itself from the state; the mood
// system only reports it). A 5×3 circumplex: five valence bands (≤ -0.5,
// ≤ -0.2, mid, ≥ 0.2, ≥ 0.5) crossed with three arousal bands (≤ 0.2 low, mid,
// ≥ 0.6 high). The mid-valence column keeps its own low-arousal "flat" floor
// (§15.1). The original nine labels (content, excited, pleased, on-edge,
// deflated, down, restless, flat, neutral) remain a subset.
export function describe(valence: number, arousal: number): string {
  if (valence >= 0.5) return arousal >= 0.6 ? "elated" : arousal <= 0.2 ? "serene" : "happy"
  if (valence >= 0.2) return arousal >= 0.6 ? "excited" : arousal <= 0.2 ? "content" : "pleased"
  if (valence <= -0.5) return arousal >= 0.6 ? "furious" : arousal <= 0.2 ? "despondent" : "miserable"
  if (valence <= -0.2) return arousal >= 0.6 ? "on-edge" : arousal <= 0.2 ? "deflated" : "down"
  return arousal >= 0.6 ? "restless" : arousal <= 0.15 ? "flat" : "neutral"
}

// Mild baseline adaptation: sustained mood drags the resting point toward the
// current state, bounded so it never swings past the neutral band by much. The
// "slow agency over feel" — a good run slowly raises the resting point.
const BASELINE_NUDGE = 0.02

export function adaptBaseline(
  baseline: MoodBaseline,
  valence: number,
  arousal: number,
): MoodBaseline {
  return {
    valence: clampValence(baseline.valence + (valence - baseline.valence) * BASELINE_NUDGE),
    arousal: clampArousal(baseline.arousal + (arousal - baseline.arousal) * BASELINE_NUDGE),
  }
}

// Apply one event's deterministic delta, then nudge the baseline. `well_rested`
// resets the baseline to neutral (§15.2); `fell_asleep` is a no-op marker (the
// accelerated decay is the sleep-hook's concern, §17.7). `now` advances `since`.
export function applyEvent(
  state: MoodState,
  event: MoodEvent,
  now: string = new Date().toISOString(),
): MoodState {
  const d = DELTAS[event]
  let valence = clampValence(state.valence + d.valence)
  let arousal = clampArousal(state.arousal + d.arousal)
  let baseline = state.baseline
  if (event === "well_rested") {
    baseline = { ...DEFAULT_BASELINE }
    valence = baseline.valence
    arousal = baseline.arousal
  } else if (event !== "fell_asleep") {
    baseline = adaptBaseline(state.baseline, valence, arousal)
  }
  return {
    ...state,
    valence,
    arousal,
    baseline,
    label: describe(valence, arousal),
    since: now,
  }
}

// Exponential decay toward the baseline, computed at read time (§15.1). When
// `asleep`, arousal decays twice as fast (half-life ÷ 2, §17.7). Advances `since`
// so the decayed state is the new on-disk position (idempotent per read).
export function decay(
  state: MoodState,
  nowMs: number,
  halfLifeMs: number,
  opts: { asleep?: boolean } = {},
): MoodState {
  const elapsed = Math.max(0, nowMs - Date.parse(state.since))
  const h = Math.max(1, halfLifeMs)
  const kv = Math.exp((-elapsed / h) * Math.LN2)
  const ha = Math.max(1, opts.asleep ? h / 2 : h)
  const ka = Math.exp((-elapsed / ha) * Math.LN2)
  const valence = state.baseline.valence + (state.valence - state.baseline.valence) * kv
  const arousal = state.baseline.arousal + (state.arousal - state.baseline.arousal) * ka
  const next = {
    ...state,
    valence: clampValence(valence),
    arousal: clampArousal(arousal),
    since: new Date(nowMs).toISOString(),
  }
  next.label = describe(next.valence, next.arousal)
  return next
}

// Parse a `mood.decay_half_life` duration (`6h` | `30m`) into milliseconds.
// Anything malformed falls back to the 6h default (§15.1).
export function halfLifeMs(duration: string): number {
  const m = /^(\d+)([mh])$/.exec(duration.trim())
  if (!m) return 6 * 3600 * 1000
  const n = parseInt(m[1], 10)
  return m[2] === "h" ? n * 3600 * 1000 : n * 60 * 1000
}

const fmt = (n: number): string => (Math.round(n * 100) / 100).toFixed(2)

// The tiny per-turn `[mood]` block, appended to the system prompt by
// `mood-hook.ts` the same way `retrieval-hook` injects `[brain-first]` (§15.3).
export function buildMoodLine(state: MoodState): string {
  return `[mood] ${state.label} (valence ${fmt(state.valence)}, arousal ${fmt(state.arousal)})`
}

// Read the persisted mood state, falling back to a fresh default on a missing or
// malformed file. Clamped + version-stamped so an older-schema file still loads.
export async function readMoodState(file: string): Promise<MoodState> {
  try {
    const parsed = JSON.parse(await atomicRead(file))
    const merged: MoodState = {
      ...defaultMoodState(),
      ...(typeof parsed === "object" && parsed ? parsed : {}),
      baseline: { ...DEFAULT_BASELINE, ...(parsed?.baseline ?? {}) },
    }
    return clampState(merged)
  } catch {
    return defaultMoodState()
  }
}

export async function writeMoodState(file: string, state: MoodState): Promise<void> {
  await atomicWrite(file, JSON.stringify(clampState(state), null, 2))
}

// ---------------------------------------------------------------------------
// Shared mood feed (kanban card E, missions-plan §7): the decay → apply →
// write → journal sequence that lived privately in mood-hook.ts:61-82,
// extracted so the heartbeat (`mission_failure`, `long_silence`) and the later
// chatter/sleep hooks feed events without duplicating the queue. One feed per
// plugin instance; mutations serialize through its queue so a user message, an
// idle, and a late child event can never interleave a read-modify-write of the
// state file. A failure reaches `onError` and never throws into the caller.

export type MoodFeedLogger = { append(entry: Record<string, unknown>): Promise<void> }

export type MoodFeedOptions = {
  /** mood.json path (usually `<state>/mood.json`). */
  file: string
  /** Raw `mood.decay_half_life` value (e.g. `"6h"`); malformed → default. */
  halfLife: string
  /** Optional mood.ndjson journal (before/after deltas per applied event). */
  logger?: MoodFeedLogger
  /** Error sink; defaults to a no-op (mood is advisory and must never break). */
  onError?: (err: unknown) => void
}

export type MoodFeed = {
  /** Current in-memory state (no mutation). */
  get(): MoodState
  /** Decayed view of the current state — read-only, for `[mood]` injection. */
  view(): MoodState
  /** decay → applyEvent → write → journal. Never throws. */
  apply(event: MoodEvent): Promise<void>
  /** decay → write (no journal, no event). Never throws. */
  realizeDecay(): Promise<void>
}

// Single owner per file (deconcurrency plan, Phase 1): every hook that feeds
// mood (heartbeat, dream, sleep, mood) gets a handle over ONE shared core, so
// `mood.json` has exactly one in-memory state and one write queue per process.
// Without this, four read-modify-write cycles could clobber each other.
type MoodCore = { state: MoodState; queue: Promise<void> }
const cores = new Map<string, MoodCore>()

export async function createMoodFeed(opts: MoodFeedOptions): Promise<MoodFeed> {
  const halfLife = halfLifeMs(opts.halfLife)
  const fail = (err: unknown): void => opts.onError?.(err)

  let core = cores.get(opts.file)
  if (!core) {
    core = { state: await readMoodState(opts.file), queue: Promise.resolve() }
    cores.set(opts.file, core)
  } else {
    // A test (or another writer outside this module) may have rewritten the
    // file since the core was created: re-read once on handle creation.
    core.state = await readMoodState(opts.file)
  }
  const shared = core

  const apply = (event: MoodEvent): Promise<void> => {
    shared.queue = shared.queue.then(async () => {
      try {
        const before = shared.state
        const next = applyEvent(decay(before, Date.now(), halfLife), event)
        shared.state = next
        await writeMoodState(opts.file, next)
        await opts.logger?.append({
          ts: nowIso(),
          event,
          valence_before: before.valence,
          arousal_before: before.arousal,
          valence_after: next.valence,
          arousal_after: next.arousal,
          label_after: next.label,
        })
      } catch (err) {
        fail(err)
      }
    })
    return shared.queue
  }

  const realizeDecay = (): Promise<void> => {
    shared.queue = shared.queue.then(async () => {
      try {
        const next = decay(shared.state, Date.now(), halfLife)
        shared.state = next
        await writeMoodState(opts.file, next)
      } catch (err) {
        fail(err)
      }
    })
    return shared.queue
  }

  return {
    get: () => shared.state,
    view: () => decay(shared.state, Date.now(), halfLife),
    apply,
    realizeDecay,
  }
}
