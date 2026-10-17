// `memory:` configuration (docs/knowledge-memory-modularization.md §3).
//
// One active provider. Invalid/unknown values fail closed to `none` and warn
// once per project directory — never silently enable a memory lane.
//
// Loaded via relative import only.
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { SYSCONFIG } from "../config.ts"
import type { MemoryProfile } from "./types.ts"

export type MemoryConfig = {
  provider: MemoryProfile
  /** Set when the configured value was unrecognized (provider became none). */
  invalid?: string
}

export const MEMORY_PROFILES: readonly MemoryProfile[] = [
  "both",
  "rag-brain",
  "memory-explorer",
  "none",
]

export const DEFAULT_MEMORY: MemoryConfig = { provider: "both" }

const PROVIDER_LINE_RE = /^[ \t]*provider[ \t]*:[ \t]*(.*?)[ \t]*$/m
const MEMORY_BLOCK_RE = /^memory[ \t]*:[^\n]*\n((?:[ \t]+[^\n]*(?:\n|$))*)/m

function stripComment(raw: string): string {
  return raw.replace(/\s+#.*$/, "").trim()
}

function unquote(raw: string): string {
  return raw.replace(/^["']|["']$/g, "").trim()
}

/** Parse the `memory:` block. Never throws. */
export function parseMemoryConfig(yamlText: string): MemoryConfig {
  const block = MEMORY_BLOCK_RE.exec(yamlText)?.[1]
  if (!block) return { ...DEFAULT_MEMORY }

  const line = PROVIDER_LINE_RE.exec(block)?.[1]
  if (line === undefined) return { ...DEFAULT_MEMORY }

  const raw = unquote(stripComment(line))
  if (!raw) return { ...DEFAULT_MEMORY }
  if ((MEMORY_PROFILES as readonly string[]).includes(raw)) {
    return { provider: raw as MemoryProfile }
  }
  return {
    provider: "none",
    invalid: `unknown memory.provider "${raw}" — memory disabled (expected: ${MEMORY_PROFILES.join(", ")})`,
  }
}

const warned = new Set<string>()

/** Read the effective memory config. Missing/malformed → defaults. */
export async function readMemoryConfig(
  directory: string,
  onWarn?: (message: string) => void,
): Promise<MemoryConfig> {
  let raw = ""
  try {
    raw = await readFile(join(directory, SYSCONFIG), "utf8")
  } catch {
    return { ...DEFAULT_MEMORY }
  }
  const cfg = parseMemoryConfig(raw)
  if (cfg.invalid && onWarn && !warned.has(directory)) {
    warned.add(directory)
    onWarn(cfg.invalid)
  }
  return cfg
}

/** Test seam: forget warn-once state. */
export function resetMemoryWarnings(): void {
  warned.clear()
}
