// CompositeProvider (`both`): Brain read+write plus the un-consolidated read
// lane (docs/knowledge-memory-modularization.md §4).
//
// This is an internal composition of the two built-ins, not a multi-provider
// framework: one writer (Brain), one read-plan concatenation, one agent union.
//
// Loaded via relative import only.
import type {
  MemoryProfile,
  MemoryProvider,
  MemoryReadRequest,
  MemoryToolFactory,
} from "../../types.ts"

export function createCompositeProvider(
  brain: MemoryProvider,
  explorer: MemoryProvider,
  lane: string,
): MemoryProvider {
  const id: MemoryProfile = "both"

  return {
    id,
    capabilities: {
      read: brain.capabilities.read || explorer.capabilities.read,
      write: brain.capabilities.write,
      searchTool: brain.capabilities.searchTool || explorer.capabilities.searchTool,
    },
    agents: [...new Set([...brain.agents, ...explorer.agents])],

    readPlan(req?: MemoryReadRequest): string | null {
      const plans = [brain.readPlan(req), lane].filter(
        (plan): plan is string => typeof plan === "string" && plan.length > 0,
      )
      return plans.length > 0 ? plans.join("\n") : null
    },

    search: explorer.search?.bind(explorer),
    consolidate: brain.consolidate?.bind(brain),
    pending: brain.pending?.bind(brain),
    tools: explorer.tools
      ? (factory: MemoryToolFactory) => explorer.tools!(factory)
      : undefined,
    seed: explorer.seed?.bind(explorer),

    async health(): Promise<{ ok: boolean; detail?: string }> {
      const [b, e] = await Promise.all([brain.health(), explorer.health()])
      const ok = b.ok && e.ok
      const detail = [b.detail, e.detail].filter(Boolean).join("; ") || undefined
      return { ok, detail }
    },
  }
}
