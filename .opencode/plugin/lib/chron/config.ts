// `chron:` configuration (docs/CHRON-SCHEDULER-PLAN.md §7).
//
// Flat scalars under the `chron:` section of .opencode/sysop-config.yaml,
// overlaid on the defaults. A missing/malformed section yields the defaults and
// never throws.
//
// Loaded via relative import only.
import { parseFlatBlock, readSection, schemaFromDefaults } from "../config.ts"

export type ChronConfig = {
  enabled: boolean
  schedule_dir: string
  state_file: string
  inbox_dir: string
  max_sleep_seconds: number
  prompt_ttl_hours: number
  default_priority: number
  mission_scan: string
  mission_max_per_scan: number
  defer_ttl_hours: number
}

export const DEFAULT_CHRON: ChronConfig = {
  enabled: true,
  schedule_dir: ".opencode/schedule",
  state_file: "chron.json",
  inbox_dir: "inbox",
  max_sleep_seconds: 60,
  prompt_ttl_hours: 24,
  default_priority: 5,
  mission_scan: "every 1m",
  mission_max_per_scan: 5,
  defer_ttl_hours: 24,
}

const CHRON_KEYS = new Set(Object.keys(DEFAULT_CHRON))

function nonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

/** Semantic checks the flat parser cannot express (negative counts, ranges). */
export function normalizeChronConfig(cfg: ChronConfig): ChronConfig {
  return {
    ...cfg,
    max_sleep_seconds: nonNegative(cfg.max_sleep_seconds, DEFAULT_CHRON.max_sleep_seconds),
    prompt_ttl_hours: nonNegative(cfg.prompt_ttl_hours, DEFAULT_CHRON.prompt_ttl_hours),
    mission_max_per_scan: nonNegative(
      cfg.mission_max_per_scan,
      DEFAULT_CHRON.mission_max_per_scan,
    ),
    defer_ttl_hours: nonNegative(cfg.defer_ttl_hours, DEFAULT_CHRON.defer_ttl_hours),
    default_priority:
      Number.isInteger(cfg.default_priority) &&
      cfg.default_priority >= 0 &&
      cfg.default_priority <= 9
        ? cfg.default_priority
        : DEFAULT_CHRON.default_priority,
  }
}

export function parseChronConfig(yamlText: string): ChronConfig {
  const parsed = parseFlatBlock(yamlText, "chron", {
    schema: schemaFromDefaults(DEFAULT_CHRON),
    knownKeys: CHRON_KEYS,
  })
  return normalizeChronConfig({ ...DEFAULT_CHRON, ...(parsed as Partial<ChronConfig>) })
}

export async function readChronConfig(directory: string): Promise<ChronConfig> {
  return normalizeChronConfig(await readSection(directory, "chron", DEFAULT_CHRON))
}
