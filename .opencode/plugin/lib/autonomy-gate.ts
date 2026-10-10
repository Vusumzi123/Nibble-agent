// Autonomy gate — the pure classification core (docs/autonomy-harness-plan.md
// §4.1/§4.3 — kanban card C). No config reads, no logging, no side effects:
// classifyCall(tool, args, level) answers allow|ask|deny for one action at the
// live autonomy level, per the matrix in [[phase-1-kanban-notes]].
//
// Contract:
//   - The irreversibility floor is checked FIRST, at every level: deny is
//     never approvable, not even at L4, not even if the command matches
//     `root_classes` (§4.1 hard rule).
//   - Reads pass at every level, including L0 (settled decision #2 —
//     plan-agent-mode semantics rather than §4.1's literal "everything asks").
//   - `jev: true` marks rows the gate routes through the JEV borderline
//     escalation (card G) before settling; the fail-closed verdict stays
//     `ask`, so skipping JEV never allows anything.
//   - Non-integer/out-of-range levels fail closed to L0 (strictest).
//
// Loaded via relative import only — the plugin auto-discovery glob is
// non-recursive, so this subdirectory file is never loaded as a plugin.
import { createHash } from "node:crypto"
import type { DecisionRequest, DecisionResult } from "./decisions.ts"

export type GateVerdict = "allow" | "ask" | "deny"

export type CallClass =
  | "floor"
  | "pure-read"
  | "readonly-bash"
  | "vault-write"
  | "project-write"
  | "subagent-read"
  | "subagent-web"
  | "subagent-web-deep"
  | "subagent-write"
  | "destructive"
  | "root"
  | "self-improve"
  | "borderline"
  | "external"

export type Classification = {
  verdict: GateVerdict
  cls: CallClass
  reason: string
  /** Unclassifiable call — the borderline flag (card D logs it, card G uses it). */
  borderline: boolean
  /** Escalate through JEV before settling; verdict stays `ask` fail-closed. */
  jev: boolean
  /** External tool outside the autonomy schema — never gated, logged only. */
  outOfSchema?: boolean
}

export type ClassifyOpts = {
  /** L4 root allowlist (§4.2). Only consulted for root calls at L4. */
  root_classes?: readonly string[]
  /** `kind:name:class` triples (`tool:foo_*:vault-write`,
   *  `subagent:my-agent:subagent-write`). Invalid entries never match. */
  class_overrides?: readonly string[]
}

// ---------------------------------------------------------------------------
// Level matrix (rows = CallClass, index = L0..L4). Floor is handled before
// this table; `root` is handled after (it needs root_classes).

type Cell = { v: GateVerdict; jev: boolean }

const allow: Cell = { v: "allow", jev: false }
const ask: Cell = { v: "ask", jev: false }
const askJev: Cell = { v: "ask", jev: true }
const deny: Cell = { v: "deny", jev: false }

// L0 = Plan mode (reads free, mutations denied), L1 = Build mode (code freely,
// dangerous classes ask), L2 = Knowledge, L3 = Working, L4 = Autonomous.
// `floor` and `root` are handled before this table; `external` is out-of-schema.
const MATRIX: Record<Exclude<CallClass, "floor" | "root" | "external">, Cell[]> = {
  "pure-read": [allow, allow, allow, allow, allow],
  "readonly-bash": [allow, allow, allow, allow, allow],
  "vault-write": [deny, allow, allow, allow, allow],
  "project-write": [deny, allow, allow, allow, allow],
  "subagent-read": [allow, allow, allow, allow, allow],
  "subagent-web": [ask, ask, allow, allow, allow],
  "subagent-web-deep": [ask, ask, askJev, allow, allow],
  "subagent-write": [ask, ask, allow, allow, allow],
  destructive: [deny, ask, ask, askJev, allow],
  "self-improve": [deny, ask, ask, ask, askJev],
  // Borderline: unparseable bash only — never free, JEV-tripped L1+.
  borderline: [deny, askJev, askJev, askJev, askJev],
}

const REASONS: Record<CallClass, string> = {
  floor: "irreversibility floor",
  "pure-read": "pure-read tool",
  "readonly-bash": "read-only bash",
  "vault-write": "vault MCP write",
  "project-write": "project write",
  "subagent-read": "read-only sub-agent",
  "subagent-web": "web sub-agent",
  "subagent-web-deep": "deep web research",
  "subagent-write": "mutating sub-agent",
  destructive: "destructive class",
  root: "root command",
  "self-improve": "self-improve path",
  borderline: "unclassifiable",
  external: "external tool (outside autonomy schema)",
}

function normalizeLevel(level: unknown): number {
  return typeof level === "number" && Number.isInteger(level) && level >= 0 && level <= 4 ? level : 0
}

// ---------------------------------------------------------------------------
// [autonomy] prompt line (card D) — advisory, hot-read per turn.

const LEVEL_NAMES = ["Plan", "Build", "Knowledge", "Working", "Autonomous"] as const
const LEVEL_ENVELOPES = [
  "plan mode — reads are free, nothing mutates; propose, don't implement",
  "build mode — code and commands run freely; destructive/root/self-improve ask",
  "knowledge — vault writes and browsing delegate freely; destructive still asks",
  "working — destructive and root cleared by JEV; self-improvement asks",
  "autonomous — everything passes except the irreversibility floor and root classes",
] as const

/** The system-prompt line for the live dial (plan §4.1 names + envelopes). */
export function autonomyDirective(level: unknown): string {
  const L = normalizeLevel(level)
  return `[autonomy] level ${L} (${LEVEL_NAMES[L]}) — ${LEVEL_ENVELOPES[L]}; irreversibility floor always applies`
}

// ---------------------------------------------------------------------------
// Enforcement messages (card E) — thrown from tool.execute.before.

/** Instructive ask: names the level, the reason, and the batch-approval flow. */
export function askMessage(c: { reason: string; cls: CallClass }, level: unknown): string {
  const L = normalizeLevel(level)
  return (
    `[autonomy] ASK at level ${L} (${LEVEL_NAMES[L]}): ${c.reason} (class: ${c.cls}). ` +
    `This call needs the user's approval. To avoid one prompt per action, list ALL ` +
    `planned actions for this task in a fenced \`\`\`autonomy-batch block (one ` +
    `\`class target\` per line) and wait for a single confirmation; otherwise the ` +
    `user's confirm approves just this one call. Confirm words: yes / y / proceed / ` +
    `go ahead / approve / --execute / --live. Alternatives: raise autonomy.level or ` +
    `set autonomy.gate_mode: shadow in .opencode/sysop-config.yaml. This is NOT a ` +
    `command result: the call did not run, so NEVER report it as "no output", ` +
    `"nothing found", or a tool failure. Relay the hold to the user (action + reason + ` +
    `the confirm words above) and wait; do not silently rewrite the command or switch ` +
    `to an equivalent tool to complete the same blocked intent.`
  )
}

/** Hard refusal. The floor is never approvable; other denies only occur at L0
 *  (Plan mode), where the remedy is raising the dial, not retrying. */
export function denyMessage(c: { reason: string; cls: CallClass }, level: unknown): string {
  const L = normalizeLevel(level)
  if (c.cls === "floor") {
    return (
      `[autonomy] DENIED at level ${L} (${LEVEL_NAMES[L]}): ${c.reason}. ` +
      `The irreversibility floor is never approvable — not at any level, not via ` +
      `root_classes. Do not retry. ` +
      `This is NOT a command result: the call did not run — never report it as ` +
      `"nothing found". Tell the user the action is permanently blocked.`
    )
  }
  return (
    `[autonomy] DENIED at level ${L} (${LEVEL_NAMES[L]}): ${c.reason} (class: ${c.cls}). ` +
    `Level 0 is Plan mode — reads only; propose changes, don't implement. Raise ` +
    `autonomy.level (e.g. to 1, Build mode) to perform this action. ` +
    `This is NOT a command result: the call did not run.`
  )
}

function result(cls: CallClass, level: number, reason?: string): Classification {
  if (cls === "floor") {
    return { verdict: "deny", cls, reason: reason ?? REASONS.floor, borderline: false, jev: false }
  }
  if (cls === "root") {
    // L0 (Plan mode) denies root; L1–L3 ask; L4 is resolved by the caller
    // (root_classes match -> allow, otherwise ask).
    if (level === 0) return { verdict: "deny", cls, reason: reason ?? REASONS.root, borderline: false, jev: false }
    return { verdict: "ask", cls, reason: reason ?? REASONS.root, borderline: false, jev: false }
  }
  const cell = MATRIX[cls][level]
  return {
    verdict: cell.v,
    cls,
    reason: reason ?? REASONS[cls],
    borderline: cls === "borderline",
    jev: cell.jev,
  }
}

// ---------------------------------------------------------------------------
// Bash segmentation helpers

// `2>&1` / `1>&2` style duplications are harmless — strip them before
// splitting so they neither read as redirects nor break segments apart.
function splitSegments(cmd: string): string[] {
  return cmd
    .replace(/\d*>&\d+/g, " ")
    .replace(/&>>?/g, " > ")
    .split(/&&|\|\||[;|&\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

// Quote-aware: `'mkfs.ext4 /dev/sda'` is one token, embedded quotes survive.
function tokenize(seg: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: string | null = null
  for (const ch of seg) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }
    current += ch
  }
  if (current) tokens.push(current)
  return tokens
}

const ESCALATION = new Set(["sudo", "pkexec", "doas", "su"])
// Transparent prefixes: they wrap a command without changing what it does.
const TRANSPARENT = new Set(["env", "timeout", "nice", "time", "nohup", "command", "builtin", "exec", "stdbuf"])
// Flags that take a separate value token, per wrapper — a global set would
// misread `sudo -n` (flag, no value) as `sudo -n <value>`.
const WRAPPER_VALUE_FLAGS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-p", "-C", "-U", "--user", "--group", "--prompt"]),
  pkexec: new Set(["--user", "--action-id", "--disable-internal-agent"]),
  doas: new Set(["-C", "-u"]),
  su: new Set(["-p", "-s", "-g"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  nice: new Set(["-n", "--adjustment"]),
  env: new Set(["-u", "--unset", "-S", "--split-string"]),
  stdbuf: new Set(["-o", "-i", "-e"]),
  time: new Set(["-f", "-o"]),
}

// Strip env assignments, escalation wrappers, and transparent prefixes to
// reach the command word. `su -c '…'`-style commands recurse into the payload.
function stripPrefixes(seg: string): string {
  let tokens = tokenize(seg)
  let guard = 0
  while (tokens.length > 0 && guard++ < 8) {
    const t = tokens[0]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      tokens.shift()
      continue
    }
    if (ESCALATION.has(t) || TRANSPARENT.has(t)) {
      const wrapper = tokens.shift() as string
      if (wrapper === "timeout" && tokens.length > 0 && !tokens[0].startsWith("-")) {
        tokens.shift() // duration value
      }
      const valueFlags = WRAPPER_VALUE_FLAGS[wrapper]
      while (tokens.length > 0 && tokens[0].startsWith("-")) {
        const flag = tokens.shift() as string
        if (flag === "-c" || flag === "--command") {
          // The next token is the wrapped command — restart the strip on it.
          return tokens.length > 0 ? stripPrefixes(tokens.join(" ")) : ""
        }
        if (valueFlags?.has(flag) && tokens.length > 0 && !tokens[0].startsWith("-")) tokens.shift()
      }
      continue
    }
    break
  }
  return tokens.join(" ")
}

function commandWord(seg: string): string {
  const stripped = stripPrefixes(seg)
  return stripped.length > 0 ? stripped.split(/\s+/)[0] : ""
}

function operandsOf(seg: string): string[] {
  // Non-flag tokens after the command word (quotes already stripped).
  const tokens = tokenize(stripPrefixes(seg))
  const out: string[] = []
  let literal = false
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (literal) {
      out.push(t)
      continue
    }
    if (t === "--") {
      literal = true
      continue
    }
    if (t.startsWith("-")) continue
    out.push(t)
  }
  return out
}

// Output-redirect targets (`>`, `>>`, `2>`, `&>`), excluding harmless
// dev-null/stdout/stderr sinks.
const REDIRECT_RE = /(?:\d*&)?(>>?)\s*([^\s;|&]+)/g
function redirectTargets(seg: string): string[] {
  const targets: string[] = []
  for (const m of seg.matchAll(REDIRECT_RE)) {
    const target = (m[2] ?? "").replace(/^["']|["']$/g, "")
    if (target) targets.push(target)
  }
  return targets
}
const HARMLESS_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"])
function hasFileWrite(seg: string): boolean {
  return redirectTargets(seg).some((t) => !HARMLESS_SINKS.has(t))
}

// ---------------------------------------------------------------------------
// Irreversibility floor (§4.1 — checked before anything else, every level)

const FLOOR_COMMANDS = new Set([
  "shred",
  "wipe",
  "fdisk",
  "sfdisk",
  "cfdisk",
  "gdisk",
  "sgdisk",
  "parted",
  "lvremove",
  "pvremove",
  "vgremove",
  "wipefs",
  "blkdiscard",
])

// System roots whose recursive deletion is floor-level. `/home` is exact-only:
// its descendants are user paths (destructive, but approvable).
const SYSTEM_ROOTS = [
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib64",
  "/opt",
  "/proc",
  "/root",
  "/sbin",
  "/srv",
  "/sys",
  "/usr",
  "/var",
]

// Shell-mutation verbs — used for both tampering (floor) and self-improve.
const MUTATE_VERBS = new Set(["rm", "mv", "cp", "tee", "truncate", "chmod", "chown", "ln", "touch", "install", "patch", "dd"])

// The security machinery the floor protects: tampering with it (any tool, any
// level) is deny — even the directories whose deletion takes the hooks with
// them. Everything else under .opencode/plugin/** falls to the self-improve
// row (ask / JEV), not the floor.
const SECURITY_MARKERS = [
  ".opencode/plugin/audit-hook",
  ".opencode/plugin/lib/audit",
  ".opencode/plugin/scoped-permissions",
  ".opencode/plugin/lib/scopes",
]
const SECURITY_DIRS = /(^|\/)\.opencode$|(^|\/)\.opencode\/plugin$|(^|\/)\.opencode\/plugin\/lib$/

function normalizeTarget(raw: string): string {
  // Cut at the first glob character and drop trailing slashes: `/etc/*` -> `/etc`.
  // A bare `/` (or `/*`) stays `/` — it is the ultimate system root.
  const globAt = raw.search(/[*?[]/)
  const cut = globAt === -1 ? raw : raw.slice(0, globAt)
  const stripped = cut.replace(/\/+$/, "")
  if (stripped === "" && cut.includes("/")) return "/"
  return stripped
}

function isSecurityTarget(raw: string): boolean {
  const p = normalizeTarget(raw)
  if (!p) return false
  if (SECURITY_MARKERS.some((m) => p.includes(m))) return true
  return SECURITY_DIRS.test(p)
}

function isConfigTarget(raw: string): boolean {
  const p = normalizeTarget(raw)
  return (
    p === "opencode.json" ||
    p.endsWith("/opencode.json") ||
    p === "sysop-config.yaml" ||
    p.endsWith("/sysop-config.yaml")
  )
}

function touchesPath(seg: string, pred: (p: string) => boolean): boolean {
  const verb = commandWord(seg)
  const all = [...tokenize(seg), ...operandsOf(seg)]
  if (hasFileWrite(seg)) {
    if (redirectTargets(seg).some(pred)) return true
  }
  if (MUTATE_VERBS.has(verb) || (verb === "sed" && tokenize(seg).some((t) => t === "-i" || t.startsWith("-i"))) || hasFileWrite(seg)) {
    return all.some(pred)
  }
  return false
}

function isMutating(seg: string): boolean {
  const verb = commandWord(seg)
  if (hasFileWrite(seg)) return true
  if (verb === "sed") return tokenize(stripPrefixes(seg)).some((t) => t === "-i" || t.startsWith("-i"))
  return MUTATE_VERBS.has(verb)
}

function floorDetail(cmd: string): string | null {
  for (const seg of splitSegments(cmd)) {
    const word = commandWord(seg)
    if (!word) continue

    // wipe-class commands (mkfs family included)
    if (FLOOR_COMMANDS.has(word)) return `${word}`
    if (/^mkfs(\.|$)/.test(word)) return "mkfs"

    // dd onto a block device (null/zero/std sinks are not devices)
    if (word === "dd") {
      for (const t of tokenize(stripPrefixes(seg))) {
        const m = /^of=(.+)$/.exec(t)
        if (!m) continue
        const dev = normalizeTarget(m[1])
        const leaf = dev.split("/").pop() ?? ""
        if (dev.startsWith("/dev/") && !["null", "zero", "full", "stdout", "stderr", "random", "urandom", "tty", "fd"].includes(leaf)) {
          return "dd -> block device"
        }
      }
    }

    // rm onto system roots (recursive for descendants; exact root always)
    if (word === "rm") {
      const flags = tokenize(stripPrefixes(seg)).filter((t) => t.startsWith("-") && t !== "--")
      const recursive = flags.some((f) => f === "--recursive" || (/^-[a-zA-Z]*[rR]/.test(f) && f.length > 1))
      for (const raw of operandsOf(seg)) {
        const p = normalizeTarget(raw)
        if (!p.startsWith("/")) continue
        if (p === "/" || p === "/home") return "rm system root"
        if (recursive && SYSTEM_ROOTS.some((r) => p === r || p.startsWith(r + "/"))) return "rm system root"
      }
    }

    // hook + permission tampering (audit-hook/, opencode.json permission blocks)
    if (isMutating(seg)) {
      if (touchesPath(seg, isSecurityTarget)) return "tamper with audit hook"
      if (touchesPath(seg, isConfigTarget)) return "tamper with opencode.json or sysop-config.yaml"
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Bash class checks

const ROOT_RE = /(^|[\s;&|])(sudo|pkexec|doas|su)(\s|$)/

const DESTRUCTIVE_COMMANDS = new Set([
  "rm",
  "kill",
  "killall",
  "pkill",
  "shutdown",
  "reboot",
  "poweroff",
  "halt",
  "userdel",
  "deluser",
  "chpasswd",
  "mkswap",
  "truncate",
])
const SYSTEMCTL_STOP = new Set(["stop", "disable", "restart", "mask", "kill", "isolate", "poweroff", "reboot", "suspend", "hibernate", "reenable"])

const RO_SIMPLE = new Set([
  "ls", "cat", "pwd", "df", "du", "free", "uptime", "date", "echo", "printf",
  "whoami", "id", "uname", "hostname", "ps", "which", "whereis", "stat", "file",
  "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "diff", "cmp", "jq",
  "env", "printenv", "nproc", "groups", "md5sum", "sha1sum", "sha256sum",
  "sha512sum", "cksum", "tree", "getent", "lsblk", "lscpu", "lsusb", "lspci",
  "sort", "uniq", "cut", "tr", "cd", "test", "true", "false", "sleep",
  "realpath", "readlink", "dirname", "basename", "seq", "expr", "bc",
  "journalctl", "dmesg", "checkupdates", "vmstat", "iostat", "mpstat",
])

const GIT_RO = new Set([
  "status", "log", "diff", "show", "blame", "rev-parse", "describe", "shortlog",
  "reflog", "ls-files", "grep", "ls-remote", "name-rev", "whatchanged",
])

const SYSTEMCTL_RO = new Set([
  "status", "show", "cat", "is-active", "is-enabled", "is-failed", "list-units",
  "list-timers", "list-sockets", "list-jobs", "list-dependencies", "get-default",
])

const FIND_WRITE_FLAGS = /-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls|fc|fdir)/

function firstSubcommand(tokens: string[]): string {
  for (const t of tokens) {
    if (!t.startsWith("-")) return t
  }
  return ""
}

function isReadonlySegment(seg: string): boolean {
  if (hasFileWrite(seg)) return false
  const word = commandWord(seg)
  if (!word) return true // bare env assignment / empty segment
  const tokens = tokenize(stripPrefixes(seg))
  const sub = firstSubcommand(tokens.slice(1))

  if (RO_SIMPLE.has(word)) return true
  if (word === "sed") return !tokens.some((t) => t === "-i" || t.startsWith("-i"))
  if (word === "git") return GIT_RO.has(sub)
  if (word === "find") return !tokens.some((t) => FIND_WRITE_FLAGS.test(t))
  if (word === "systemctl") return sub === "" || SYSTEMCTL_RO.has(sub)
  if (word === "pacman" || word === "paru" || word === "yay") {
    const flags = tokens.slice(1).filter((t) => t.startsWith("-"))
    if (flags.length === 0) return false
    return flags.every(
      (f) =>
        f.startsWith("-Q") ||
        f === "-Ss" || f === "-Si" || f === "-Sl" || f === "-Sii" || f === "-Sg" || f === "-Sp" ||
        f === "--query" || f === "--list" || f === "--info" || f === "--search",
    )
  }
  return false
}

function isDestructiveSegment(seg: string): boolean {
  const word = commandWord(seg)
  if (DESTRUCTIVE_COMMANDS.has(word)) return true
  const tokens = tokenize(stripPrefixes(seg))
  if (word === "systemctl") return SYSTEMCTL_STOP.has(firstSubcommand(tokens.slice(1)))
  if (word === "pacman" || word === "paru" || word === "yay") {
    return tokens.slice(1).some((t) => /^-[A-Za-z]*R[A-Za-z]*$/.test(t) || t === "-Sc" || t === "-Scc" || t === "--remove")
  }
  return false
}

function isSelfImproveSegment(seg: string): boolean {
  if (!isMutating(seg)) return false
  return touchesPath(seg, isSelfImprovePath)
}

// L4 root allowlist: a root_classes pattern matches when the escalation-stripped
// segment equals it or continues on a word boundary (` ` or unit suffix `.`).
function rootMatches(cmd: string, rootClasses: readonly string[]): boolean {
  if (rootClasses.length === 0) return false
  return splitSegments(cmd).some((seg) => {
    const stripped = stripPrefixes(seg)
    if (!stripped) return false
    return rootClasses.some((p) => {
      if (!p) return false
      if (stripped === p) return true
      if (!stripped.startsWith(p)) return false
      const next = stripped.charAt(p.length)
      return next === " " || next === "\t" || next === "."
    })
  })
}

// ---------------------------------------------------------------------------
// Non-bash tools

const PURE_READ_TOOLS = new Set(["read", "glob", "grep", "list", "todowrite", "todoread", "skill", "question"])
const PROJECT_WRITE_TOOLS = new Set(["edit", "write", "patch", "apply_patch"])
const VAULT_PREFIX = "markdown-vault_"

// Built-in `task` sub-agent types → tier. The child session is floor-only under
// gate_scope main, so the SPAWN is the permission event; the tier reflects the
// worst the child could do. Unknown types fail closed to `subagent-write`.
const SUBAGENT_TIERS: Record<string, CallClass> = {
  "rag-search": "subagent-read",
  explore: "subagent-read",
  "safe-browser": "subagent-web",
  "deep-browser": "subagent-web-deep",
  "rag-brain": "subagent-write",
  "package-manager": "subagent-write",
  "os-configurator": "subagent-write",
  "sandbox-runner": "subagent-write",
  "security-locks": "subagent-write",
  "web-developer": "subagent-write",
  "diagram-developer": "subagent-write",
  "profile-writer": "subagent-write",
  general: "subagent-write",
}

// Vault MCP actions (presentation/mcp-tools.ts): reads pass at every level,
// writes take the vault-write row. Anything unrecognised fails closed.
const VAULT_READ_ACTIONS = new Set([
  "read", "list", "search", "global_search", "semantic_search", "stat", "get",
  "view", "query", "outline", "backlinks", "bulk_read", "frontmatter_get",
  "status", "history", "overview", "overview_status", "prepare_overview",
])
const VAULT_WRITE_ACTIONS = new Set([
  "create", "update", "delete", "create_from_template", "append", "prepend",
  "replace", "line_replace", "string_replace", "frontmatter_set", "transition",
  "reset", "save_overview", "reindex",
])

function argString(args: Record<string, unknown>): string {
  const v = args.path ?? args.filePath ?? args.file ?? args.filename
  return typeof v === "string" ? v : ""
}

function classifyVault(tool: string, args: Record<string, unknown>): CallClass {
  const action = typeof args.action === "string" ? args.action.toLowerCase() : ""
  const operation = typeof args.operation === "string" ? args.operation.toLowerCase() : ""
  const candidate = action || operation
  if (candidate) {
    if (VAULT_WRITE_ACTIONS.has(candidate)) return "vault-write"
    if (VAULT_READ_ACTIONS.has(candidate)) return "pure-read"
    return "vault-write" // unknown action — fail closed
  }
  // No action at all: `view` is read-only by construction; the rest ask.
  return tool === VAULT_PREFIX + "view" ? "pure-read" : "vault-write"
}

// Self-improve paths: writes to .opencode/plugin/**, opencode.json, or
// sysop-config.yaml (the sanctioned self-improve surfaces — plan §4.1; shell
// mutation of opencode.json / sysop-config.yaml is the floor instead, see
// floorDetail). sysop-config.yaml holds the autonomy dial, so editing it is
// self-improve — otherwise the agent could raise its own level.
function isSelfImprovePath(path: string): boolean {
  if (!path) return false
  const n = path.replace(/\\/g, "/")
  return (
    n.includes(".opencode/plugin/") ||
    n === ".opencode/plugin" ||
    n === "opencode.json" ||
    n.endsWith("/opencode.json") ||
    n === ".opencode/sysop-config.yaml" ||
    n.endsWith("/.opencode/sysop-config.yaml") ||
    n === "sysop-config.yaml" ||
    n.endsWith("/sysop-config.yaml")
  )
}

// ---------------------------------------------------------------------------
// Pending-ask approval machine (card F — pure, no I/O).
//
// ask => record {session, sha1 fingerprint, ts} (TTL 10m, latest-only).
// The user's strict confirm in chat.message approves it; the EXACT retry
// (same session + same fingerprint) then passes ONCE. Floor verdicts never
// record, so a deny can never be approved. Restart clears the store
// (fail-closed) — the plugin owns the Map.

export type PendingAskRecord = {
  fingerprint: string
  ts: number
  approved: boolean
}

export type AskStore = Map<string, PendingAskRecord>

export const ASK_TTL_MS = 10 * 60 * 1000

/** The strict confirm vocabulary (card F — case-sensitive on purpose). */
export const CONFIRM_RE = /^(?:yes|y|proceed|go ahead|approve|--execute|--live)\b/

export function isConfirm(text: string): boolean {
  return CONFIRM_RE.test(text.trim())
}

function expired(record: PendingAskRecord | undefined, now: number): boolean {
  return !record || now - record.ts > ASK_TTL_MS
}

/** Latest-only: a new ask for the session replaces any previous pending. */
export function recordAsk(store: AskStore, session: string, fingerprint: string, now: number): void {
  store.set(session, { fingerprint, ts: now, approved: false })
}

/** User confirm: approve whatever is pending for the session. No pending
 *  (or an expired one) is a no-op — floor verdicts never create pendings. */
export function approveAsk(store: AskStore, session: string, now: number): boolean {
  const record = store.get(session)
  if (expired(record, now)) {
    store.delete(session)
    return false
  }
  record!.approved = true
  return true
}

/** Does this exact call carry an unconsumed approval? Fingerprint must match
 *  the approved ask and the 10m TTL must still hold. */
export function isApproved(store: AskStore, session: string, fingerprint: string, now: number): boolean {
  const record = store.get(session)
  if (expired(record, now)) {
    store.delete(session)
    return false
  }
  return record!.approved && record!.fingerprint === fingerprint
}

/** One-shot consume: the approved retry passes once; a second attempt (or an
 *  expired/mismatched one) returns false and never deletes someone else's shot. */
export function consumeApproved(store: AskStore, session: string, fingerprint: string, now: number): boolean {
  if (!isApproved(store, session, fingerprint, now)) return false
  store.delete(session)
  return true
}

// ---------------------------------------------------------------------------
// Class-override matching — `kind:name:class` triples from
// `autonomy.class_overrides`. A `tool:` name ending in `*` is a prefix glob.
// Invalid/unknown class values never match (fail-closed).

const VALID_CLASSES = new Set<CallClass>([
  "pure-read", "readonly-bash", "vault-write", "project-write",
  "subagent-read", "subagent-web", "subagent-web-deep", "subagent-write",
  "destructive", "root", "self-improve", "borderline",
])

export function parseClassOverride(entry: string): { kind: "tool" | "subagent"; name: string; cls: CallClass } | null {
  const parts = entry.split(":")
  if (parts.length < 3) return null
  const kind = parts[0]
  if (kind !== "tool" && kind !== "subagent") return null
  const cls = parts[parts.length - 1]
  if (!VALID_CLASSES.has(cls as CallClass)) return null
  return { kind, name: parts.slice(1, -1).join(":"), cls: cls as CallClass }
}

export function matchOverride(
  overrides: readonly string[],
  kind: "tool" | "subagent",
  name: string,
): CallClass | null {
  for (const entry of overrides) {
    const o = parseClassOverride(entry)
    if (!o || o.kind !== kind) continue
    if (o.name === name) return o.cls
    if (o.name.endsWith("*") && name.startsWith(o.name.slice(0, -1))) return o.cls
  }
  return null
}

// ---------------------------------------------------------------------------
// Batch approval (per-turn manifest). The model proposes a fenced
// ```autonomy-batch block listing `class target` entries; the user's confirm
// mints a grant binding EXACTLY those entries (class + target substring) with
// a call budget. Matching ask-class calls then pass without prompting;
// anything not declared still asks. Grants die on the next non-confirm user
// message (turn boundary) or TTL. Floor/deny never consults a grant.

export type BatchEntry = { cls: CallClass; target: string }
export type BatchGrant = { entries: BatchEntry[]; budget: number; ts: number }
export type GrantStore = Map<string, BatchGrant>

export const BATCH_FENCE = "autonomy-batch"
export const BATCH_MAX_ENTRIES = 20
export const BATCH_TARGET_MAX = 500

const BATCH_ALLOWED = new Set<CallClass>([
  "pure-read", "readonly-bash", "vault-write", "project-write",
  "subagent-read", "subagent-web", "subagent-web-deep", "subagent-write",
  "destructive", "root", "self-improve", "borderline",
])

/** Extract the last ```autonomy-batch block from assistant text. Returns null
 *  when absent, empty, or all-degenerate. Never throws. */
export function parseBatchManifest(text: string): BatchEntry[] | null {
  const fence = new RegExp("```" + BATCH_FENCE + "[\\t ]*\\n([\\s\\S]*?)```")
  const m = text.match(fence)
  if (!m) return null
  const entries: BatchEntry[] = []
  for (const line of m[1].split("\n")) {
    const t = line.trim()
    if (!t || t.startsWith("#")) continue
    const idx = t.search(/\s+/)
    const cls = (idx === -1 ? t : t.slice(0, idx)).trim()
    const target = (idx === -1 ? "" : t.slice(idx + 1).trim()).slice(0, BATCH_TARGET_MAX)
    if (!BATCH_ALLOWED.has(cls as CallClass)) continue
    entries.push({ cls: cls as CallClass, target })
    if (entries.length >= BATCH_MAX_ENTRIES) break
  }
  return entries.length ? entries : null
}

/** The target string of a call, used to match a manifest entry. */
export function callTarget(tool: string, args: unknown): string {
  const a = args != null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
  if (tool === "bash") return typeof a.command === "string" ? a.command : ""
  if (tool === "task") return typeof a.subagent_type === "string" ? a.subagent_type : ""
  const p = a.filePath ?? a.path ?? a.file ?? a.filename
  return typeof p === "string" ? p : ""
}

function entryMatches(entry: BatchEntry, cls: CallClass, target: string): boolean {
  if (entry.cls !== cls) return false
  if (!entry.target) return true
  return target.includes(entry.target)
}

/** Mint a per-session grant. Budget is capped at the declared entry count. */
export function mintGrant(store: GrantStore, session: string, entries: BatchEntry[], budget: number, now: number): void {
  if (entries.length === 0 || budget <= 0) return
  store.set(session, { entries, budget: Math.min(budget, entries.length), ts: now })
}

/** Consume the grant for one matching call. Decrements the budget and drops
 *  the grant when exhausted or expired. Non-matching calls return false. */
export function consumeGrant(store: GrantStore, session: string, cls: CallClass, target: string, now: number): boolean {
  const g = store.get(session)
  if (!g) return false
  if (now - g.ts > ASK_TTL_MS) {
    store.delete(session)
    return false
  }
  if (!g.entries.some((e) => entryMatches(e, cls, target))) return false
  g.budget -= 1
  if (g.budget <= 0) store.delete(session)
  return true
}

/** Drop any grant for the session (turn boundary). */
export function clearGrant(store: GrantStore, session: string): void {
  store.delete(session)
}

// ---------------------------------------------------------------------------
// JEV borderline escalation (card G) — deterministic first, LLM only on the
// edge. Every row with `jev: true` escalates through the shared decision gate
// (openDecisionGate, fallback CLOSED): error / abstain / timeout /
// decisions-disabled all resolve to `ask`, never `allow`.

/** Built-in criteria for the autonomy `choice` — mirrored in
 *  .opencode/decision-prompts.yaml's `autonomy:` section (single source of
 *  truth for the live text; this is the fallback when the file is missing). */
export const DEFAULT_AUTONOMY_ASSERTION =
  "The proposed tool call is safe to run without the user's confirmation: it is part of the stated task, " +
  "non-destructive, changes no security, permission, audit, or approval mechanism, and leaves nothing " +
  "irreversible behind. Choose allow only when the action is routine and expected for this task; choose " +
  "ask when it is ambiguous, security-relevant, irreversible, destructive, or outside the current task."

/** Plan §4.3's ~8s overlay on decisions.timeout_ms for autonomy escalations. */
export const AUTONOMY_JEV_TIMEOUT_MS = 8000

/** The `choice` request for one borderline call: candidates mirror the two
 *  outcomes; `criteria` carries the assertion text. */
export function buildAutonomyRequest(state: string, assertion: string): DecisionRequest {
  return {
    kind: "choice",
    state,
    candidates: ["allow", "ask"],
    criteria: assertion,
  }
}

/** Compact one-line description of the call for the JEV `state`. */
export function jevStateSummary(tool: string, args: unknown): string {
  const a: Record<string, unknown> = args != null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
  const detail =
    typeof a.command === "string"
      ? a.command
      : typeof a.filePath === "string"
        ? a.filePath
        : typeof a.path === "string"
          ? a.path
          : JSON.stringify(args ?? null) ?? ""
  const s = `${tool} ${detail}`
  return s.length > 1500 ? s.slice(0, 1500) + "…" : s
}

/** Fail-closed verdict reading: only a confident, non-error, non-abstain
 *  `allow` from the choice approves. Everything else (including a null
 *  result from a closed-polarity failure) means ask. */
export function jevAllows(result: DecisionResult | null): boolean {
  if (!result) return false
  if (result.error || result.abstained) return false
  if (typeof result.value !== "string") return false
  return result.value.trim().toLowerCase() === "allow"
}

// ---------------------------------------------------------------------------
// Public entry point

export function classifyCall(
  tool: string,
  args: unknown,
  level: unknown,
  opts: ClassifyOpts = {},
): Classification {
  const L = normalizeLevel(level)
  const a: Record<string, unknown> =
    args != null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {}

  if (tool === "bash") {
    const cmd = typeof a.command === "string" ? a.command : ""
    if (!cmd.trim()) return result("borderline", L)

    // 1. Floor — before root_classes, before anything (§4.1).
    const floor = floorDetail(cmd)
    if (floor) return result("floor", L, `${REASONS.floor}: ${floor}`)

    // 2. Root bash — L0–L3 ask; L4 allow iff root_classes match.
    if (ROOT_RE.test(cmd)) {
      if (L === 4 && rootMatches(cmd, opts.root_classes ?? [])) {
        return { verdict: "allow", cls: "root", reason: "root command (root_classes match)", borderline: false, jev: false }
      }
      return result("root", L)
    }

    const segments = splitSegments(cmd)
    // 3. Self-improve paths (shell mutation of .opencode/plugin/** — the
    //    opencode.json shell case was already caught by the floor).
    if (segments.some(isSelfImproveSegment)) return result("self-improve", L)
    // 4. Destructive non-floor.
    if (segments.some(isDestructiveSegment)) return result("destructive", L)
    // 5. Read-only bash — every segment must be read-only.
    if (segments.length > 0 && segments.every(isReadonlySegment)) return result("readonly-bash", L)
    // 6. Borderline.
    return result("borderline", L)
  }

  if (PURE_READ_TOOLS.has(tool)) return result("pure-read", L)
  if (tool.startsWith(VAULT_PREFIX)) return result(classifyVault(tool, a), L)
  if (PROJECT_WRITE_TOOLS.has(tool)) {
    const path = argString(a)
    if (path && SECURITY_MARKERS.some((m) => path.replace(/\\/g, "/").includes(m))) {
      return result("floor", L, `${REASONS.floor}: tamper with audit hook`)
    }
    if (isSelfImprovePath(path)) return result("self-improve", L)
    return result("project-write", L)
  }
  if (tool === "task") {
    const st = typeof a.subagent_type === "string" ? a.subagent_type : ""
    const cls = matchOverride(opts.class_overrides ?? [], "subagent", st) ?? SUBAGENT_TIERS[st] ?? "subagent-write"
    return result(cls, L)
  }
  // External / unclassified tool: out of the autonomy schema — pass, log only.
  const cls = matchOverride(opts.class_overrides ?? [], "tool", tool)
  if (cls) return result(cls, L)
  return {
    verdict: "allow",
    cls: "external",
    reason: REASONS.external,
    borderline: false,
    jev: false,
    outOfSchema: true,
  }
}

// ---------------------------------------------------------------------------
// Fingerprint — identifies "the same call" across a throw and its retry
// (cards D/F: verdict log + pending-ask approval). Canonical JSON so key
// order in the args object never changes the hash.

function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (typeof value === "object") {
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]"
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}"
  }
  return JSON.stringify(value)
}

export function fingerprintCall(tool: string, args: unknown): string {
  return createHash("sha1").update(tool + "\n" + canonical(args)).digest("hex")
}
