import { test } from "node:test"
import assert from "node:assert/strict"
import {
  ASK_TTL_MS,
  DEFAULT_AUTONOMY_ASSERTION,
  autonomyDirective,
  approveAsk,
  askMessage,
  buildAutonomyRequest,
  callTarget,
  classifyCall,
  clearGrant,
  consumeApproved,
  consumeGrant,
  denyMessage,
  fingerprintCall,
  isApproved,
  isConfirm,
  jevAllows,
  jevStateSummary,
  matchOverride,
  mintGrant,
  parseBatchManifest,
  parseClassOverride,
  recordAsk,
  type AskStore,
  type Classification,
  type GrantStore,
} from "./autonomy-gate.ts"

const LEVELS = [0, 1, 2, 3, 4] as const

function at(tool: string, args: unknown, opts?: Parameters<typeof classifyCall>[3]): Classification[] {
  return LEVELS.map((l) => classifyCall(tool, args, l, opts))
}

function expectRow(
  label: string,
  tool: string,
  args: unknown,
  verdicts: string[],
  cls: string,
  jevLevels: number[] = [],
  opts?: Parameters<typeof classifyCall>[3],
): void {
  LEVELS.forEach((lvl, i) => {
    const c = classifyCall(tool, args, lvl, opts)
    assert.equal(c.verdict, verdicts[i], `${label} @L${lvl} verdict`)
    assert.equal(c.cls, cls, `${label} @L${lvl} class`)
    assert.equal(c.jev, jevLevels.includes(lvl), `${label} @L${lvl} jev`)
    assert.equal(c.borderline, cls === "borderline", `${label} @L${lvl} borderline flag`)
  })
}

// ---------------------------------------------------------------------------
// Irreversibility floor: deny at every level, unapprovable, floor checked
// before root_classes.

const FLOOR_COMMANDS = [
  "mkfs.ext4 /dev/sdb1",
  "sudo mkfs.xfs /dev/nvme0n1p3",
  "dd if=/dev/zero of=/dev/sda bs=1M",
  "rm -rf /",
  "rm -rf /etc /var",
  "rm -rf /*",
  "rm -rf /home",
  "rm -rf /usr/local",
  "shred -u /home/vuszi/secret.txt",
  "wipe",
  "fdisk /dev/sda",
  "parted /dev/sda mklabel gpt",
  "lvremove /dev/vg0/data",
  "pkexec parted /dev/sda unit mb print",
  "timeout 5 mkfs.ext4 /dev/sdb2",
  "su -c 'mkfs.ext4 /dev/sda'",
  "sudo -n mkfs.ext4 /dev/sda",
  "rm .opencode/plugin/audit-hook.ts",
  "chmod -x .opencode/plugin/audit-hook.ts",
  "mv .opencode/plugin/audit-hook.ts /tmp/gone.ts",
  "rm -rf .opencode/plugin",
  "sed -i 's/deny/allow/' opencode.json",
  "echo '{\"permission\":{}}' > opencode.json",
]

test("floor commands are denied at every level", () => {
  for (const cmd of FLOOR_COMMANDS) {
    for (const lvl of LEVELS) {
      const c = classifyCall("bash", { command: cmd }, lvl)
      assert.equal(c.verdict, "deny", `floor: ${cmd} @L${lvl}`)
      assert.equal(c.cls, "floor", `floor class: ${cmd} @L${lvl}`)
      assert.equal(c.jev, false, `floor jev: ${cmd} @L${lvl}`)
      assert.match(c.reason, /irreversibility floor/, `floor reason: ${cmd} @L${lvl}`)
    }
  }
})

test("floor wins over root_classes and over the L4 allow rows", () => {
  const c1 = classifyCall("bash", { command: "sudo rm -rf /" }, 4, { root_classes: ["rm -rf", "rm -rf /"] })
  assert.equal(c1.verdict, "deny")
  const c2 = classifyCall("bash", { command: "mkfs.ext4 /dev/sda" }, 4, { root_classes: ["mkfs"] })
  assert.equal(c2.verdict, "deny")
})

test("floor applies to tool-based tampering with the audit hook", () => {
  for (const tool of ["edit", "write", "patch"]) {
    for (const lvl of LEVELS) {
      const c = classifyCall(
        tool,
        { filePath: "/home/vuszi/Projects/Nibble/.opencode/plugin/audit-hook.ts", content: "x" },
        lvl,
      )
      assert.equal(c.verdict, "deny", `${tool} audit-hook edit @L${lvl}`)
      assert.equal(c.cls, "floor")
    }
  }
})

test("near-floor commands fall through to their proper rows (not deny)", () => {
  // User-path rm is destructive, not floor.
  assert.equal(classifyCall("bash", { command: "rm -rf /home/vuszi/Projects/scratch" }, 4).cls, "destructive")
  assert.equal(classifyCall("bash", { command: "rm -rf /tmp/scratch" }, 4).cls, "destructive")
  // Reading the hook is a read; running tests is borderline, not tampering.
  assert.equal(classifyCall("bash", { command: "cat .opencode/plugin/audit-hook.ts" }, 0).cls, "readonly-bash")
  assert.equal(
    classifyCall("bash", { command: "node --test .opencode/plugin/lib/autonomy-gate.test.ts" }, 4).cls,
    "borderline",
  )
  // git add is not a shell-mutation verb.
  assert.equal(classifyCall("bash", { command: "git add .opencode/plugin/audit-hook.ts" }, 3).cls, "borderline")
  // Installing the wipe package names the word but does not run it.
  assert.equal(classifyCall("bash", { command: "pacman -S wipe" }, 4).verdict !== "deny", true)
  // Plugin edits outside the security files are self-improve (askable), not floor.
  const c = classifyCall("edit", { filePath: ".opencode/plugin/lib/knowledge.ts" }, 4)
  assert.equal(c.verdict, "ask")
  assert.equal(c.cls, "self-improve")
})

// ---------------------------------------------------------------------------
// Every matrix row x every level (matrix in phase-1-kanban-notes).

test("pure-read tools allow at every level, including L0", () => {
  for (const tool of ["read", "glob", "grep", "list", "todowrite", "todoread", "skill", "question"]) {
    for (const lvl of LEVELS) {
      const c = classifyCall(tool, { query: "x" }, lvl)
      assert.equal(c.verdict, "allow", `${tool} @L${lvl}`)
      assert.equal(c.cls, "pure-read")
    }
  }
})

test("matrix: read-only bash — allow at every level, including L0 (Plan mode)", () => {
  expectRow("git status", "bash", { command: "git status" }, ["allow", "allow", "allow", "allow", "allow"], "readonly-bash")
  expectRow("df -h", "bash", { command: "df -h" }, ["allow", "allow", "allow", "allow", "allow"], "readonly-bash")
  expectRow("pacman -Q", "bash", { command: "pacman -Q htop" }, ["allow", "allow", "allow", "allow", "allow"], "readonly-bash")
  expectRow("chained", "bash", { command: "cat README.md && git status | head" }, ["allow", "allow", "allow", "allow", "allow"], "readonly-bash")
  expectRow("stderr sink", "bash", { command: "git status 2>/dev/null" }, ["allow", "allow", "allow", "allow", "allow"], "readonly-bash")
})

test("matrix: vault MCP write — deny at L0 (Plan mode), allow from L1", () => {
  expectRow("vault edit", "markdown-vault_edit", { operation: "append", path: "x.md" }, ["deny", "allow", "allow", "allow", "allow"], "vault-write")
  expectRow("vault create", "markdown-vault_vault", { action: "create", path: "x.md" }, ["deny", "allow", "allow", "allow", "allow"], "vault-write")
  expectRow("workflow transition", "markdown-vault_workflow", { action: "transition" }, ["deny", "allow", "allow", "allow", "allow"], "vault-write")
  expectRow("system save", "markdown-vault_system", { action: "save_overview" }, ["deny", "allow", "allow", "allow", "allow"], "vault-write")
})

test("matrix: vault reads and view are pure-read (allow everywhere)", () => {
  expectRow("vault read", "markdown-vault_vault", { action: "read", path: "x.md" }, ["allow", "allow", "allow", "allow", "allow"], "pure-read")
  expectRow("view search", "markdown-vault_view", { action: "search", query: "x" }, ["allow", "allow", "allow", "allow", "allow"], "pure-read")
  expectRow("view no-arg", "markdown-vault_view", {}, ["allow", "allow", "allow", "allow", "allow"], "pure-read")
})

test("matrix: project write — deny at L0 (Plan mode), allow from L1 (Build mode)", () => {
  expectRow("edit", "edit", { filePath: "src/app.ts" }, ["deny", "allow", "allow", "allow", "allow"], "project-write")
  expectRow("write", "write", { filePath: "docs/new.md" }, ["deny", "allow", "allow", "allow", "allow"], "project-write")
  expectRow("patch", "patch", { filePath: "src/app.ts" }, ["deny", "allow", "allow", "allow", "allow"], "project-write")
})

test("matrix: task sub-agent tiers — read free, web/write ask until L2", () => {
  expectRow("rag-search", "task", { subagent_type: "rag-search", description: "x" }, ["allow", "allow", "allow", "allow", "allow"], "subagent-read")
  expectRow("explore", "task", { subagent_type: "explore", description: "x" }, ["allow", "allow", "allow", "allow", "allow"], "subagent-read")
  expectRow("safe-browser", "task", { subagent_type: "safe-browser", description: "x" }, ["ask", "ask", "allow", "allow", "allow"], "subagent-web")
  expectRow("deep-browser", "task", { subagent_type: "deep-browser", description: "x" }, ["ask", "ask", "ask", "allow", "allow"], "subagent-web-deep", [2])
  expectRow("rag-brain", "task", { subagent_type: "rag-brain", description: "x" }, ["ask", "ask", "allow", "allow", "allow"], "subagent-write")
  expectRow("package-manager", "task", { subagent_type: "package-manager", description: "x" }, ["ask", "ask", "allow", "allow", "allow"], "subagent-write")
  // Unknown subagent_type fails closed to subagent-write.
  expectRow("unknown agent", "task", { subagent_type: "mystery-agent", description: "x" }, ["ask", "ask", "allow", "allow", "allow"], "subagent-write")
  // No subagent_type at all — fail closed to subagent-write.
  expectRow("no type", "task", { description: "x" }, ["ask", "ask", "allow", "allow", "allow"], "subagent-write")
})

test("matrix: class_overrides re-tiers tools and sub-agents", () => {
  const opts = { class_overrides: ["tool:frobnicate:project-write", "subagent:mystery-agent:subagent-read"] }
  expectRow("override tool", "frobnicate", { x: 1 }, ["deny", "allow", "allow", "allow", "allow"], "project-write", [], opts)
  expectRow("override subagent", "task", { subagent_type: "mystery-agent" }, ["allow", "allow", "allow", "allow", "allow"], "subagent-read", [], opts)
  expectRow(
    "glob override",
    "my-mcp_search",
    { query: "x" },
    ["deny", "allow", "allow", "allow", "allow"],
    "vault-write",
    [],
    { class_overrides: ["tool:my-mcp_*:vault-write"] },
  )
})

test("matrix: destructive non-floor — deny at L0, JEV at L3, allow at L4", () => {
  expectRow("rm user", "bash", { command: "rm -rf /tmp/scratch" }, ["deny", "ask", "ask", "ask", "allow"], "destructive", [3])
  expectRow("pacman -R", "bash", { command: "pacman -R htop" }, ["deny", "ask", "ask", "ask", "allow"], "destructive", [3])
  expectRow("systemctl stop", "bash", { command: "systemctl stop nginx" }, ["deny", "ask", "ask", "ask", "allow"], "destructive", [3])
  expectRow("kill", "bash", { command: "kill 1234" }, ["deny", "ask", "ask", "ask", "allow"], "destructive", [3])
})

test("matrix: root bash — deny at L0, ask at L1–L3, L4 allow iff root_classes match", () => {
  const cmd = { command: "sudo systemctl restart nginx" }
  expectRow("root L0-3 unmatched", "bash", cmd, ["deny", "ask", "ask", "ask", "ask"], "root")
  expectRow(
    "root L4 matched",
    "bash",
    cmd,
    ["deny", "ask", "ask", "ask", "allow"],
    "root",
    [],
    { root_classes: ["systemctl restart nginx"] },
  )
  expectRow(
    "root L4 prefix match",
    "bash",
    { command: "sudo -n pacman -Syu --noconfirm" },
    ["deny", "ask", "ask", "ask", "allow"],
    "root",
    [],
    { root_classes: ["pacman -Syu"] },
  )
  // No allowlist configured — L4 still asks (fail-closed).
  expectRow("root no allowlist", "bash", cmd, ["deny", "ask", "ask", "ask", "ask"], "root")
})

test("matrix: self-improve paths — deny at L0, ask at L1–L3, JEV at L4", () => {
  expectRow("edit plugin", "edit", { filePath: ".opencode/plugin/lib/autonomy.ts" }, ["deny", "ask", "ask", "ask", "ask"], "self-improve", [4])
  expectRow("write config", "write", { filePath: "opencode.json" }, ["deny", "ask", "ask", "ask", "ask"], "self-improve", [4])
  expectRow("write sysop-config", "edit", { filePath: ".opencode/sysop-config.yaml" }, ["deny", "ask", "ask", "ask", "ask"], "self-improve", [4])
  expectRow(
    "sed plugin",
    "bash",
    { command: "sed -i 's/a/b/' .opencode/plugin/lib/knowledge.ts" },
    ["deny", "ask", "ask", "ask", "ask"],
    "self-improve",
    [4],
  )
})

test("matrix: borderline — bash only now; deny at L0, JEV at L1–L4", () => {
  expectRow("node build", "bash", { command: "node build.js" }, ["deny", "ask", "ask", "ask", "ask"], "borderline", [1, 2, 3, 4])
  expectRow("redirect write", "bash", { command: "echo hi > notes.txt" }, ["deny", "ask", "ask", "ask", "ask"], "borderline", [1, 2, 3, 4])
})

test("external tools are outside the autonomy schema: allow everywhere, flagged", () => {
  for (const [tool, args] of [
    ["frobnicate", { x: 1 }],
    ["webfetch", { url: "https://x" }],
    ["websearch", { query: "x" }],
  ] as [string, unknown][]) {
    for (const lvl of LEVELS) {
      const c = classifyCall(tool, args, lvl)
      assert.equal(c.verdict, "allow", `${tool} @L${lvl}`)
      assert.equal(c.cls, "external", `${tool} @L${lvl} class`)
      assert.equal(c.outOfSchema, true, `${tool} @L${lvl} outOfSchema`)
    }
  }
})

// ---------------------------------------------------------------------------
// Level normalization (fail closed to L0) + fingerprint helper.

test("invalid levels fail closed to L0", () => {
  for (const bad of [99, -1, 2.5, NaN, "3" as unknown as number, null as unknown as number]) {
    const c = classifyCall("edit", { filePath: "src/app.ts" }, bad)
    assert.equal(c.verdict, "deny", `level ${String(bad)} must fail closed to L0 (deny)`)
    assert.equal(c.cls, "project-write")
  }
})

test("fingerprintCall is canonical, order-independent, and call-specific", () => {
  const a = fingerprintCall("bash", { command: "echo hi", workdir: "/tmp" })
  const b = fingerprintCall("bash", { workdir: "/tmp", command: "echo hi" })
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{40}$/)
  assert.notEqual(a, fingerprintCall("bash", { command: "echo hi", workdir: "/var" }))
  assert.notEqual(a, fingerprintCall("edit", { command: "echo hi", workdir: "/tmp" }))
  // Arrays keep order — [1,2] != [2,1].
  assert.notEqual(
    fingerprintCall("task", { items: [1, 2] }),
    fingerprintCall("task", { items: [2, 1] }),
  )
})

test("autonomyDirective names the level and always restates the floor", () => {
  assert.match(autonomyDirective(0), /^\[autonomy\] level 0 \(Plan\) — .*; irreversibility floor always applies$/)
  assert.match(autonomyDirective(1), /^\[autonomy\] level 1 \(Build\) — /)
  assert.match(autonomyDirective(2), /^\[autonomy\] level 2 \(Knowledge\) — /)
  assert.match(autonomyDirective(3), /^\[autonomy\] level 3 \(Working\) — /)
  assert.match(autonomyDirective(4), /^\[autonomy\] level 4 \(Autonomous\) — /)
  // Invalid levels fail closed to the strictest line.
  assert.match(autonomyDirective(99), /^\[autonomy\] level 0 \(Plan\) — /)
  assert.match(autonomyDirective("x"), /^\[autonomy\] level 0 \(Plan\) — /)
})

// ---------------------------------------------------------------------------
// Pending-ask approval machine (card F)

test("pending lifecycle: record -> approve -> exact retry passes once -> third denied", () => {
  const store: AskStore = new Map()
  const fp = fingerprintCall("edit", { filePath: "src/app.ts" })
  recordAsk(store, "ses_1", fp, 1_000)
  // Not approved yet — a retry before the confirm does not pass.
  assert.equal(consumeApproved(store, "ses_1", fp, 1_001), false)
  assert.equal(approveAsk(store, "ses_1", 1_002), true)
  assert.equal(isApproved(store, "ses_1", fp, 1_003), true)
  // One-shot.
  assert.equal(consumeApproved(store, "ses_1", fp, 1_004), true)
  assert.equal(consumeApproved(store, "ses_1", fp, 1_005), false)
  assert.equal(isApproved(store, "ses_1", fp, 1_006), false)
})

test("latest-only: a new ask replaces the previous pending", () => {
  const store: AskStore = new Map()
  recordAsk(store, "ses_1", "fp-old", 1_000)
  approveAsk(store, "ses_1", 1_001)
  recordAsk(store, "ses_1", "fp-new", 1_002) // newer ask, approval gone
  assert.equal(isApproved(store, "ses_1", "fp-new", 1_003), false)
  assert.equal(consumeApproved(store, "ses_1", "fp-old", 1_003), false)
})

test("approval binds to the exact fingerprint", () => {
  const store: AskStore = new Map()
  recordAsk(store, "ses_1", "fp-a", 1_000)
  approveAsk(store, "ses_1", 1_001)
  assert.equal(isApproved(store, "ses_1", "fp-b", 1_002), false)
  assert.equal(consumeApproved(store, "ses_1", "fp-b", 1_002), false)
  // The matching call still holds its shot.
  assert.equal(consumeApproved(store, "ses_1", "fp-a", 1_003), true)
})

test("TTL expiry: an approval older than 10 minutes is dead", () => {
  const store: AskStore = new Map()
  const t0 = 1_000_000
  recordAsk(store, "ses_1", "fp", t0)
  approveAsk(store, "ses_1", t0 + 1_000)
  const late = t0 + ASK_TTL_MS + 1
  assert.equal(isApproved(store, "ses_1", "fp", late), false)
  assert.equal(consumeApproved(store, "ses_1", "fp", late), false)
  assert.equal(store.size, 0) // expiry cleans up
  // Approving an expired pending is a no-op.
  recordAsk(store, "ses_1", "fp", t0)
  assert.equal(approveAsk(store, "ses_1", t0 + ASK_TTL_MS + 1), false)
  assert.equal(store.size, 0)
})

test("approveAsk without a pending is a no-op (floor never pendings)", () => {
  const store: AskStore = new Map()
  assert.equal(approveAsk(store, "ses_1", 1_000), false)
  assert.equal(store.size, 0)
})

test("isConfirm matches the strict vocabulary and nothing else", () => {
  for (const yes of ["yes", "y", "proceed", "go ahead", "approve", "--execute", "--live", "yes please", "y."]) {
    assert.equal(isConfirm(yes), true, `confirm: ${yes}`)
  }
  for (const no of ["no", "nah", "yesterday", "yep", "approved", "looks good", "", "Yes", "YES", "maybe --execute"]) {
    assert.equal(isConfirm(no), false, `not confirm: ${no}`)
  }
})

// ---------------------------------------------------------------------------
// Batch manifest parser + grant store (per-turn approval).

const MANIFEST = [
  "```autonomy-batch",
  "project-write src/a.ts",
  "project-write src/b.ts",
  "# a comment",
  "destructive rm -rf /tmp/scratch",
  "subagent-write package-manager",
  "```",
].join("\n")

test("parseBatchManifest extracts declared entries and skips junk", () => {
  const entries = parseBatchManifest(MANIFEST)
  assert.ok(entries)
  assert.deepEqual(entries, [
    { cls: "project-write", target: "src/a.ts" },
    { cls: "project-write", target: "src/b.ts" },
    { cls: "destructive", target: "rm -rf /tmp/scratch" },
    { cls: "subagent-write", target: "package-manager" },
  ])
})

test("parseBatchManifest returns null without a fence or on a degenerate body", () => {
  assert.equal(parseBatchManifest("no fence here"), null)
  assert.equal(parseBatchManifest("```autonomy-batch\n# only comments\n```"), null)
  assert.equal(parseBatchManifest("```autonomy-batch\nfloor /dev/sda\n```"), null) // floor not declarable
})

test("class override parsing: valid triples parse, invalid ones never match", () => {
  assert.deepEqual(parseClassOverride("tool:frobnicate:project-write"), { kind: "tool", name: "frobnicate", cls: "project-write" })
  assert.deepEqual(parseClassOverride("subagent:my-agent:subagent-write"), { kind: "subagent", name: "my-agent", cls: "subagent-write" })
  assert.equal(parseClassOverride("tool:short"), null)
  assert.equal(parseClassOverride("x:foo:bar"), null) // bad kind
  assert.equal(parseClassOverride("tool:foo:floor"), null) // floor not overridable
  assert.equal(parseClassOverride("tool:foo:external"), null) // external not a matrix class
  assert.equal(matchOverride(["tool:my_*:vault-write"], "tool", "my_mcp_search"), "vault-write")
  assert.equal(matchOverride(["tool:my_*:vault-write"], "tool", "other"), null)
})

test("callTarget extracts the target string per tool", () => {
  assert.equal(callTarget("bash", { command: "ls -la" }), "ls -la")
  assert.equal(callTarget("task", { subagent_type: "rag-search" }), "rag-search")
  assert.equal(callTarget("edit", { filePath: "src/a.ts" }), "src/a.ts")
  assert.equal(callTarget("read", { filePath: "src/a.ts" }), "src/a.ts")
})

test("grant store: mint -> matching calls consume budget -> non-matching/expired never pass", () => {
  const store: GrantStore = new Map()
  const entries = parseBatchManifest(MANIFEST)!
  mintGrant(store, "ses_1", entries, 3, 1_000)

  // Matching class + target substring passes and decrements.
  assert.equal(consumeGrant(store, "ses_1", "project-write", "src/a.ts", 1_001), true)
  assert.equal(consumeGrant(store, "ses_1", "project-write", "src/b.ts", 1_002), true)
  // Third match exhausts the budget (capped at 3) and drops the grant.
  assert.equal(consumeGrant(store, "ses_1", "destructive", "rm -rf /tmp/scratch", 1_003), true)
  assert.equal(store.size, 0)
  // A fourth (non-declared) call does not pass.
  assert.equal(consumeGrant(store, "ses_1", "destructive", "rm -rf /tmp/other", 1_004), false)
})

test("grant store: wrong class or wrong target never matches", () => {
  const store: GrantStore = new Map()
  mintGrant(store, "ses_1", parseBatchManifest(MANIFEST)!, 8, 1_000)
  assert.equal(consumeGrant(store, "ses_1", "project-write", "src/c.ts", 1_001), false) // target not declared
  assert.equal(consumeGrant(store, "ses_1", "destructive", "src/a.ts", 1_001), false) // class mismatch
  assert.equal(consumeGrant(store, "ses_2", "project-write", "src/a.ts", 1_001), false) // other session
})

test("grant store: TTL expiry and explicit clear", () => {
  const store: GrantStore = new Map()
  mintGrant(store, "ses_1", parseBatchManifest(MANIFEST)!, 8, 1_000)
  assert.equal(consumeGrant(store, "ses_1", "project-write", "src/a.ts", 1_000 + ASK_TTL_MS + 1), false)
  assert.equal(store.size, 0) // expiry cleans up
  mintGrant(store, "ses_1", parseBatchManifest(MANIFEST)!, 8, 1_000)
  clearGrant(store, "ses_1")
  assert.equal(store.size, 0)
})

// ---------------------------------------------------------------------------
// JEV borderline escalation helpers (card G)

test("jevAllows is fail-closed: only a confident, clean string 'allow' approves", () => {
  const base = {
    kind: "choice" as const,
    value: "allow",
    confidence: 0.9,
    probabilities: {},
    abstained: false,
    provider: "openjev",
    backend: "test",
    latencyMs: 1,
  }
  assert.equal(jevAllows(base), true)
  assert.equal(jevAllows({ ...base, value: " Allow " }), true)
  assert.equal(jevAllows({ ...base, value: "ask" }), false)
  assert.equal(jevAllows({ ...base, value: null as unknown as string }), false)
  assert.equal(jevAllows({ ...base, value: true as unknown as string }), false)
  assert.equal(jevAllows({ ...base, abstained: true, value: "allow" }), false)
  assert.equal(jevAllows({ ...base, error: "bridge timed out", value: "allow" }), false)
  assert.equal(jevAllows(null), false)
})

test("buildAutonomyRequest is a choice with allow/ask candidates", () => {
  const r = buildAutonomyRequest("bash node build.js", "the criteria")
  assert.equal(r.kind, "choice")
  assert.equal(r.state, "bash node build.js")
  assert.deepEqual(r.candidates, ["allow", "ask"])
  assert.equal(r.criteria, "the criteria")
  assert.ok(DEFAULT_AUTONOMY_ASSERTION.includes("safe to run without the user's confirmation"))
})

test("jevStateSummary prefers command/path and caps the length", () => {
  assert.equal(jevStateSummary("bash", { command: "ls -la" }), "bash ls -la")
  assert.equal(jevStateSummary("edit", { filePath: "src/a.ts" }), "edit src/a.ts")
  assert.equal(jevStateSummary("markdown-vault_edit", { path: "Brain/x.md" }), "markdown-vault_edit Brain/x.md")
  assert.equal(jevStateSummary("edit", null), "edit null")
  const long = jevStateSummary("bash", { command: "x".repeat(5000) })
  assert.ok(long.length <= 1501)
  assert.ok(long.endsWith("…"))
})

test("ask and deny messages forbid misreporting and silent substitution", () => {
  const ask = askMessage({ reason: "unclassifiable", cls: "borderline" }, 2)
  assert.match(ask, /NEVER report it as/)
  assert.match(ask, /Relay the hold to the user/)
  assert.match(ask, /do not silently rewrite the command or switch to an equivalent tool/)
  assert.match(ask, /autonomy-batch/)
  const deny = denyMessage({ reason: "irreversibility floor", cls: "floor" }, 2)
  assert.match(deny, /never report it as/)
  assert.match(deny, /Tell the user the action is permanently blocked/)
  // Non-floor deny (L0 Plan mode) points at the dial, not the floor.
  const l0 = denyMessage({ reason: "project write", cls: "project-write" }, 0)
  assert.match(l0, /Plan mode/)
  assert.match(l0, /Raise autonomy.level/)
})
