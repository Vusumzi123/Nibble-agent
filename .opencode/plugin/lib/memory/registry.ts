// Profile → provider registry (docs/knowledge-memory-modularization.md §4/§5).
//
// One active provider. `none` is a real provider: it exposes no plan, no
// writer, no tools, and no agents, so every consumer degrades deterministically.
//
// Loaded via relative import only.
import { DEFAULT_DRAIN, type DrainConfig } from "../drain/config.ts"
import { DEFAULT_MEMORY } from "./config.ts"
import type { MemoryProfile, MemoryProvider, MemoryReadRequest } from "./types.ts"
import { BRAIN_AGENTS, createBrainProvider } from "./providers/builtin/brain.ts"
import { EXPLORER_AGENTS, EXPLORER_LANE, createExplorerProvider } from "./providers/builtin/explorer.ts"
import { createCompositeProvider } from "./providers/builtin/index.ts"

export type MemoryProviderDeps = {
  directory: string
  stateDir: string
  vaultDir: string
  /** Defaults to DEFAULT_DRAIN for read-only consumers (retrieval hook). */
  drain?: DrainConfig
  summaryWords?: number
  dbFile?: string
  onWarn?: (message: string, err?: unknown) => void
}

/** Every agent any built-in memory provider can own (guard + static test). */
export const BUILTIN_MEMORY_AGENTS: readonly string[] = [
  ...new Set([...BRAIN_AGENTS, ...EXPLORER_AGENTS]),
]

/** The complete-disable provider. */
export function createNoneProvider(): MemoryProvider {
  return {
    id: "none",
    capabilities: { read: false, write: false, searchTool: false },
    agents: [],
    readPlan(_req?: MemoryReadRequest): string | null {
      return null
    },
    async health(): Promise<{ ok: boolean; detail?: string }> {
      return { ok: true }
    },
  }
}

export function resolveProvider(
  profile: MemoryProfile = DEFAULT_MEMORY.provider,
  deps: MemoryProviderDeps,
): MemoryProvider {
  const drain = deps.drain ?? DEFAULT_DRAIN
  const summaryWords = deps.summaryWords ?? 400
  const shared = {
    directory: deps.directory,
    stateDir: deps.stateDir,
    vaultDir: deps.vaultDir,
    drain,
    dbFile: deps.dbFile,
    onWarn: deps.onWarn,
  }

  switch (profile) {
    case "rag-brain":
      return createBrainProvider({ ...shared, summaryWords })
    case "memory-explorer":
      return createExplorerProvider(shared)
    case "both":
      return createCompositeProvider(
        createBrainProvider({ ...shared, summaryWords }),
        createExplorerProvider(shared),
        EXPLORER_LANE,
      )
    case "none":
      return createNoneProvider()
    default:
      return createNoneProvider()
  }
}
