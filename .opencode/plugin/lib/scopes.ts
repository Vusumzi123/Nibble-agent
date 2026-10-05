// Pure permission-rule builders for the machine-portable permission scopes.
// These take ALREADY-RESOLVED absolute root dirs (see lib/paths.ts) so the
// logic is deterministic and unit-testable without file I/O.
//
// Vault scope  (rag-brain edits + markdown-vault MCP path):
//               <vaultDir>   e.g. .../sysop-brain/Brain
//               Granted ONLY to the rag-brain sub-agent. The main agent and
//               every other sub-agent keep `edit: ask` on the vault — they
//               have no legitimate silent vault-write need, so a rogue write
//               stops at the prompt (least privilege).
// Diagram scope (diagram-developer edits):
//               <diagramsDir> e.g. .../sysop-brain/diagrams
//               Granted ONLY to the diagram-developer sub-agent, whose sole
//               write surface is draw.io XML. Uses an `ask` fallback (NOT
//               deny): a catch-all deny disables the edit/write tools outright,
//               whereas ask + anchored allows keeps them enabled and still
//               stops any write outside the diagrams directory at the prompt.
// Home scope   (security-locks + audit-logger edits):
//               <sysopDir>   e.g. ~/.opencode-sysop
//
// Allow rules are anchored to these EXACT paths. A bare `**/<name>/**` would
// auto-allow edits under ANY directory with that name anywhere on the machine,
// which is an unnecessary privilege grant. The permission engine matches paths
// in absolute-minus-leading-slash form, so each anchor is emitted in both the
// absolute and the slash-stripped form.

type PermissionMap = Record<string, "allow" | "ask" | "deny">

// Append the two anchored allow globs for `dirAbs` onto an existing rule map.
// Insertion order matters: the engine honors the LAST matching rule, so the
// caller's broad fallback (ask/deny) must already be first.
export function appendAnchoredAllows(rules: PermissionMap, dirAbs: string): PermissionMap {
  rules[`${dirAbs}/**`] = "allow"
  rules[`${dirAbs.replace(/^\/+/, "")}/**`] = "allow"
  return rules
}

// Vault scope rule map: everything asks except the vault directory.
export function vaultEditRules(vaultDirAbs: string): PermissionMap {
  return appendAnchoredAllows({ "*": "ask" }, vaultDirAbs)
}

// Home scope rule map: everything is denied except the sysop directory.
export function sysopEditRules(sysopDirAbs: string): PermissionMap {
  return appendAnchoredAllows({ "*": "deny" }, sysopDirAbs)
}

// Diagram scope rule map: everything asks except the diagrams directory. The
// `ask` fallback (not deny) is required to keep the edit/write tools enabled.
export function diagramEditRules(diagramsDirAbs: string): PermissionMap {
  return appendAnchoredAllows({ "*": "ask" }, diagramsDirAbs)
}

// Apply the vault scope: rag-brain edit allow + MCP VAULT_PATH. The top-level
// `permission.edit` is deliberately left untouched — the main agent must stay
// on `ask` for vault writes.
export function applyVaultScope(cfg: any, vaultDirAbs: string): void {
  if (!vaultDirAbs) return

  const ragBrain = cfg.agent?.["rag-brain"]
  if (ragBrain) {
    ragBrain.permission = ragBrain.permission ?? {}
    ragBrain.permission.edit = vaultEditRules(vaultDirAbs)
  }

  const vaultMcp = cfg.mcp?.["markdown-vault"]
  if (vaultMcp) {
    vaultMcp.environment = vaultMcp.environment ?? {}
    vaultMcp.environment.VAULT_PATH = vaultDirAbs
  }
}

// Apply the home scope to deny-everything-else agents: keeps their existing
// broad `deny` first, then appends the anchored sysop allows.
export function applyHomeScope(cfg: any, sysopDirAbs: string): void {
  if (!sysopDirAbs) return
  const sysopRules = sysopEditRules(sysopDirAbs)
  for (const name of ["security-locks", "audit-logger"]) {
    const agent = cfg.agent?.[name]
    if (!agent) continue
    agent.permission = agent.permission ?? {}
    const existing = agent.permission.edit
    if (existing && typeof existing === "object") {
      // Preserve static broad deny (and any future keys); append anchored allows.
      for (const [k, v] of Object.entries(sysopRules)) {
        if (k !== "*") existing[k] = v
      }
    } else {
      agent.permission.edit = { ...sysopRules }
    }
  }
}

// Apply the diagram scope: diagram-developer edit allow inside <diagramsDir>.
export function applyDiagramScope(cfg: any, diagramsDirAbs: string): void {
  if (!diagramsDirAbs) return
  const agent = cfg.agent?.["diagram-developer"]
  if (!agent) return
  agent.permission = agent.permission ?? {}
  agent.permission.edit = diagramEditRules(diagramsDirAbs)
}

// Apply all scopes from resolved absolute roots.
export function applyConfig(
  cfg: any,
  vaultDirAbs: string,
  sysopDirAbs: string,
  diagramsDirAbs: string,
): void {
  applyVaultScope(cfg, vaultDirAbs)
  applyHomeScope(cfg, sysopDirAbs)
  applyDiagramScope(cfg, diagramsDirAbs)
}
