import { test } from "node:test"
import assert from "node:assert/strict"
import {
  ASK_TTL_MS,
  DEFAULT_AUTONOMY_ASSERTION,
  autonomyDirective,
  approveAsk,
  buildAutonomyRequest,
  classifyCall,
  consumeApproved,
  fingerprintCall,
  isApproved,
  isConfirm,
  jevAllows,
  jevStateSummary,
  recordAsk,
  type AskStore,
  type Classification,
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
  for (const tool of ["read", "glob", "grep", "list", "todowrite", "todoread"]) {
    for (const lvl of LEVELS) {
      const c = classifyCall(tool, { query: "x" }, lvl)
      assert.equal(c.verdict, "allow", `${tool} @L${lvl}`)
      assert.equal(c.cls, "pure-read")
    }
  }
})

test("matrix: read-only bash — ask at L0, allow from L1", () => {
  expectRow("git status", "bash", { command: "git status" }, ["ask", "allow", "allow", "allow", "allow"], "readonly-bash")
  expectRow("df -h", "bash", { command: "df -h" }, ["ask", "allow", "allow", "allow", "allow"], "readonly-bash")
  expectRow("pacman -Q", "bash", { command: "pacman -Q htop" }, ["ask", "allow", "allow", "allow", "allow"], "readonly-bash")
  expectRow("chained", "bash", { command: "cat README.md && git status | head" }, ["ask", "allow", "allow", "allow", "allow"], "readonly-bash")
  expectRow("stderr sink", "bash", { command: "git status 2>/dev/null" }, ["ask", "allow", "allow", "allow", "allow"], "readonly-bash")
})

test("matrix: vault MCP write — ask at L0–L1, allow from L2", () => {
  expectRow("vault edit", "markdown-vault_edit", { operation: "append", path: "x.md" }, ["ask", "ask", "allow", "allow", "allow"], "vault-write")
  expectRow("vault create", "markdown-vault_vault", { action: "create", path: "x.md" }, ["ask", "ask", "allow", "allow", "allow"], "vault-write")
  expectRow("workflow transition", "markdown-vault_workflow", { action: "transition" }, ["ask", "ask", "allow", "allow", "allow"], "vault-write")
  expectRow("system save", "markdown-vault_system", { action: "save_overview" }, ["ask", "ask", "allow", "allow", "allow"], "vault-write")
})

test("matrix: vault reads and view are pure-read (allow everywhere)", () => {
  expectRow("vault read", "markdown-vault_vault", { action: "read", path: "x.md" }, ["allow", "allow", "allow", "allow", "allow"], "pure-read")
  expectRow("view search", "markdown-vault_view", { action: "search", query: "x" }, ["allow", "allow", "allow", "allow", "allow"], "pure-read")
  expectRow("view no-arg", "markdown-vault_view", {}, ["allow", "allow", "allow", "allow", "allow"], "pure-read")
})

test("matrix: project write — ask at L0–L2, allow from L3", () => {
  expectRow("edit", "edit", { filePath: "src/app.ts" }, ["ask", "ask", "ask", "allow", "allow"], "project-write")
  expectRow("write", "write", { filePath: "docs/new.md" }, ["ask", "ask", "ask", "allow", "allow"], "project-write")
  expectRow("patch", "patch", { filePath: "src/app.ts" }, ["ask", "ask", "ask", "allow", "allow"], "project-write")
})

test("matrix: task sub-agent — ask at L0–L1, allow from L2", () => {
  expectRow("task", "task", { description: "x" }, ["ask", "ask", "allow", "allow", "allow"], "subagent")
})

test("matrix: destructive non-floor — ask everywhere, JEV at L4", () => {
  expectRow("rm user", "bash", { command: "rm -rf /tmp/scratch" }, ["ask", "ask", "ask", "ask", "ask"], "destructive", [4])
  expectRow("pacman -R", "bash", { command: "pacman -R htop" }, ["ask", "ask", "ask", "ask", "ask"], "destructive", [4])
  expectRow("systemctl stop", "bash", { command: "systemctl stop nginx" }, ["ask", "ask", "ask", "ask", "ask"], "destructive", [4])
  expectRow("kill", "bash", { command: "kill 1234" }, ["ask", "ask", "ask", "ask", "ask"], "destructive", [4])
})

test("matrix: root bash — ask at L0–L3, L4 allow iff root_classes match", () => {
  const cmd = { command: "sudo systemctl restart nginx" }
  expectRow("root L0-3 unmatched", "bash", cmd, ["ask", "ask", "ask", "ask", "ask"], "root")
  expectRow(
    "root L4 matched",
    "bash",
    cmd,
    ["ask", "ask", "ask", "ask", "allow"],
    "root",
    [],
    { root_classes: ["systemctl restart nginx"] },
  )
  expectRow(
    "root L4 prefix match",
    "bash",
    { command: "sudo -n pacman -Syu --noconfirm" },
    ["ask", "ask", "ask", "ask", "allow"],
    "root",
    [],
    { root_classes: ["pacman -Syu"] },
  )
  // No allowlist configured — L4 still asks (fail-closed).
  expectRow("root no allowlist", "bash", cmd, ["ask", "ask", "ask", "ask", "ask"], "root")
})

test("matrix: self-improve paths — ask at L0–L3, JEV at L4", () => {
  expectRow("edit plugin", "edit", { filePath: ".opencode/plugin/lib/autonomy.ts" }, ["ask", "ask", "ask", "ask", "ask"], "self-improve", [4])
  expectRow("write config", "write", { filePath: "opencode.json" }, ["ask", "ask", "ask", "ask", "ask"], "self-improve", [4])
  expectRow(
    "sed plugin",
    "bash",
    { command: "sed -i 's/a/b/' .opencode/plugin/lib/knowledge.ts" },
    ["ask", "ask", "ask", "ask", "ask"],
    "self-improve",
    [4],
  )
})

test("matrix: borderline — L0 ask, L1–L3 JEV-ask, L4 allow", () => {
  expectRow("node build", "bash", { command: "node build.js" }, ["ask", "ask", "ask", "ask", "allow"], "borderline", [1, 2, 3])
  expectRow("unknown tool", "frobnicate", { x: 1 }, ["ask", "ask", "ask", "ask", "allow"], "borderline", [1, 2, 3])
  expectRow("webfetch", "webfetch", { url: "https://x" }, ["ask", "ask", "ask", "ask", "allow"], "borderline", [1, 2, 3])
  expectRow("redirect write", "bash", { command: "echo hi > notes.txt" }, ["ask", "ask", "ask", "ask", "allow"], "borderline", [1, 2, 3])
})

// ---------------------------------------------------------------------------
// Level normalization (fail closed to L0) + fingerprint helper.

test("invalid levels fail closed to L0", () => {
  for (const bad of [99, -1, 2.5, NaN, "3" as unknown as number, null as unknown as number]) {
    const c = classifyCall("edit", { filePath: "src/app.ts" }, bad)
    assert.equal(c.verdict, "ask", `level ${String(bad)} must fail closed`)
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
  assert.match(autonomyDirective(0), /^\[autonomy\] level 0 \(Off\) — .*; irreversibility floor always applies$/)
  assert.match(autonomyDirective(1), /^\[autonomy\] level 1 \(Conservative\) — /)
  assert.match(autonomyDirective(2), /^\[autonomy\] level 2 \(Knowledge\) — /)
  assert.match(autonomyDirective(3), /^\[autonomy\] level 3 \(Working\) — /)
  assert.match(autonomyDirective(4), /^\[autonomy\] level 4 \(Autonomous\) — /)
  // Invalid levels fail closed to the strictest line.
  assert.match(autonomyDirective(99), /^\[autonomy\] level 0 \(Off\) — /)
  assert.match(autonomyDirective("x"), /^\[autonomy\] level 0 \(Off\) — /)
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
