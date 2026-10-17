import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { readDrainConfig } from "./lib/drain/config.ts"
import { createDiagnostics } from "./lib/logging.ts"
import { readMemoryConfig } from "./lib/memory/config.ts"
import { resolveProvider } from "./lib/memory/registry.ts"
import { readResolvedPaths } from "./lib/paths.ts"

// Generic memory-tool registrar (docs/knowledge-memory-modularization.md §6).
//
// The active provider decides which tools exist. Today the un-consolidated lane
// contributes `memory_search`; a Brain-only or `none` profile registers
// nothing, and the dynamic guard (memory-guard.ts) blocks manual calls.
//
// The plugin API (including `tool`) is supplied by opencode at runtime; this
// file is not imported by the unit suite.
export default (async ({ directory }) => {
  const projectDir = directory ?? process.cwd()
  const { logDir, stateDir, vaultDir } = await readResolvedPaths(projectDir, homedir())
  const diag = createDiagnostics({ logDir, home: homedir(), channel: "memory-hook" })

  const memoryCfg = await readMemoryConfig(projectDir, (message) => {
    void diag.warn(`[memory-hook] ${message}`)
  })
  const provider = resolveProvider(memoryCfg.provider, {
    directory: projectDir,
    stateDir,
    vaultDir,
    drain: await readDrainConfig(projectDir),
    onWarn: (message, err) => void diag.warn(`[memory-hook] ${message}`, err),
  })

  return { tool: (provider.tools?.(tool) ?? {}) as Record<string, any> }
}) satisfies Plugin
