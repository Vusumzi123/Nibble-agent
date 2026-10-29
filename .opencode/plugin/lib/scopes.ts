// Pure permission-rule builders for the machine-portable permission scopes.
// These take ALREADY-RESOLVED absolute root dirs (see lib/paths.ts) so the
// logic is deterministic and unit-testable without file I/O.
//
// Vault scope  (rag-brain edits + markdown-vault MCP path + MCP write tools):
//               <vaultDir>   e.g. .../Nibble/Brain
//               Granted ONLY to the rag-brain sub-agent. The main agent and
//               every other sub-agent keep `edit: ask` on the vault — they
//               have no legitimate silent vault-write need, so a rogue write
//               stops at the prompt (least privilege). The MCP write tools are
//               vault-confined by the server (VAULT_PATH + SafePath), so their
//               allow cannot reach outside <vaultDir> either.
// Diagram scope (diagram-developer edits):
//               <diagramsDir> e.g. .../Nibble/diagrams
//               Granted ONLY to the diagram-developer sub-agent, whose sole
//               write surface is draw.io XML. Uses an `ask` fallback (NOT
//               deny): a catch-all deny disables the edit/write tools outright,
//               whereas ask + anchored allows keeps them enabled and still
//               stops any write outside the diagrams directory at the prompt.
// Log scope     (security-locks edits):
//               <logDir>     e.g. .../Nibble/.opencode/logs
//               The project-local NDJSON log root. security-locks keeps its
//               broad `deny` and gains anchored allows here only — the audit
//               trail itself is written in-process by audit-hook, never by an
//               agent hand-crafting lines.
//
// Allow rules are anchored to these EXACT paths. A bare `**/<name>/**` would
// auto-allow edits under ANY directory with that name anywhere on the machine,
// which is an unnecessary privilege grant. Each anchor is emitted in three
// forms because the permission engine is form-sensitive and does no
// normalization (anomalyco/opencode#53365):
//
//   absolute        /home/u/proj/Brain/**   — direct/absolute callers
//   slash-stripped  home/u/proj/Brain/**    — absolute-minus-leading-slash
//   worktree-rel.   Brain/**                — what tool/edit.ts passes:
//                                             path.relative(worktree, file)
//
// The worktree-relative form is the one native `edit` needs on 1.19.x. Without
// it an absolute anchor can never match the relative resource, so the `*`
// fallback wins — and in a headless subagent that is an `ask` that never
// resolves. Absolute/slash forms stay for callers that pass absolute paths.

import { isAbsolute, relative } from "node:path"

type PermissionMap = Record<string, "allow" | "ask" | "deny">

const toPosix = (p: string): string => p.replaceAll("\\", "/")

// Worktree-relative anchor for `dirAbs` (e.g. "Brain"), or null when it cannot
// be expressed relative to the worktree (outside it, or on another Windows
// drive). The engine compares resources verbatim, so this must reproduce
// exactly what tool/edit.ts builds: path.relative(worktree, filePath).
export function worktreeRelativeAnchor(
  worktreeAbs: string | undefined,
  dirAbs: string,
): string | null {
  if (!worktreeAbs || !isAbsolute(worktreeAbs) || !isAbsolute(dirAbs)) return null
  const rel = toPosix(relative(worktreeAbs, dirAbs))
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith("../")) return null
  return rel
}

// Append the anchored allow globs for `dirAbs` onto an existing rule map.
// Insertion order matters: the engine honors the LAST matching rule, so the
// caller's broad fallback (ask/deny) must already be first. Pass `worktreeAbs`
// to add the worktree-relative form the native `edit` tool needs.
export function appendAnchoredAllows(
  rules: PermissionMap,
  dirAbs: string,
  worktreeAbs?: string,
): PermissionMap {
  rules[`${dirAbs}/**`] = "allow"
  rules[`${dirAbs.replace(/^\/+/, "")}/**`] = "allow"
  const rel = worktreeRelativeAnchor(worktreeAbs, dirAbs)
  if (rel) rules[`${rel}/**`] = "allow"
  return rules
}

// Vault scope rule map: everything asks except the vault directory.
export function vaultEditRules(vaultDirAbs: string, worktreeAbs?: string): PermissionMap {
  return appendAnchoredAllows({ "*": "ask" }, vaultDirAbs, worktreeAbs)
}

// Log scope rule map: everything is denied except the project log directory.
export function logEditRules(logDirAbs: string, worktreeAbs?: string): PermissionMap {
  return appendAnchoredAllows({ "*": "deny" }, logDirAbs, worktreeAbs)
}

// Diagram scope rule map: everything asks except the diagrams directory. The
// `ask` fallback (not deny) is required to keep the edit/write tools enabled.
export function diagramEditRules(diagramsDirAbs: string, worktreeAbs?: string): PermissionMap {
  return appendAnchoredAllows({ "*": "ask" }, diagramsDirAbs, worktreeAbs)
}

// MCP tool groups that can MUTATE vault content, allowed silently for
// rag-brain alongside native edits. The markdown-vault server confines every
// path to VAULT_PATH via SafePath, so granting these cannot reach outside the
// vault. `markdown-vault_edit` is deliberately EXCLUDED: its AST operations
// re-serialize the file and escape every `[[wikilink]]` (see rag-brain.md).
export const VAULT_MCP_WRITE_TOOLS = [
  "markdown-vault_vault",
  "markdown-vault_system",
] as const

// Apply the vault scope: rag-brain edit allow + MCP VAULT_PATH + MCP write
// tools. The top-level `permission.edit` is deliberately left untouched — the
// main agent must stay on `ask` for vault writes.
export function applyVaultScope(cfg: any, vaultDirAbs: string, worktreeAbs?: string): void {
  if (!vaultDirAbs) return

  const ragBrain = cfg.agent?.["rag-brain"]
  if (ragBrain) {
    ragBrain.permission = ragBrain.permission ?? {}
    ragBrain.permission.edit = vaultEditRules(vaultDirAbs, worktreeAbs)
    for (const tool of VAULT_MCP_WRITE_TOOLS) ragBrain.permission[tool] = "allow"
  }

  const vaultMcp = cfg.mcp?.["markdown-vault"]
  if (vaultMcp) {
    vaultMcp.environment = vaultMcp.environment ?? {}
    vaultMcp.environment.VAULT_PATH = vaultDirAbs
  }
}

// Apply the log scope to deny-everything-else agents: keeps their existing
// broad `deny` first, then appends the anchored log-dir allows.
export function applyLogScope(cfg: any, logDirAbs: string, worktreeAbs?: string): void {
  if (!logDirAbs) return
  const logRules = logEditRules(logDirAbs, worktreeAbs)
  for (const name of ["security-locks"]) {
    const agent = cfg.agent?.[name]
    if (!agent) continue
    agent.permission = agent.permission ?? {}
    const existing = agent.permission.edit
    if (existing && typeof existing === "object") {
      // Preserve static broad deny (and any future keys); append anchored allows.
      for (const [k, v] of Object.entries(logRules)) {
        if (k !== "*") existing[k] = v
      }
    } else {
      agent.permission.edit = { ...logRules }
    }
  }
}

// Apply the diagram scope: diagram-developer edit allow inside <diagramsDir>.
export function applyDiagramScope(cfg: any, diagramsDirAbs: string, worktreeAbs?: string): void {
  if (!diagramsDirAbs) return
  const agent = cfg.agent?.["diagram-developer"]
  if (!agent) return
  agent.permission = agent.permission ?? {}
  agent.permission.edit = diagramEditRules(diagramsDirAbs, worktreeAbs)
}

// Apply all scopes from resolved absolute roots. `worktreeAbs` is the project's
// git worktree root (the base tool/edit.ts uses for its relative resource).
export function applyConfig(
  cfg: any,
  vaultDirAbs: string,
  logDirAbs: string,
  diagramsDirAbs: string,
  worktreeAbs?: string,
): void {
  applyVaultScope(cfg, vaultDirAbs, worktreeAbs)
  applyLogScope(cfg, logDirAbs, worktreeAbs)
  applyDiagramScope(cfg, diagramsDirAbs, worktreeAbs)
}
