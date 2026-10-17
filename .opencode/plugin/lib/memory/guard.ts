// Dynamic memory guard (docs/knowledge-memory-modularization.md §7.4).
//
// Static opencode permissions cannot express "the active provider owns these
// agents". This pure predicate runs at `tool.execute.before` so manual `task`
// delegation and direct `memory_search` calls obey the active provider — the
// enforcement behind "a new integration requires ours to be off first".
//
// Loaded via relative import only.
import type { MemoryProvider } from "./types.ts"
import { BUILTIN_MEMORY_AGENTS } from "./registry.ts"

export function memoryToolBlocked(
  provider: MemoryProvider,
  tool: string,
  args: Record<string, unknown> = {},
): string | null {
  const owned = new Set(provider.agents)

  if (tool === "task") {
    const agent = args.subagent_type ?? args.agent ?? args.subagentType
    if (typeof agent !== "string" || !agent) return null
    if (!BUILTIN_MEMORY_AGENTS.includes(agent)) return null
    if (owned.has(agent)) return null
    if (provider.id === "none") return "memory is disabled in config (memory.provider: none)"
    return `"${agent}" belongs to the disabled built-in memory provider (active: ${provider.id})`
  }

  if (tool === "memory_search") {
    if (provider.capabilities.searchTool && provider.tools) return null
    if (provider.id === "none") return "memory is disabled in config (memory.provider: none)"
    return `memory_search is not exposed by the active memory provider (${provider.id})`
  }

  return null
}
