import type { Plugin } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { createDiagnostics } from "./lib/logging.ts"
import { readResolvedPaths } from "./lib/paths.ts"
import { applyConfig, worktreeRelativeAnchor } from "./lib/scopes.ts"

// Single source of truth for the path-based auto-allow scopes whose real
// absolute locations are machine-dependent (repo location, home dir). All
// machine-dependent path values are read from the `paths:` block of
// `.opencode/sysop-config.yaml` at startup and DERIVED here through the
// plugin `config` hook below — never hand-typed into opencode.json:
//
//   vault root  (rag-brain edits + markdown-vault MCP VAULT_PATH):
//               <project-dir>/<paths.vault>
//   log root    (security-locks edit allows):
//               <project-dir>/<paths.log>
//   diagrams root (diagram-developer edit allows):
//               <project-dir>/<paths.diagrams>
//
// The plugin auto-discovery loader requires every export of this file to be a
// plugin factory, so this file deliberately exports ONLY the default plugin —
// the pure rule helpers live in lib/scopes.ts (never loaded as a plugin).
export default (async ({ directory, worktree }) => {
  // Resolve the canonical roots once at startup. Never throws (defaults on a
  // missing/broken config), so a config error cannot take the MCP server down.
  const root = directory ?? process.cwd()
  const resolved = await readResolvedPaths(root, homedir())
  const diag = createDiagnostics({ logDir: resolved.logDir, home: homedir(), channel: "scoped-permissions" })
  // tool/edit.ts hands the permission engine `path.relative(worktree, file)`,
  // so the anchored allows must include worktree-relative keys. `worktree` is
  // always present on PluginInput; directory is the fallback for old hosts.
  const worktreeDir = worktree ?? root
  if (!worktreeRelativeAnchor(worktreeDir, resolved.vaultDir)) {
    void diag.warn(
      `[scoped-permissions] vault ${resolved.vaultDir} is not under worktree ${worktreeDir}; ` +
        "only the absolute edit anchors apply (headless writes will prompt)",
    )
  }

  return {
    config: (cfg: any) => {
      try {
        applyConfig(cfg, resolved.vaultDir, resolved.logDir, resolved.diagramsDir, worktreeDir)
      } catch (err) {
        void diag.error("[scoped-permissions] failed to inject permission config:", err)
      }
    },
  }
}) satisfies Plugin
