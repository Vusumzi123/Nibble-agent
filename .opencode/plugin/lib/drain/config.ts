// `drain:` configuration (knowledge-pipeline-redesign §C.1).
//
// Flat scalars under the `drain:` section of .opencode/sysop-config.yaml,
// overlaid on the defaults. A missing/malformed section yields the defaults and
// never throws.
//
// Loaded via relative import only.
import { parseFlatBlock, readSection, sectionCoercer } from "../config.ts"

export type DrainConfig = {
  enabled: boolean
  cursor_file: string
  writer_model: string
  summarize_model: string
  batch_sessions: number
  max_turns_per_session: number
  max_session_bytes: number
  max_items_per_session: number
  prefetch_candidates: number
  continuity_turns: number
  continuity_sessions: number
  poison_attempts: number
  drain_prompt_max_bytes: number
}

export const DEFAULT_DRAIN: DrainConfig = {
  enabled: true,
  cursor_file: "drain-cursor.json",
  writer_model: "",
  summarize_model: "",
  batch_sessions: 5,
  max_turns_per_session: 40,
  max_session_bytes: 24000,
  max_items_per_session: 6,
  prefetch_candidates: 3,
  continuity_turns: 6,
  continuity_sessions: 20,
  poison_attempts: 3,
  drain_prompt_max_bytes: 60000,
}

const BOOL_KEYS = new Set(["enabled"])
const INT_KEYS = new Set([
  "batch_sessions",
  "max_turns_per_session",
  "max_session_bytes",
  "max_items_per_session",
  "prefetch_candidates",
  "continuity_turns",
  "continuity_sessions",
  "poison_attempts",
  "drain_prompt_max_bytes",
])
const KNOWN_KEYS = new Set(Object.keys(DEFAULT_DRAIN))

const DRAIN_COERCE = sectionCoercer({
  bools: BOOL_KEYS,
  ints: INT_KEYS,
  stringMode: "pair-quotes",
})

export function parseDrainConfig(yamlText: string): Partial<DrainConfig> {
  return parseFlatBlock(yamlText, "drain", {
    knownKeys: KNOWN_KEYS,
    coerce: DRAIN_COERCE,
  }) as Partial<DrainConfig>
}

function atLeast(value: number, min: number, fallback: number): number {
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback
}

export async function readDrainConfig(directory: string): Promise<DrainConfig> {
  const cfg = await readSection(directory, "drain", DEFAULT_DRAIN, { coerce: DRAIN_COERCE })

  cfg.batch_sessions = atLeast(cfg.batch_sessions, 1, DEFAULT_DRAIN.batch_sessions)
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

  if (typeof cfg.cursor_file !== "string" || !cfg.cursor_file.trim()) {
    cfg.cursor_file = DEFAULT_DRAIN.cursor_file
  }
  if (typeof cfg.writer_model !== "string") cfg.writer_model = DEFAULT_DRAIN.writer_model
  if (typeof cfg.summarize_model !== "string") cfg.summarize_model = DEFAULT_DRAIN.summarize_model

  return cfg
}
