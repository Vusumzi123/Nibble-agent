// Agent-forbidden, user-write-only vault folders. Single source of truth shared
// by vault-readonly-guard.ts (blocks agent tool writes before they touch bytes)
// and wikilink-guard.ts (skips these folders in its snapshot + idle sweeps).
//
// Values come from the `vault:` section of sysop-config.yaml. The default keeps
// `Journal/` user-write-only even when the config is missing or broken, so the
// diary is protected out of the box.
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.
import { basename, isAbsolute, relative } from "node:path"
import { readSection } from "./config.ts"

export type VaultPolicy = { readonly: string }

export const DEFAULT_VAULT_POLICY: VaultPolicy = { readonly: "Journal" }

// Read the effective `vault:` policy (never throws; defaults on error).
export async function readVaultPolicy(directory: string): Promise<VaultPolicy> {
  return readSection(directory, "vault", DEFAULT_VAULT_POLICY)
}

// Split the comma-separated `readonly` value into normalized, vault-relative
// top-level directory names (no leading/trailing slashes, no empties).
export function parseReadonlyDirs(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim().replace(/^[/\\]+|[/\\]+$/g, ""))
    .filter(Boolean)
}

// True when `p` (absolute, or vault-relative with or without the vault root's
// own basename) lives inside one of the user-write-only `dirs`.
export function isReadonlyVaultPath(vaultRoot: string, p: string, dirs: string[]): boolean {
  if (!p || dirs.length === 0) return false
  let rel = (isAbsolute(p) ? relative(vaultRoot, p) : p).replace(/\\/g, "/")
  rel = rel.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "")
  const root = basename(vaultRoot)
  if (root && rel !== root && rel.startsWith(root + "/")) rel = rel.slice(root.length + 1)
  if (!rel || rel === ".." || rel.startsWith("../")) return false
  return dirs.some((d) => rel === d || rel.startsWith(d + "/"))
}
