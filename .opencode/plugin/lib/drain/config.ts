// `drain:` configuration (knowledge-pipeline-redesign §C.1).
//
// Flat scalars under the `drain:` section of .opencode/sysop-config.yaml,
// overlaid on the defaults. A missing/malformed section yields the defaults and
// never throws.
//
// Loaded via relative import only.
import { parseFlatBlock, parseInlineList, readSection, sectionCoercer } from "../config.ts"

export type DrainConfig = {
  enabled: boolean
  cursor_file: string
  writer_model: string
  summarize_model: string
  batch_sessions: number
  initial_lookback_hours: number
  max_turns_per_session: number
  max_session_bytes: number
  max_items_per_session: number
  max_items_per_batch: number
  prefetch_candidates: number
  continuity_turns: number
  continuity_sessions: number
  poison_attempts: number
  drain_prompt_max_bytes: number
  /** Mission ids whose child transcripts are already represented elsewhere. */
  exclude_missions: string[]
  /** true = heartbeat `drain-pass` work item; false = legacy side mission. */
  consumer: boolean
  /** Run a pass while pending >= N (drain-consumer-plan §2.5). */
  trigger_pending: number
  /** Run a pass while the oldest pending turn is >= T hours. */
  trigger_max_age_hours: number
  /** A session idle for less than this is not consumed (settle guard). */
  settle_seconds: number
  /** Consumer reschedule delay when the backlog is below the trigger. */
  poll_seconds: number
  /** Wall-clock ceiling for one consumer wake (§2.6). */
  max_wall_minutes: number
  /** Per-pass token budget; 0 = unlimited (ceiling, not a target). */
  token_budget: number
  /** Per-wake token budget (§2.6). */
  wake_token_budget: number
  /** Backstop only — the observable budgets decide (§2.6). */
  max_passes_per_wake: number
  /** Drain lock heartbeat interval (§2.4). */
  lock_refresh_ms: number
  /** Drain lock stale threshold = 3 × lock_refresh_ms (§2.4). */
  lock_stale_ms: number
  /** v1 → v2 mark repair at discovery: carry | recover (§2.3.1). */
  cursor_migration: "carry" | "recover"
}

export const DEFAULT_DRAIN: DrainConfig = {
  enabled: true,
  cursor_file: "drain-cursor.json",
  writer_model: "",
  summarize_model: "",
  batch_sessions: 5,
  initial_lookback_hours: 24,
  max_turns_per_session: 40,
  max_session_bytes: 24000,
  max_items_per_session: 6,
  max_items_per_batch: 8,
  prefetch_candidates: 3,
  continuity_turns: 6,
  continuity_sessions: 20,
  poison_attempts: 3,
  drain_prompt_max_bytes: 60000,
  exclude_missions: ["drain", "staleness", "dream"],
  consumer: true,
  trigger_pending: 12,
  trigger_max_age_hours: 2,
  settle_seconds: 120,
  poll_seconds: 60,
  max_wall_minutes: 15,
  token_budget: 80000,
  wake_token_budget: 250000,
  max_passes_per_wake: 6,
  lock_refresh_ms: 60000,
  lock_stale_ms: 180000,
  cursor_migration: "carry",
}

const BOOL_KEYS = new Set(["enabled", "consumer"])
const INT_KEYS = new Set([
  "batch_sessions",
  "initial_lookback_hours",
  "max_turns_per_session",
  "max_session_bytes",
  "max_items_per_session",
  "max_items_per_batch",
  "prefetch_candidates",
  "continuity_turns",
  "continuity_sessions",
  "poison_attempts",
  "drain_prompt_max_bytes",
  "trigger_pending",
  "trigger_max_age_hours",
  "settle_seconds",
  "poll_seconds",
  "max_wall_minutes",
  "token_budget",
  "wake_token_budget",
  "max_passes_per_wake",
  "lock_refresh_ms",
  "lock_stale_ms",
])
const KNOWN_KEYS = new Set(Object.keys(DEFAULT_DRAIN))

const DRAIN_COERCE = sectionCoercer({
  bools: BOOL_KEYS,
  ints: INT_KEYS,
  stringMode: "pair-quotes",
})

const MISSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
function normalizeMissionIds(values: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of values) {
    const id = raw.trim()
    if (MISSION_ID_RE.test(id) && !out.includes(id)) out.push(id)
  }
  return out
}

/** Parse the `exclude_missions` value: inline list (`[a, b]`) or comma list. */
function coerceMissionList(raw: unknown): string[] | null {
  if (Array.isArray(raw)) {
    return normalizeMissionIds(raw.filter((v): v is string => typeof v === "string"))
  }
  if (typeof raw !== "string") return null
  const text = raw.trim()
  if (text.startsWith("[")) {
    const parsed = parseInlineList(text)
    return parsed ? normalizeMissionIds(parsed) : null
  }
  if (!text) return null
  return normalizeMissionIds(text.split(","))
}

export function parseDrainConfig(yamlText: string): Partial<DrainConfig> {
  const parsed = parseFlatBlock(yamlText, "drain", {
    knownKeys: KNOWN_KEYS,
    coerce: DRAIN_COERCE,
  }) as Record<string, unknown>
  if ("exclude_missions" in parsed) {
    const list = coerceMissionList(parsed.exclude_missions)
    if (list) parsed.exclude_missions = list
    else delete parsed.exclude_missions
  }
  return parsed as Partial<DrainConfig>
}

function atLeast(value: number, min: number, fallback: number): number {
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback
}

export async function readDrainConfig(directory: string): Promise<DrainConfig> {
  const cfg = await readSection(directory, "drain", DEFAULT_DRAIN, { coerce: DRAIN_COERCE })

  cfg.batch_sessions = atLeast(cfg.batch_sessions, 1, DEFAULT_DRAIN.batch_sessions)
  cfg.initial_lookback_hours = atLeast(
    cfg.initial_lookback_hours,
    0,
    DEFAULT_DRAIN.initial_lookback_hours,
  )
  cfg.max_turns_per_session = atLeast(
    cfg.max_turns_per_session,
    1,
    DEFAULT_DRAIN.max_turns_per_session,
  )
  cfg.max_session_bytes = atLeast(cfg.max_session_bytes, 0, DEFAULT_DRAIN.max_session_bytes)
  cfg.max_items_per_session = atLeast(
    cfg.max_items_per_session,
    1,
    DEFAULT_DRAIN.max_items_per_session,
  )
  cfg.max_items_per_batch = atLeast(
    cfg.max_items_per_batch,
    1,
    DEFAULT_DRAIN.max_items_per_batch,
  )
  cfg.prefetch_candidates = atLeast(
    cfg.prefetch_candidates,
    0,
    DEFAULT_DRAIN.prefetch_candidates,
  )
  cfg.continuity_turns = atLeast(cfg.continuity_turns, 0, DEFAULT_DRAIN.continuity_turns)
  cfg.continuity_sessions = atLeast(
    cfg.continuity_sessions,
    0,
    DEFAULT_DRAIN.continuity_sessions,
  )
  cfg.poison_attempts = atLeast(cfg.poison_attempts, 0, DEFAULT_DRAIN.poison_attempts)
  cfg.drain_prompt_max_bytes = atLeast(
    cfg.drain_prompt_max_bytes,
    0,
    DEFAULT_DRAIN.drain_prompt_max_bytes,
  )
  cfg.trigger_pending = atLeast(cfg.trigger_pending, 1, DEFAULT_DRAIN.trigger_pending)
  cfg.trigger_max_age_hours = atLeast(
    cfg.trigger_max_age_hours,
    1,
    DEFAULT_DRAIN.trigger_max_age_hours,
  )
  cfg.settle_seconds = atLeast(cfg.settle_seconds, 0, DEFAULT_DRAIN.settle_seconds)
  cfg.poll_seconds = atLeast(cfg.poll_seconds, 1, DEFAULT_DRAIN.poll_seconds)
  cfg.max_wall_minutes = atLeast(cfg.max_wall_minutes, 1, DEFAULT_DRAIN.max_wall_minutes)
  cfg.token_budget = atLeast(cfg.token_budget, 0, DEFAULT_DRAIN.token_budget)
  cfg.wake_token_budget = atLeast(cfg.wake_token_budget, 0, DEFAULT_DRAIN.wake_token_budget)
  cfg.max_passes_per_wake = atLeast(
    cfg.max_passes_per_wake,
    1,
    DEFAULT_DRAIN.max_passes_per_wake,
  )
  cfg.lock_refresh_ms = atLeast(cfg.lock_refresh_ms, 1000, DEFAULT_DRAIN.lock_refresh_ms)
  // Stale must be >= 3 × refresh so a slow unit never risks its own lock (§2.4).
  cfg.lock_stale_ms = Math.max(
    atLeast(cfg.lock_stale_ms, 1000, DEFAULT_DRAIN.lock_stale_ms),
    3 * cfg.lock_refresh_ms,
  )

  if (typeof cfg.cursor_file !== "string" || !cfg.cursor_file.trim()) {
    cfg.cursor_file = DEFAULT_DRAIN.cursor_file
  }
  if (typeof cfg.writer_model !== "string") cfg.writer_model = DEFAULT_DRAIN.writer_model
  if (typeof cfg.summarize_model !== "string") cfg.summarize_model = DEFAULT_DRAIN.summarize_model
  if (cfg.cursor_migration !== "recover") cfg.cursor_migration = "carry"
  cfg.exclude_missions =
    coerceMissionList(cfg.exclude_missions) ?? [...DEFAULT_DRAIN.exclude_missions]

  return cfg
}
