import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tempDir, tempHome } from "./test-utils.ts"
import { automationChildSessions } from "./automation.ts"

// Isolate HOME before the hook module resolves anything home-scoped.
const TEST_HOME = tempHome("aghook-home-")
void TEST_HOME
const { default: createHook } = await import("../autonomy-gate.ts")

async function project(level?: number | string, extra?: string[], decisions?: string[]): Promise<string> {
  const dir = await tempDir("aghook-proj-")
  await mkdir(join(dir, ".opencode"), { recursive: true })
  const lines = ["autonomy:"]
  if (level !== undefined) lines.push(`  level: ${level}`)
  for (const e of extra ?? []) lines.push(`  ${e}`)
  if (decisions) {
    lines.push("", "decisions:")
    for (const d of decisions) lines.push(`  ${d}`)
  }
  if (lines.length > 1) {
    await writeFile(join(dir, ".opencode", "sysop-config.yaml"), [...lines, ""].join("\n"), "utf8")
  }
  return dir
}

async function readGateLog(dir: string): Promise<any[]> {
  try {
    const raw = await readFile(join(dir, ".opencode", "logs", "autonomy-gate.log"), "utf8")
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

async function transform(hooks: any, system: string[] = []): Promise<string[]> {
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_1" } as any, { system } as any)
  return system
}

async function before(hooks: any, tool: string, args: unknown, sessionID = "ses_1"): Promise<void> {
  await hooks["tool.execute.before"]({ sessionID, tool, args } as any, undefined as any)
}

test("transform pushes the [autonomy] line for the configured level", async () => {
  const dir = await project(3)
  const hooks = await createHook({ directory: dir } as any)
  const system = await transform(hooks)
  assert.equal(system.length, 1)
  assert.match(system[0], /^\[autonomy\] level 3 \(Working\) — .*; irreversibility floor always applies$/)
  await rm(dir, { recursive: true, force: true })
})

test("a level flip is reflected on the next turn without re-creating the hook", async () => {
  const dir = await project(3)
  const hooks = await createHook({ directory: dir } as any)
  assert.match((await transform(hooks))[0], /level 3 \(Working\)/)
  await writeFile(
    join(dir, ".opencode", "sysop-config.yaml"),
    ["autonomy:", "  level: 0", ""].join("\n"),
    "utf8",
  )
  assert.match((await transform(hooks))[0], /level 0 \(Plan\)/)
  await rm(dir, { recursive: true, force: true })
})

test("shadow pass records verdict lines with level, verdict, reason, fingerprint", async () => {
  const dir = await project(2, ["gate_mode: shadow"])
  const hooks = await createHook({ directory: dir } as any)
  await before(hooks, "bash", { command: "echo hi" })
  await before(hooks, "bash", { command: "rm -rf /" })
  const lines = await readGateLog(dir)
  assert.equal(lines.length, 2)

  assert.equal(lines[0].event, "verdict")
  assert.equal(lines[0].level, 2)
  assert.equal(lines[0].tool, "bash")
  assert.equal(lines[0].verdict, "allow") // read-only bash at L2
  assert.equal(lines[0].mode, "shadow")
  assert.equal(typeof lines[0].reason, "string")
  assert.match(lines[0].fingerprint, /^[0-9a-f]{40}$/)

  assert.equal(lines[1].verdict, "deny") // irreversibility floor
  assert.equal(lines[1].level, 2)
  assert.match(lines[1].reason, /irreversibility floor/)
  await rm(dir, { recursive: true, force: true })
})

test("the stamped level in the verdict log flips with the config", async () => {
  const dir = await project(4, ["gate_mode: shadow"])
  const hooks = await createHook({ directory: dir } as any)
  await before(hooks, "bash", { command: "echo one" })
  await writeFile(
    join(dir, ".opencode", "sysop-config.yaml"),
    ["autonomy:", "  level: 0", "  gate_mode: shadow", ""].join("\n"),
    "utf8",
  )
  await before(hooks, "bash", { command: "echo two" })
  const lines = await readGateLog(dir)
  assert.equal(lines.length, 2)
  assert.equal(lines[0].level, 4)
  assert.equal(lines[0].verdict, "allow")
  assert.equal(lines[1].level, 0)
  assert.equal(lines[1].verdict, "allow") // read-only bash is free at L0 (Plan mode)
  await rm(dir, { recursive: true, force: true })
})

test("shadow never throws: malformed inputs and a broken config resolve cleanly", async () => {
  const dir = await project("banana", ["gate_mode: shadow"]) // invalid level -> code default
  const hooks = await createHook({ directory: dir } as any)
  await before(hooks, "edit", null)
  await before(hooks, "bash", undefined)
  await before(hooks, "frobnicate", { weird: true })
  await before(hooks, "", {})
  // Transform with a missing output object must resolve too.
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_1" } as any, {} as any)
  const system = await transform(hooks)
  // Invalid config falls back to the code default level (1, Build).
  assert.match(system[0], /^\[autonomy\] level 1 \(Build\)/)
  const lines = await readGateLog(dir)
  assert.equal(lines.length, 4)
  for (const line of lines) {
    assert.equal(line.event, "verdict")
    assert.match(line.fingerprint, /^[0-9a-f]{40}$/)
  }
  await rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Card E — enforcement + gate_mode kill switch.

test("gate mode (default) enforces the matrix: allow passes, ask throws, deny refuses", async () => {
  const dir = await project(2) // no gate_mode line -> default gate
  const hooks = await createHook({ directory: dir } as any)

  // allow rows pass.
  await before(hooks, "bash", { command: "echo hi" }) // readonly-bash @L2
  await before(hooks, "read", { filePath: "README.md" }) // pure-read
  await before(hooks, "edit", { filePath: "src/app.ts" }) // project-write @L2

  // ask rows throw an instructive error naming the level and the flow.
  await assert.rejects(
    () => before(hooks, "bash", { command: "rm -rf /tmp/scratch" }),
    /\[autonomy\] ASK at level 2 \(Knowledge\).*destructive class.*--execute/s,
  )
  await assert.rejects(
    () => before(hooks, "bash", { command: "sudo systemctl restart nginx" }),
    /\[autonomy\] ASK at level 2 \(Knowledge\).*root command/s,
  )

  // deny (floor) is a hard refusal — never approvable, never retried.
  await assert.rejects(
    () => before(hooks, "bash", { command: "mkfs.ext4 /dev/sdb1" }),
    /\[autonomy\] DENIED at level 2 \(Knowledge\).*irreversibility floor.*never approvable.*Do not retry/s,
  )

  // Every attempt was logged, stamped with the enforcing mode.
  const lines = await readGateLog(dir)
  assert.equal(lines.length, 6)
  assert.deepEqual(
    lines.map((l) => l.verdict),
    ["allow", "allow", "allow", "ask", "ask", "deny"],
  )
  for (const line of lines) assert.equal(line.mode, "gate")
  await rm(dir, { recursive: true, force: true })
})

test("allow rows open up as the dial rises (project write asks at L2, passes at L3)", async () => {
  const dir = await project(3)
  const hooks = await createHook({ directory: dir } as any)
  await before(hooks, "edit", { filePath: "src/app.ts" }) // project-write @L3 -> allow
  await assert.rejects(
    () => before(hooks, "bash", { command: "pacman -R htop" }),
    /\[autonomy\] ASK at level 3 \(Working\)/,
  )
  await rm(dir, { recursive: true, force: true })
})

test("gate_mode: shadow logs without blocking (the kill switch)", async () => {
  const dir = await project(2, ["gate_mode: shadow"])
  const hooks = await createHook({ directory: dir } as any)
  // Floor + ask both resolve — nothing blocks in shadow.
  await before(hooks, "bash", { command: "mkfs.ext4 /dev/sdb1" })
  await before(hooks, "bash", { command: "rm -rf /tmp/scratch" })
  await before(hooks, "edit", { filePath: "src/app.ts" })
  const lines = await readGateLog(dir)
  assert.equal(lines.length, 3)
  assert.deepEqual(
    lines.map((l) => l.verdict),
    ["deny", "ask", "allow"],
  )
  for (const line of lines) assert.equal(line.mode, "shadow")
  // A gate_mode flip applies hot — no hook re-creation.
  await writeFile(
    join(dir, ".opencode", "sysop-config.yaml"),
    ["autonomy:", "  level: 2", "  gate_mode: gate", ""].join("\n"),
    "utf8",
  )
  await assert.rejects(() => before(hooks, "bash", { command: "mkfs.ext4 /dev/sdb1" }), /DENIED/)
  await rm(dir, { recursive: true, force: true })
})

test("automationChildSessions bypass the gate entirely (settled decision #3)", async () => {
  const dir = await project(0) // strictest level — would ask/deny everything
  const hooks = await createHook({ directory: dir } as any)
  automationChildSessions.add("ses_automation_child")
  try {
    await before(hooks, "bash", { command: "mkfs.ext4 /dev/sdb1" }, "ses_automation_child")
    await before(hooks, "edit", { filePath: "src/app.ts" }, "ses_automation_child")
    // No verdict lines — the child never reaches the classifier.
    assert.equal((await readGateLog(dir)).length, 0)
  } finally {
    automationChildSessions.delete("ses_automation_child")
  }
  // Human sessions stay gated after the child leaves the set.
  await assert.rejects(() => before(hooks, "edit", { filePath: "src/app.ts" }), /DENIED at level 0 \(Plan\)/)
  await rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// gate_scope — sub-agent children (parentID set) are floor-only under `main`.

/** Minimal opencode client: sessions in `childIDs` report a parentID. */
function childClient(childIDs: string[]): any {
  return {
    session: {
      get: async ({ path }: any) => ({
        data: childIDs.includes(path.id)
          ? { id: path.id, parentID: "ses_parent", agent: "sub" }
          : { id: path.id },
      }),
      messages: async () => ({ data: [] }),
    },
  }
}

test("gate_scope main (default): a sub-agent child skips ask rows but keeps the floor", async () => {
  const dir = await project(1) // Build mode: destructive asks, floor denies
  const hooks = await createHook({ directory: dir, client: childClient(["ses_child"]) } as any)

  // Child: ask rows pass without approval...
  await before(hooks, "bash", { command: "rm -rf /tmp/scratch" }, "ses_child") // destructive @L1
  // ...but the irreversibility floor still refuses (floor is scope-independent).
  await assert.rejects(
    () => before(hooks, "bash", { command: "mkfs.ext4 /dev/sdb1" }, "ses_child"),
    /\[autonomy\] DENIED at level 1 \(Build\)/,
  )

  // The human (top-level) session stays fully gated.
  await assert.rejects(() => before(hooks, "bash", { command: "rm -rf /tmp/scratch" }), /ASK at level 1 \(Build\)/)

  // Every attempt was logged, stamped with scope + child.
  const lines = await readGateLog(dir)
  assert.equal(lines.length, 3)
  assert.deepEqual(
    lines.map((l) => l.verdict),
    ["ask", "deny", "ask"],
  )
  assert.deepEqual(
    lines.map((l) => l.child),
    [true, true, false],
  )
  for (const line of lines) assert.equal(line.scope, "main")
  await rm(dir, { recursive: true, force: true })
})

test("gate_scope all: sub-agent children are gated like everyone else", async () => {
  const dir = await project(1, ["gate_scope: all"])
  const hooks = await createHook({ directory: dir, client: childClient(["ses_child"]) } as any)
  await assert.rejects(
    () => before(hooks, "bash", { command: "rm -rf /tmp/scratch" }, "ses_child"),
    /ASK at level 1 \(Build\)/,
  )
  const lines = await readGateLog(dir)
  assert.equal(lines[0].child, true)
  assert.equal(lines[0].scope, "all")
  await rm(dir, { recursive: true, force: true })
})

test("gate_scope main: sub-agent children get no [autonomy] line", async () => {
  const dir = await project(3)
  const hooks = await createHook({ directory: dir, client: childClient(["ses_child"]) } as any)
  // Human session: the directive line lands as usual.
  assert.match((await transform(hooks))[0], /level 3 \(Working\)/)
  // Child session: the dial does not govern it, so no line.
  const childSystem: string[] = []
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_child" } as any, { system: childSystem } as any)
  assert.equal(childSystem.length, 0)
  await rm(dir, { recursive: true, force: true })
})

test("a session whose child lookup fails stays gated (fail-closed)", async () => {
  const dir = await project(0)
  const brokenClient = {
    session: {
      get: async () => {
        throw new Error("lookup down")
      },
      messages: async () => ({ data: [] }),
    },
  }
  const hooks = await createHook({ directory: dir, client: brokenClient } as any)
  await assert.rejects(
    () => before(hooks, "edit", { filePath: "src/app.ts" }, "ses_1"),
    /DENIED at level 0 \(Plan\)/,
  )
  await rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Card F — pending-ask approval flow.

async function confirm(hooks: any, text: string, sessionID = "ses_1"): Promise<void> {
  await hooks["chat.message"]({ sessionID } as any, { parts: [{ type: "text", text }] } as any)
}

test("ask -> retry denied -> proceed -> retry passes once -> third denied", async () => {
  const dir = await project(1) // L1 Build: destructive asks
  const hooks = await createHook({ directory: dir } as any)
  const attempt = () => before(hooks, "bash", { command: "rm -rf /tmp/scratch" })

  await assert.rejects(attempt, /\[autonomy\] ASK at level 1 \(Build\)/)
  // Retry before the confirm: still denied.
  await assert.rejects(attempt, /\[autonomy\] ASK at level 1 \(Build\)/)

  // The user's strict confirm approves the exact pending call.
  await confirm(hooks, "yes")
  await attempt() // passes once

  // Third attempt: approval was one-shot — asks again.
  await assert.rejects(attempt, /\[autonomy\] ASK at level 1 \(Build\)/)
  await rm(dir, { recursive: true, force: true })
})

test("any other user text does not approve the pending ask", async () => {
  const dir = await project(1)
  const hooks = await createHook({ directory: dir } as any)
  const attempt = () => before(hooks, "bash", { command: "rm -rf /tmp/scratch" })
  await assert.rejects(attempt, /ASK/)
  await confirm(hooks, "looks good to me")
  await assert.rejects(attempt, /ASK/) // still not approved
  await rm(dir, { recursive: true, force: true })
})

test("approval binds to the exact call — a different retry still asks", async () => {
  const dir = await project(1)
  const hooks = await createHook({ directory: dir } as any)
  await assert.rejects(() => before(hooks, "bash", { command: "rm -rf /tmp/a" }), /ASK/)
  await confirm(hooks, "proceed")
  // Different call (different fingerprint): latest-only replaces the pending.
  await assert.rejects(() => before(hooks, "bash", { command: "rm -rf /tmp/b" }), /ASK/)
  // The original approval is gone too (latest-only).
  await assert.rejects(() => before(hooks, "bash", { command: "rm -rf /tmp/a" }), /ASK/)
  await rm(dir, { recursive: true, force: true })
})

test("floor is never approvable: a confirm does not unlock a deny", async () => {
  const dir = await project(1)
  const hooks = await createHook({ directory: dir } as any)
  const attempt = () => before(hooks, "bash", { command: "mkfs.ext4 /dev/sdb1" })
  await assert.rejects(attempt, /\[autonomy\] DENIED at level 1 \(Build\)/)
  await confirm(hooks, "yes")
  await assert.rejects(attempt, /\[autonomy\] DENIED at level 1 \(Build\)/)
  // No pending was ever recorded for the floor attempt.
  const lines = await readGateLog(dir)
  assert.ok(lines.every((l) => l.verdict === "deny"))
  await rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Card G — JEV borderline escalation (mock spawner seam).

type Spawner = (args: any) => Promise<{ code: number; stdout: string; stderr: string }>

function choiceSpawner(value: string, opts: { abstained?: boolean } = {}): Spawner {
  return async () => ({
    code: 0,
    stdout: JSON.stringify({
      kind: "choice",
      value,
      confidence: 0.9,
      probabilities: {},
      abstained: opts.abstained ?? false,
    }),
    stderr: "",
  })
}

const JEV_DECISIONS = ["enabled: true", "provider: openjev"]

test("JEV: a confident provider 'allow' passes a borderline call; the criteria reach the bridge", async () => {
  const dir = await project(1, [], JEV_DECISIONS)
  let received = ""
  const spawner: Spawner = async (args) => {
    received = args.request
    return choiceSpawner("allow")(args)
  }
  const hooks = await createHook({ directory: dir, spawner } as any)

  await before(hooks, "bash", { command: "node build.js" }) // borderline @L1 -> JEV allows
  assert.ok(received.includes('"kind":"choice"'))
  assert.ok(received.includes('"candidates":["allow","ask"]'))
  assert.ok(received.includes("safe to run without the user's confirmation")) // default assertion
  assert.ok(received.includes("node build.js"))

  const lines = await readGateLog(dir)
  const jevLine = lines.find((l) => l.event === "jev")
  assert.ok(jevLine)
  assert.equal(jevLine.approved, true)
  assert.equal(jevLine.level, 1)
  await rm(dir, { recursive: true, force: true })
})

test("JEV: a provider 'ask' falls through to the pending-ask flow", async () => {
  const dir = await project(1, [], JEV_DECISIONS)
  const hooks = await createHook({ directory: dir, spawner: choiceSpawner("ask") } as any)
  await assert.rejects(() => before(hooks, "bash", { command: "node build.js" }), /ASK at level 1 \(Build\)/)
  const jevLine = (await readGateLog(dir)).find((l) => l.event === "jev")
  assert.equal(jevLine?.approved, false)
  await rm(dir, { recursive: true, force: true })
})

test("JEV fail-closed: error, abstain, and timeout-shaped failures all mean ask", async () => {
  // (a) bridge error / timeout kill (spawnBridge reports both as code != 0)
  {
    const dir = await project(1, [], JEV_DECISIONS)
    const hooks = await createHook({
      directory: dir,
      spawner: (async () => ({ code: 1, stdout: "", stderr: "bridge timed out after 8000ms" })) as Spawner,
    } as any)
    await assert.rejects(() => before(hooks, "bash", { command: "node build.js" }), /ASK at level 1/)
    await rm(dir, { recursive: true, force: true })
  }
  // (b) abstain
  {
    const dir = await project(1, [], JEV_DECISIONS)
    const hooks = await createHook({ directory: dir, spawner: choiceSpawner(null as unknown as string, { abstained: true }) } as any)
    await assert.rejects(() => before(hooks, "bash", { command: "node build.js" }), /ASK at level 1/)
    await rm(dir, { recursive: true, force: true })
  }
  // (c) spawn throw (provider wraps it into an error-carrying abstain)
  {
    const dir = await project(1, [], JEV_DECISIONS)
    const hooks = await createHook({
      directory: dir,
      spawner: (async () => {
        throw new Error("bridge exploded")
      }) as Spawner,
    } as any)
    await assert.rejects(() => before(hooks, "bash", { command: "node build.js" }), /ASK at level 1/)
    await rm(dir, { recursive: true, force: true })
  }
})

test("JEV: decisions disabled fails closed to ask even when the provider would allow", async () => {
  const dir = await project(1, [], ["enabled: false"])
  let calls = 0
  const spawner: Spawner = async (args) => {
    calls++
    return choiceSpawner("allow")(args)
  }
  const hooks = await createHook({ directory: dir, spawner } as any)
  await assert.rejects(() => before(hooks, "bash", { command: "node build.js" }), /ASK at level 1/)
  assert.equal(calls, 0) // gate is null — the spawner is never reached
  await rm(dir, { recursive: true, force: true })
})

test("JEV is consulted only for jev-flagged rows: plain asks and the floor never reach it", async () => {
  const dir = await project(2, [], JEV_DECISIONS)
  let calls = 0
  const spawner: Spawner = async (args) => {
    calls++
    return choiceSpawner("allow")(args)
  }
  const hooks = await createHook({ directory: dir, spawner } as any)
  // Destructive at L2: ask WITHOUT jev — must ask despite the allow-spawner.
  await assert.rejects(() => before(hooks, "bash", { command: "rm -rf /tmp/scratch" }), /ASK at level 2/)
  // Floor: deny — never consults JEV.
  await assert.rejects(() => before(hooks, "bash", { command: "mkfs.ext4 /dev/sdb1" }), /DENIED at level 2/)
  assert.equal(calls, 0)
  await rm(dir, { recursive: true, force: true })
})

test("JEV: the user's confirm outranks the model and is not re-consulted on the approved retry", async () => {
  const dir = await project(1, [], JEV_DECISIONS)
  let calls = 0
  const spawner: Spawner = async (args) => {
    calls++
    return choiceSpawner("ask")(args) // model says ask
  }
  const hooks = await createHook({ directory: dir, spawner } as any)
  await assert.rejects(() => before(hooks, "bash", { command: "node build.js" }), /ASK at level 1/)
  assert.equal(calls, 1)
  await confirm(hooks, "yes")
  await before(hooks, "bash", { command: "node build.js" }) // human-approved retry passes
  assert.equal(calls, 1) // JEV was not asked again
  await rm(dir, { recursive: true, force: true })
})

test("JEV: the autonomy assertion can be overridden via decision-prompts.yaml", async () => {
  const dir = await project(1, [], JEV_DECISIONS)
  await writeFile(
    join(dir, ".opencode", "decision-prompts.yaml"),
    ["autonomy:", '  assertion: "CUSTOM-ASSERTION: let it pass."', ""].join("\n"),
    "utf8",
  )
  let received = ""
  const spawner: Spawner = async (args) => {
    received = args.request
    return choiceSpawner("allow")(args)
  }
  const hooks = await createHook({ directory: dir, spawner } as any)
  await before(hooks, "bash", { command: "node build.js" })
  assert.ok(received.includes("CUSTOM-ASSERTION: let it pass."))
  await rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Batch approval (per-turn manifest).

const BATCH_MANIFEST = ["```autonomy-batch", "destructive rm -rf /tmp/scratch", "```"].join("\n")

/** Client whose last assistant message carries the given text (the manifest). */
function manifestClient(text: string): any {
  return {
    session: {
      get: async ({ path }: any) => ({ data: { id: path.id } }),
      messages: async () => ({ data: [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }] }),
    },
  }
}

test("a confirm with a manifest mints a grant: declared calls pass, undeclared still ask", async () => {
  const dir = await project(1) // Build mode: destructive asks
  const hooks = await createHook({ directory: dir, client: manifestClient(BATCH_MANIFEST) } as any)

  // First call asks (no grant yet).
  await assert.rejects(() => before(hooks, "bash", { command: "rm -rf /tmp/scratch" }), /ASK at level 1 \(Build\)/)

  // Confirm mints the grant from the assistant's manifest.
  await confirm(hooks, "yes")

  // The exact retry passes via the one-shot approval; a sibling declared call
  // (matching the target substring) passes via the grant.
  await before(hooks, "bash", { command: "rm -rf /tmp/scratch" })
  await before(hooks, "bash", { command: "rm -rf /tmp/scratch/sub" })

  // An undeclared destructive call still asks (and the grant budget is spent).
  await assert.rejects(() => before(hooks, "bash", { command: "rm -rf /tmp/other" }), /ASK at level 1 \(Build\)/)

  const lines = await readGateLog(dir)
  const minted = lines.find((l) => l.event === "grant-mint")
  assert.ok(minted)
  assert.equal(minted.entries, 1)
  assert.equal(minted.budget, 1)
  assert.ok(lines.some((l) => l.event === "grant-use"))
  await rm(dir, { recursive: true, force: true })
})

test("a non-confirm user message clears the grant (turn boundary)", async () => {
  const dir = await project(1)
  const hooks = await createHook({ directory: dir, client: manifestClient(BATCH_MANIFEST) } as any)

  await assert.rejects(() => before(hooks, "bash", { command: "rm -rf /tmp/scratch" }), /ASK/)
  await confirm(hooks, "yes") // mints the grant

  // A new non-confirm message ends the batch grant before it is used.
  await confirm(hooks, "actually, let's do something else")
  await assert.rejects(() => before(hooks, "bash", { command: "rm -rf /tmp/scratch/sub" }), /ASK/)
  await rm(dir, { recursive: true, force: true })
})

test("the floor still denies even under an active batch grant", async () => {
  const dir = await project(1)
  const hooks = await createHook({ directory: dir, client: manifestClient(BATCH_MANIFEST) } as any)

  await assert.rejects(() => before(hooks, "bash", { command: "rm -rf /tmp/scratch" }), /ASK/)
  await confirm(hooks, "yes")
  await assert.rejects(() => before(hooks, "bash", { command: "mkfs.ext4 /dev/sdb1" }), /DENIED/)
  await rm(dir, { recursive: true, force: true })
})

test("batch approval is disabled when max_actions is 0 (one-shot only)", async () => {
  const dir = await project(1, ["batch:", "  max_actions: 0"])
  const hooks = await createHook({ directory: dir, client: manifestClient(BATCH_MANIFEST) } as any)

  await assert.rejects(() => before(hooks, "bash", { command: "rm -rf /tmp/scratch" }), /ASK/)
  await confirm(hooks, "yes")
  // Exact retry passes once (one-shot), but no grant is minted.
  await before(hooks, "bash", { command: "rm -rf /tmp/scratch" })
  await assert.rejects(() => before(hooks, "bash", { command: "rm -rf /tmp/scratch/sub" }), /ASK/)
  assert.equal((await readGateLog(dir)).some((l) => l.event === "grant-mint"), false)
  await rm(dir, { recursive: true, force: true })
})
