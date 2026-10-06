import { test } from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"
import {
  applyConfig,
  applyVaultScope,
  applyLogScope,
  applyDiagramScope,
  vaultEditRules,
  logEditRules,
  diagramEditRules,
  appendAnchoredAllows,
} from "./scopes.ts"
import {
  DEFAULT_PATHS,
  expandHome,
  parsePathsConfig,
  resolveVaultDir,
  resolveLogDir,
  resolveDiagramsDir,
} from "./paths.ts"

const DIR = "/home/x/project"
const HOME = "/home/x"

const vaultDir = () => resolveVaultDir(DIR, DEFAULT_PATHS.vault)
const logDir = () => resolveLogDir(DIR, DEFAULT_PATHS.log)
const diagramsDir = () => resolveDiagramsDir(DIR, DEFAULT_PATHS.diagrams)
const strip = (p: string) => p.replace(/^\/+/, "")

test("paths: defaults resolve vault/log/diagrams under project", () => {
  assert.equal(DEFAULT_PATHS.vault, "Brain")
  assert.equal(DEFAULT_PATHS.log, ".opencode/logs")
  assert.equal(DEFAULT_PATHS.diagrams, "diagrams")
  assert.equal(vaultDir(), join(DIR, "Brain"))
  assert.equal(logDir(), join(DIR, ".opencode/logs"))
  assert.equal(diagramsDir(), join(DIR, "diagrams"))
})

test("paths: parsePathsConfig reads flat keys and ignores unknown/comments", () => {
  const yaml = [
    "paths:",
    "  vault: Notes", // comment stripped
    "  log: /var/log/x",
    "  other: x",
  ].join("\n")
  const cfg = parsePathsConfig(yaml)
  assert.deepEqual(cfg, { vault: "Notes", log: "/var/log/x" })
  assert.deepEqual(parsePathsConfig("other:\n  file: /x\n"), {})
})

test("paths: expandHome handles bare ~ and ~/ forms", () => {
  assert.equal(expandHome("~", HOME), HOME)
  assert.equal(expandHome("~/a/b", HOME), join(HOME, "a/b"))
  assert.equal(expandHome("/abs", HOME), "/abs")
  assert.equal(expandHome("rel", HOME), "rel")
})

test("vault rules: ask fallback + only anchored allows (no **/Brain/**)", () => {
  const rules = vaultEditRules(vaultDir())
  assert.equal(rules["*"], "ask")
  assert.equal(rules[`${vaultDir()}/**`], "allow")
  assert.equal(rules[`${strip(vaultDir())}/**`], "allow")
  assert.equal(Object.keys(rules).length, 3)
  assert.equal(rules["**/Brain/**"], undefined)
})

test("log rules: deny fallback + only anchored allows (no **/.opencode/logs/**)", () => {
  const rules = logEditRules(logDir())
  assert.equal(rules["*"], "deny")
  assert.equal(rules[`${logDir()}/**`], "allow")
  assert.equal(rules[`${strip(logDir())}/**`], "allow")
  assert.equal(Object.keys(rules).length, 3)
  assert.equal(rules["**/.opencode/logs/**"], undefined)
})

test("applyVaultScope leaves the top-level edit alone; allows only rag-brain vault edits + MCP VAULT_PATH", () => {
  const cfg: any = {
    permission: { edit: { "*": "ask" } },
    agent: { "rag-brain": { permission: { "markdown-vault_edit": "deny" } } },
    mcp: { "markdown-vault": { environment: {} } },
  }
  applyVaultScope(cfg, vaultDir())
  assert.deepEqual(cfg.permission.edit, { "*": "ask" }, "main agent keeps ask-only")
  assert.equal(cfg.permission.edit[`**/${DEFAULT_PATHS.vault}/**`], undefined)
  assert.equal(cfg.agent["rag-brain"].permission["markdown-vault_edit"], "deny")
  assert.equal(cfg.agent["rag-brain"].permission.edit["*"], "ask")
  assert.equal(cfg.agent["rag-brain"].permission.edit[`${vaultDir()}/**`], "allow")
  assert.equal(cfg.agent["rag-brain"].permission.edit[`${strip(vaultDir())}/**`], "allow")
  assert.equal(cfg.mcp["markdown-vault"].environment.VAULT_PATH, vaultDir())
})

test("applyLogScope appends anchored allows to security-locks, preserving deny", () => {
  const cfg: any = {
    agent: {
      "security-locks": { permission: { edit: { "*": "deny" } } },
      "rag-brain": { permission: {} },
    },
  }
  applyLogScope(cfg, logDir())
  const edit = cfg.agent["security-locks"].permission.edit
  assert.equal(edit["*"], "deny")
  assert.equal(edit[`${logDir()}/**`], "allow")
  assert.equal(edit[`${strip(logDir())}/**`], "allow")
  assert.equal(cfg.agent["rag-brain"].permission.edit, undefined, "other agents untouched")
})

test("diagram rules: ask fallback + only anchored allows (no **/diagrams/**)", () => {
  const rules = diagramEditRules(diagramsDir())
  assert.equal(rules["*"], "ask")
  assert.equal(rules[`${diagramsDir()}/**`], "allow")
  assert.equal(rules[`${strip(diagramsDir())}/**`], "allow")
  assert.equal(Object.keys(rules).length, 3)
  assert.equal(rules["**/diagrams/**"], undefined)
})

test("applyDiagramScope grants only diagram-developer anchored diagram edits", () => {
  const cfg: any = {
    agent: {
      "diagram-developer": { permission: { edit: { "*": "ask" } } },
      "web-developer": { permission: { edit: { "*": "ask" } } },
    },
  }
  applyDiagramScope(cfg, diagramsDir())
  const edit = cfg.agent["diagram-developer"].permission.edit
  assert.equal(edit["*"], "ask")
  assert.equal(edit[`${diagramsDir()}/**`], "allow")
  assert.equal(edit[`${strip(diagramsDir())}/**`], "allow")
  assert.deepEqual(cfg.agent["web-developer"].permission.edit, { "*": "ask" }, "other agents untouched")
})

test("applyConfig wires all three scopes from resolved roots", () => {
  const cfg: any = {
    permission: {},
    agent: {
      "security-locks": { permission: { edit: { "*": "deny" } } },
      "rag-brain": { permission: {} },
      "diagram-developer": { permission: { edit: { "*": "ask" } } },
    },
    mcp: { "markdown-vault": { environment: {} } },
  }
  applyConfig(cfg, vaultDir(), logDir(), diagramsDir())
  assert.equal(cfg.permission.edit, undefined, "no vault allow injected at top level")
  assert.equal(cfg.agent["rag-brain"].permission.edit[`${strip(vaultDir())}/**`], "allow")
  assert.equal(cfg.mcp["markdown-vault"].environment.VAULT_PATH, vaultDir())
  assert.equal(cfg.agent["security-locks"].permission.edit[`${strip(logDir())}/**`], "allow")
  assert.equal(cfg.agent["diagram-developer"].permission.edit[`${strip(diagramsDir())}/**`], "allow")
})

test("appendAnchoredAllows emits both absolute and slash-stripped forms", () => {
  const rules = appendAnchoredAllows({ "*": "ask" }, "/etc/foo")
  assert.equal(rules["/etc/foo/**"], "allow")
  assert.equal(rules["etc/foo/**"], "allow")
})

test("no-ops safely without a directory/home", () => {
  const cfg: any = { mcp: {}, agent: {} }
  applyVaultScope(cfg, "")
  applyLogScope(cfg, "")
  applyDiagramScope(cfg, "")
  assert.deepEqual(cfg, { mcp: {}, agent: {} })
})
