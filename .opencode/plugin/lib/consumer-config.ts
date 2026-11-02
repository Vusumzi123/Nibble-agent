// `consumer:` configuration (docs/CHRON-SCHEDULER-PLAN.md §5.4, §7).
//
// Flat scalars under the `consumer:` section of .opencode/sysop-config.yaml,
// overlaid on the defaults. A missing/malformed section yields the defaults and
// never throws. `0` disables a cap (unlimited).
//
// Loaded via relative import only.
import { parseFlatBlock, readSection, schemaFromDefaults } from "./config.ts"

export type ConsumerConfig = {
  /** Executed items per session; 0 = unlimited. */
  max_items_per_tick: number
  /** Wall ceiling in minutes; 0 = unlimited. */
  max_wall_minutes: number
  /** Summed item tokens; 0 = unlimited. */
  token_budget: number
}

export const DEFAULT_CONSUMER: ConsumerConfig = {
  max_items_per_tick: 10,
  max_wall_minutes: 60,
  token_budget: 250_000,
}

const CONSUMER_KEYS = new Set(Object.keys(DEFAULT_CONSUMER))

function nonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

export function normalizeConsumerConfig(cfg: ConsumerConfig): ConsumerConfig {
  return {
    max_items_per_tick: nonNegative(
      cfg.max_items_per_tick,
      DEFAULT_CONSUMER.max_items_per_tick,
    ),
    max_wall_minutes: nonNegative(cfg.max_wall_minutes, DEFAULT_CONSUMER.max_wall_minutes),
    token_budget: nonNegative(cfg.token_budget, DEFAULT_CONSUMER.token_budget),
  }
}

export function parseConsumerConfig(yamlText: string): ConsumerConfig {
  const parsed = parseFlatBlock(yamlText, "consumer", {
    schema: schemaFromDefaults(DEFAULT_CONSUMER),
    knownKeys: CONSUMER_KEYS,
  })
  return normalizeConsumerConfig({ ...DEFAULT_CONSUMER, ...(parsed as Partial<ConsumerConfig>) })
}

export async function readConsumerConfig(directory: string): Promise<ConsumerConfig> {
  return normalizeConsumerConfig(await readSection(directory, "consumer", DEFAULT_CONSUMER))
}
