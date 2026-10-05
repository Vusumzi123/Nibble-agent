import type { Plugin } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { createDiagnostics } from "./lib/logging.ts"
import { readResolvedPaths } from "./lib/paths.ts"
import { extractWritePaths, vaultLabel } from "./lib/write-guard.ts"
import { isReadonlyVaultPath, parseReadonlyDirs, readVaultPolicy } from "./lib/vault-policy.ts"

// Deterministic guard for the user-write-only vault folders (`vault.readonly` in
// sysop-config.yaml, default `Journal/`). The user owns those folders and edits
// them in Obsidian; the agent may READ them but must never create, update, or
// delete inside them.
//
// This runs at tool.execute.before, so it blocks every agent write path BEFORE
// any bytes are touched — native edit/write/apply_patch and the markdown-vault
// MCP vault tool (create/update/delete/create_from_template). Throwing aborts
// the tool and returns the reason to the calling agent. No config section is
// required; the default protects `Journal/`.
export default (async ({ directory }) => {
  const dir = directory ?? process.cwd()
  const resolved = await readResolvedPaths(dir, homedir())
  const vaultRoot = resolved.vaultDir
  const policy = await readVaultPolicy(dir)
  const readonlyDirs = parseReadonlyDirs(policy.readonly)
  const diag = createDiagnostics({ logDir: resolved.logDir, home: homedir(), channel: "vault-readonly-guard" })

  return {
    "tool.execute.before": async (input, output) => {
      if (readonlyDirs.length === 0) return
      const args = ((output as any)?.args ?? {}) as Record<string, unknown>
      for (const p of extractWritePaths(input.tool, args, vaultRoot)) {
        if (!isReadonlyVaultPath(vaultRoot, p, readonlyDirs)) continue
        const label = vaultLabel(vaultRoot, p)
        void diag.error(
          `[vault-readonly-guard] blocked agent write to user-write-only "${label}" (tool=${input.tool})`,
        )
        throw new Error(
          `"${label}" is user-write-only and the agent may not write there ` +
            `(see Brain/meta/contract.md). Reads are allowed; ask the user to make the change in Obsidian.`,
        )
      }
    },
  }
}) satisfies Plugin
