// `scheduler:` configuration for the SWRR work scheduler.
//
// Shape:
//   scheduler:
//     fair: true
//     weights:
//       mission: 4
//       drain-pass: 3
//       ...
//
// Missing/malformed values fall back to the defaults; never throws.
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { HYPHEN_KEY_RE, SYSCONFIG, parseNestedSection } from "./config.ts"
import {
  DEFAULT_WORK_WEIGHTS,
  KIND_ORDER,
  normalizeWeights,
  type WorkWeights,
} from "./work-queue.ts"

export type SchedulerConfig = {
  fair: boolean
  weights: WorkWeights
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  fair: true,
  weights: { ...DEFAULT_WORK_WEIGHTS },
}

const SCALAR_KEYS = new Set(["fair"])
const BLOCK_KEYS = { weights: new Set<string>(KIND_ORDER) }

function coerce(
  path: string,
  raw: string,
): { ok: true; value: unknown } | { ok: false; reason: string } | undefined {
  if (path === "fair") {
    if (raw === "true") return { ok: true, value: true }
    if (raw === "false") return { ok: true, value: false }
    return { ok: false, reason: "expected true|false" }
  }
  if (path.startsWith("weights.")) {
    return /^\d+$/.test(raw)
      ? { ok: true, value: parseInt(raw, 10) }
      : { ok: false, reason: "expected a non-negative integer" }
  }
  return undefined
}

export function parseSchedulerConfig(yamlText: string): SchedulerConfig {
  const parsed = parseNestedSection(yamlText, "scheduler", {
    scalarKeys: SCALAR_KEYS,
    blockKeys: BLOCK_KEYS,
    coerce,
    keyPattern: HYPHEN_KEY_RE,
  })
  const fair = parsed.scalars.fair
  return {
    fair: typeof fair === "boolean" ? fair : DEFAULT_SCHEDULER_CONFIG.fair,
    weights: normalizeWeights(parsed.blocks.weights ?? {}, DEFAULT_WORK_WEIGHTS),
  }
}

export async function readSchedulerConfig(directory: string): Promise<SchedulerConfig> {
  try {
    const text = await readFile(join(directory, SYSCONFIG), "utf8")
    return parseSchedulerConfig(text)
  } catch {
    return { ...DEFAULT_SCHEDULER_CONFIG, weights: { ...DEFAULT_WORK_WEIGHTS } }
  }
}
