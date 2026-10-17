import type { Plugin } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { readDrainConfig } from "./lib/drain/config.ts"
import { createDiagnostics } from "./lib/logging.ts"
import { readMemoryConfig } from "./lib/memory/config.ts"
import { memoryToolBlocked } from "./lib/memory/guard.ts"
import { resolveProvider } from "./lib/memory/registry.ts"
import { readResolvedPaths } from "./lib/paths.ts"

// Dynamic memory guard (docs/knowledge-memory-modularization.md §7).
//
// Static opencode permissions cannot express the active provider. This hook
// blocks manual `task` delegation to a memory agent the provider does not own,
// and direct `memory_search` calls when the provider does not expose it. With
// `memory.provider: none`, every built-in memory agent is blocked — which is
// what makes "a new integration requires ours to be off first" enforceable.
//
// Config is hot-read per call (no restart needed for the guard).
export default (async ({ directory }) => {
  const dir = directory ?? process.cwd()
  const resolved = await readResolvedPaths(dir, homedir())
  const diag = createDiagnostics({ logDir: resolved.logDir, home: homedir(), channel: "memory-guard" })

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task" && input.tool !== "memory_search") return

      const memoryCfg = await readMemoryConfig(dir, (message) => {
        void diag.warn(`[memory-guard] ${message}`)
      })
      const provider = resolveProvider(memoryCfg.provider, {
        directory: dir,
        stateDir: resolved.stateDir,
        vaultDir: resolved.vaultDir,
        drain: await readDrainConfig(dir),
      })

      const args = (((input as any)?.args ?? (output as any)?.args) ?? {}) as Record<string, unknown>
      const reason = memoryToolBlocked(provider, input.tool, args)
      if (!reason) return

      void diag.error(`[memory-guard] blocked ${input.tool} (provider=${provider.id}): ${reason}`)
      throw new Error(reason)
    },
  }
}) satisfies Plugin
