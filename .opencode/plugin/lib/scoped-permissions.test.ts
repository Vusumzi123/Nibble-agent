import { test } from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"
import {
  applyConfig,
  applyVaultScope,
  applyHomeScope,
  applyDiagramScope,
  vaultEditRules,
  sysopEditRules,
  diagramEditRules,
  appendAnchoredAllows,
} from "./scopes.ts"
import {
  DEFAULT_PATHS,
  expandHome,
  parsePathsConfig,
  resolveVaultDir,
  resolveSysopDir,
  resolveDiagramsDir,
} from "./paths.ts"

const DIR = "/home/x/project"
const HOME = "/home/x"

const vaultDir = () => resolveVaultDir(DIR, DEFAULT_PATHS.vault)
const sysopDir = () => resolveSysopDir(HOME, DEFAULT_PATHS.sysop)
const diagramsDir = () => resolveDiagramsDir(DIR, DEFAULT_PATHS.diagrams)
const strip = (p: string) => p.replace(/^\/+/, "")

test("paths: defaults resolve vault/diagrams under project and sysop under home", () => {
  assert.equal(DEFAULT_PATHS.vault, "Brain")
  assert.equal(DEFAULT_PATHS.sysop, "~/.opencode-sysop")
  assert.equal(DEFAULT_PATHS.diagrams, "diagrams")
  assert.equal(vaultDir(), join(DIR, "Brain"))
  assert.equal(sysopDir(), join(HOME, ".opencode-sysop"))
  assert.equal(diagramsDir(), join(DIR, "diagrams"))
})

test("paths: parsePathsConfig reads flat keys and ignores unknown/comments", () => {
  const yaml = [
    "paths:",
    "  vault: Notes", // comment stripped
    "  sysop: ~/.sysop",
    "  other: x",
  ].join("\n")
  const cfg = parsePathsConfig(yaml)
  assert.deepEqual(cfg, { vault: "Notes", sysop: "~/.sysop" })
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

test("sysop rules: deny fallback + only anchored allows (no **/.opencode-sysop/**)", () => {
  const rules = sysopEditRules(sysopDir())
  assert.equal(rules["*"], "deny")
  assert.equal(rules[`${sysopDir()}/**`], "allow")
  assert.equal(rules[`${strip(sysopDir())}/**`], "allow")
  assert.equal(Object.keys(rules).length, 3)
  assert.equal(rules["**/.opencode-sysop/**"], undefined)
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

test("applyHomeScope appends anchored allows to security-locks and audit-logger, preserving deny", () => {
  const cfg: any = {
    agent: {
      "security-locks": { permission: { edit: { "*": "deny" } } },
      "audit-logger": { permission: { edit: { "*": "deny" } } },
      "rag-brain": { permission: {} },
    },
  }
  applyHomeScope(cfg, sysopDir())
  for (const name of ["security-locks", "audit-logger"]) {
    const edit = cfg.agent[name].permission.edit
    assert.equal(edit["*"], "deny")
    assert.equal(edit[`${sysopDir()}/**`], "allow")
    assert.equal(edit[`${strip(sysopDir())}/**`], "allow")
  }
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
  applyConfig(cfg, vaultDir(), sysopDir(), diagramsDir())
  assert.equal(cfg.permission.edit, undefined, "no vault allow injected at top level")
  assert.equal(cfg.agent["rag-brain"].permission.edit[`${strip(vaultDir())}/**`], "allow")
  assert.equal(cfg.mcp["markdown-vault"].environment.VAULT_PATH, vaultDir())
  assert.equal(cfg.agent["security-locks"].permission.edit[`${strip(sysopDir())}/**`], "allow")
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
  applyHomeScope(cfg, "")
  applyDiagramScope(cfg, "")
  assert.deepEqual(cfg, { mcp: {}, agent: {} })
})
