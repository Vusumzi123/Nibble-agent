// Canonical path roots read from the top-level `paths:` block of
// sysop-config.yaml — the single source of truth for where the vault and the
// sysop working dir live. Every plugin/hook that needs an anchored path reads
// it here; no consumer hardcodes "Brain" or ".opencode-sysop".
//
// Root semantics:
//   vault    — repo/project-scoped, resolved against the project directory.
//   sysop    — home-scoped, resolved against the user's home (~ is expanded).
//   diagrams — repo/project-scoped, resolved against the project directory
//              (the diagram-developer agent's write scope).
//   state    — repo/project-scoped, resolved against the project directory
//              (project-local transient state: knowledge memory buffer, tag
//              index; seed of the future global→project state migration).
//
// Per-section leaves (knowledge.memory_file → state; audit.log → sysop) are
// joined onto these roots by the section readers.
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import {
  HYPHEN_KEY_RE,
  SYSCONFIG,
  parseFlatBlock,
  readSection,
  sectionCoercer,
} from "./config.ts"

export { SYSCONFIG }

export type PathsConfig = {
  vault: string
  sysop: string
  diagrams: string
  state: string
}

export const DEFAULT_PATHS: PathsConfig = {
  vault: "Brain",
  sysop: "~/.opencode-sysop",
  diagrams: "diagrams",
  state: ".opencode/state",
}

const KNOWN_KEYS = new Set(Object.keys(DEFAULT_PATHS))

// `paths:` keys allow hyphens (unlike the other sections) and every value is a
// raw string; an empty value is ignored.
const PATHS_COERCE = sectionCoercer({ stringMode: "raw" })

// Parse the `paths:` block (flat `key: value` scalars only). Unrecognized
// keys are ignored. Dependency-free and deterministic.
export function parsePathsConfig(yamlText: string): Partial<PathsConfig> {
  return parseFlatBlock(yamlText, "paths", {
    knownKeys: KNOWN_KEYS,
    keyPattern: HYPHEN_KEY_RE,
    coerce: PATHS_COERCE,
  }) as Partial<PathsConfig>
}

// Expand a leading `~` (bare "~" or "~/...") against `home`.
export function expandHome(p: string, home: string): string {
  if (p === "~") return home
  if (p.startsWith("~/")) return join(home, p.slice(2))
  return p
}

// Resolve the vault root to an absolute path. The config value is typically a
// bare directory name ("Brain") resolved against the project `directory`.
export function resolveVaultDir(directory: string, vault: string): string {
  return isAbsolute(vault) ? vault : join(directory, vault)
}

// Resolve the diagrams root to an absolute path. Project-scoped like the
// vault: a bare directory name ("diagrams") resolves against the project dir.
export function resolveDiagramsDir(directory: string, diagrams: string): string {
  return isAbsolute(diagrams) ? diagrams : join(directory, diagrams)
}

// Resolve the project-local state root to an absolute path. Project-scoped:
// the default ".opencode/state" resolves against the project directory.
export function resolveStateDir(directory: string, state: string): string {
  return isAbsolute(state) ? state : join(directory, state)
}

// Resolve the sysop root to an absolute path. The config value is typically
// "~/.opencode-sysop"; a non-absolute, non-~ value is treated as home-scoped.
export function resolveSysopDir(home: string, sysop: string): string {
  const expanded = expandHome(sysop, home)
  return isAbsolute(expanded) ? expanded : join(home, expanded)
}

// Read the effective `paths:` config for a project directory, overlaying the
// block (if present) on the defaults. Never throws: missing/broken config
// yields the defaults.
export async function readPathsConfig(directory: string, home: string = homedir()): Promise<PathsConfig> {
  void home // signature kept for callers; the section reader resolves leaves
  return readSection(directory, "paths", DEFAULT_PATHS, {
    keyPattern: HYPHEN_KEY_RE,
    coerce: PATHS_COERCE,
  })
}

// Resolved absolute roots for a project (convenience wrapper).
export type ResolvedPaths = {
  vaultDir: string
  sysopDir: string
  diagramsDir: string
  stateDir: string
  config: PathsConfig
}

export async function readResolvedPaths(directory: string, home: string = homedir()): Promise<ResolvedPaths> {
  const config = await readPathsConfig(directory, home)
  return {
    vaultDir: resolveVaultDir(directory, config.vault),
    sysopDir: resolveSysopDir(home, config.sysop),
    diagramsDir: resolveDiagramsDir(directory, config.diagrams),
    stateDir: resolveStateDir(directory, config.state),
    config,
  }
}
