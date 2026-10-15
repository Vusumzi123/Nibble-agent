import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { tempHome, writeSection } from "./test-utils.ts"

// Isolate the state file: point HOME at a throwaway dir BEFORE the hook module
// computes its top-level paths.
const TEST_HOME = tempHome("khook-home-")

const { default: createHook } = await import("../knowledge-hook.ts")
const { automationChildSessions } = await import("../lib/automation.ts")
const { recordIssue, recordWrite, resetVerification } = await import("../lib/verification.ts")

// Project-local roots: logs under <project>/.opencode/logs, hook state under
// <project>/.opencode/state. Every test uses a fresh project dir, so no state
// leaks between them (a prior cycle's `lastDrainAt` cooldown included).
function logFile(dir: string): string {
  return join(dir, ".opencode", "logs", "knowledge-hook.log")
}

function stateFile(dir: string): string {
  return join(dir, ".opencode", "state", "knowledge-hook.json")
}

async function readLog(dir: string): Promise<any[]> {
  try {
    return (await readFile(logFile(dir), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return true
    await delay(5)
  }
  return false
}

async function freshProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "khook-proj-"))
}

function memoryPath(dir: string): string {
  return join(dir, ".opencode", "state", "memory.json")
}

function memEntry(seq: number, user: string, assistant: string, ts = new Date().toISOString()): any {
  return {
    seq,
    session: "ses_seed",
    ts,
    user,
    assistant,
    tags: [],
    salience: null,
    newTag: null,
    hash: "h" + seq,
  }
}

async function seedMemory(dir: string, entries: any[]): Promise<void> {
  const p = memoryPath(dir)
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, entries.length ? JSON.stringify(entries, null, 2) + "\n" : "", "utf8")
}

async function readMem(dir: string): Promise<any[]> {
  try {
    const raw = (await readFile(memoryPath(dir), "utf8")).trim()
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function msg(role: "user" | "assistant", id: string, text: string) {
  return { info: { role, id }, parts: [{ type: "text", text }] }
}

function makeClient(opts: {
  parentMessages?: any[]
  childId?: string
  childReply?: string
  childReplies?: string[]
  createIds?: string[]
} = {}) {
  const childId = opts.childId ?? "ses_drain_child"
  const calls = { create: 0, prompts: [] as any[], toasts: [] as any[] }
  let idx = 0
  let turn = 0
  const replyFor = (): string | undefined =>
    opts.childReplies
      ? opts.childReplies[Math.min(turn - 1, opts.childReplies.length - 1)]
      : opts.childReply
  return {
    calls,
    session: {
      get: async () => ({ data: {} }),
      messages: async ({ path }: any) => {
        if (path.id === childId) {
          const reply = replyFor()
          if (reply === undefined) return { data: [] }
          return {
            data: [
              {
                info: { role: "assistant", id: "d" + turn },
                parts: [{ type: "text", text: reply }],
              },
            ],
          }
        }
        return { data: opts.parentMessages ?? [] }
      },
      create: async () => {
        calls.create++
        const id = opts.createIds ? opts.createIds[idx++] : childId
        return { data: id ? { id } : {} }
      },
      promptAsync: async (args: any) => {
        calls.prompts.push(args)
        if (args?.path?.id === childId) turn++
        return { response: { ok: true, status: 200 } }
      },
    },
    tui: {
      showToast: async (args: any) => {
        calls.toasts.push(args)
        return { response: { ok: true, status: 200 } }
      },
    },
  }
}

// Fire the parent idle (capture + ingest), wait for the ingest child to appear
// in the shared guard set, fire the child's own idle to resolve the waiter, then
// await the parent cycle.
async function runIngest(hooks: any, parentID: string, childID: string) {
  const parentIdle = hooks.event({
    event: { type: "session.idle", properties: { sessionID: parentID } },
  } as any)
  await waitFor(() => automationChildSessions.has(childID))
  for (let i = 0; i < 400; i++) {
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: childID } },
    } as any)
    if (await Promise.race([parentIdle.then(() => true, () => true), delay(5)])) break
  }
  await parentIdle
}

const DURABLE_USER = "I decided we should install htop"
const DURABLE_ASSISTANT = "run sudo pacman -S htop"

test("captures a completed turn into the memory buffer", async () => {
  automationChildSessions.clear()
  const dir = await freshProject()
  const hooks = await createHook({
    client: makeClient({
      parentMessages: [msg("user", "u1", "Hello there"), msg("assistant", "a1", "Hi back")],
    }),
    directory: dir,
  } as any)
  await delay(20) // let startup catch-up no-op on the empty buffer

  await hooks["chat.message"](
    { sessionID: "ses_cap", agent: "sysop" } as any,
    { parts: [{ type: "text", text: "Hello there" }] } as any,
  )
  await hooks.event({
    event: { type: "session.idle", properties: { sessionID: "ses_cap" } },
  } as any)

  const mem = await readMem(dir)
  assert.equal(mem.length, 1)
  assert.equal(mem[0].seq, 1)
  assert.equal(mem[0].session, "ses_cap")
  assert.equal(mem[0].user, "Hello there")
  assert.equal(mem[0].assistant, "Hi back")
  assert.ok(mem[0].hash)
})

test("re-asks once when the child omits its outcome blocks, then prunes", async () => {
  automationChildSessions.clear()
  const dir = await freshProject()
  const client = makeClient({
    childReplies: [
      "I'll start by examining the candidate notes.", // no outcome fences
      "done\n\n```consolidated\n#1\n#2\n#3\n```",
    ],
  })
  const hooks = await createHook({ client, directory: dir } as any)
  await delay(20)
  await seedMemory(dir, [
    memEntry(1, DURABLE_USER, DURABLE_ASSISTANT),
    memEntry(2, DURABLE_USER, DURABLE_ASSISTANT),
    memEntry(3, DURABLE_USER, DURABLE_ASSISTANT),
  ])

  await runIngest(hooks, "ses_parent", "ses_drain_child")

  assert.deepEqual(await readMem(dir), [])
  // The spawn prompt + the outcome re-ask. The deterministic changelog writer
  // never re-asks: the re-reply omitted the ```log fence, so the hook appended
  // a mechanical (auto) entry instead.
  assert.equal(client.calls.prompts.length, 2)
  const events = await readLog(dir)
  assert.ok(events.some((e) => e.event === "ingest-reask"))
  const logGuard = events.find((e) => e.event === "log-guard")
  assert.ok(logGuard, "expected a log-guard ledger event")
  assert.equal(logGuard.appended, true)
  assert.equal(logGuard.fallback, true)
  const ingest = events.find((e) => e.event === "ingest")
  assert.ok(ingest, "expected an ingest ledger event")
  assert.equal(ingest.outcome.failed, 0)
  assert.equal(ingest.reasked, true)
  assert.deepEqual(ingest.logGuard, {
    reasked: false,
    appended: true,
    fallback: true,
    rotated: false,
    archived: 0,
  })
  assert.ok(typeof ingest.notes === "number")
})

test("log: a child that reports no summary gets a mechanical fallback entry", async () => {
  automationChildSessions.clear()
  resetVerification()
  const dir = await freshProject()
  const client = makeClient({ childReply: "done\n\n```consolidated\n#1\n#2\n#3\n```" })
  const hooks = await createHook({ client, directory: dir } as any)
  await delay(20)
  await seedMemory(dir, [
    memEntry(1, DURABLE_USER, DURABLE_ASSISTANT),
    memEntry(2, DURABLE_USER, DURABLE_ASSISTANT),
    memEntry(3, DURABLE_USER, DURABLE_ASSISTANT),
  ])

  await runIngest(hooks, "ses_parent", "ses_drain_child")

  // Spawn prompt only — the deterministic writer never re-asks.
  assert.equal(client.calls.prompts.length, 1)

  const logPath = join(dir, "Brain", "meta", "log.md")
  const logText = await readFile(logPath, "utf8")
  const today = new Date().toISOString().slice(0, 10)
  assert.match(logText, new RegExp(`^## \\[${today}\\] consolidation \\| batch #1, #2, #3 \\(auto\\)$`, "m"))
  // A fresh file gets the default frontmatter head.
  assert.match(logText, /^---\ntitle: Vault Changelog/m)

  const events = await readLog(dir)
  const guard = events.find((e) => e.event === "log-guard")
  assert.ok(guard)
  assert.equal(guard.appended, true)
  assert.equal(guard.fallback, true)
  assert.equal(guard.rotated, false)
})

test("log: the child's ```log summary is appended deterministically", async () => {
  automationChildSessions.clear()
  resetVerification()
  const dir = await freshProject()
  const reply =
    'done\n\n```consolidated\n#1\n#2\n#3\n```\n```log\n{"title":"Consolidation — Htop install","body":"Created the Htop note."}\n```'
  const client = makeClient({ childReply: reply })
  const hooks = await createHook({ client, directory: dir } as any)
  await delay(20)
  await seedMemory(dir, [
    memEntry(1, DURABLE_USER, DURABLE_ASSISTANT),
    memEntry(2, DURABLE_USER, DURABLE_ASSISTANT),
    memEntry(3, DURABLE_USER, DURABLE_ASSISTANT),
  ])

  await runIngest(hooks, "ses_parent", "ses_drain_child")

  // Spawn prompt only — the summary came back with the outcome blocks.
  assert.equal(client.calls.prompts.length, 1)

  const logPath = join(dir, "Brain", "meta", "log.md")
  const logText = await readFile(logPath, "utf8")
  const today = new Date().toISOString().slice(0, 10)
  assert.match(logText, new RegExp(`^## \\[${today}\\] consolidation \\| Consolidation — Htop install$`, "m"))
  assert.match(logText, /Created the Htop note\./)

  const events = await readLog(dir)
  const guard = events.find((e) => e.event === "log-guard")
  assert.ok(guard)
  assert.equal(guard.appended, true)
  assert.equal(guard.fallback, false)
  const ingest = events.find((e) => e.event === "ingest")
  assert.deepEqual(ingest?.logGuard, {
    reasked: false,
    appended: true,
    fallback: false,
    rotated: false,
    archived: 0,
  })
})

test("ingests a batch, prunes consumed turns, and logs the cycle", async () => {
  automationChildSessions.clear()
  const dir = await freshProject()
  const hooks = await createHook({
    client: makeClient({ childReply: "done\n\n```consolidated\n#1\n#2\n#3\n```" }),
    directory: dir,
  } as any)
  await delay(20)
  await seedMemory(dir, [
    memEntry(1, DURABLE_USER, DURABLE_ASSISTANT),
    memEntry(2, DURABLE_USER, DURABLE_ASSISTANT),
    memEntry(3, DURABLE_USER, DURABLE_ASSISTANT),
  ])

  await runIngest(hooks, "ses_parent", "ses_drain_child")

  assert.deepEqual(await readMem(dir), [])
  const events = await readLog(dir)
  const ingest = events.find((e) => e.event === "ingest")
  assert.ok(ingest, "expected an ingest ledger event")
  assert.equal(ingest.turns, 3)
  assert.equal(ingest.outcome.consolidated, 3)
})

test("drains FIFO: the oldest turns are batched first regardless of file order", async () => {
  automationChildSessions.clear()
  const dir = await freshProject()
  const hooks = await createHook({
    client: makeClient({ childReply: "```consolidated\n#1\n#2\n#3\n```" }),
    directory: dir,
  } as any)
  await delay(20)
  // Seeded out of order; the hook must sort by seq (FIFO) before batching.
  await seedMemory(dir, [
    memEntry(3, DURABLE_USER, DURABLE_ASSISTANT),
    memEntry(1, DURABLE_USER, DURABLE_ASSISTANT),
    memEntry(2, DURABLE_USER, DURABLE_ASSISTANT),
  ])

  await runIngest(hooks, "ses_parent", "ses_drain_child")

  const events = await readLog(dir)
  const ingest = events.find((e) => e.event === "ingest")
  assert.ok(ingest, "expected an ingest ledger event")
  assert.deepEqual(ingest.batch, [1, 2, 3])
})

test("prefilter auto-drops trivial turns without spawning a child", async () => {
  automationChildSessions.clear()
  const dir = await freshProject()
  const client = makeClient({})
  const hooks = await createHook({ client, directory: dir } as any)
  await delay(20)
  await seedMemory(dir, [
    memEntry(1, "thanks", "you're welcome"),
    memEntry(2, "ok", "sure"),
    memEntry(3, "cheers", "anytime"),
  ])

  await hooks.event({
    event: { type: "session.idle", properties: { sessionID: "ses_parent" } },
  } as any)

  assert.deepEqual(await readMem(dir), [])
  assert.equal(client.calls.create, 0)
  const events = await readLog(dir)
  assert.ok(events.some((e) => e.event === "prefilter-skip"))
})

test("retains turns when the write guard reports an unresolved issue", async () => {
  automationChildSessions.clear()
  resetVerification()
  const dir = await freshProject()
  const client = makeClient({ childReply: "done\n\n```consolidated\n#1\n#2\n#3\n```" })
  const hooks = await createHook({ client, directory: dir } as any)
  await delay(20)
  await seedMemory(dir, [
    memEntry(1, DURABLE_USER, DURABLE_ASSISTANT),
    memEntry(2, DURABLE_USER, DURABLE_ASSISTANT),
    memEntry(3, DURABLE_USER, DURABLE_ASSISTANT),
  ])
  recordIssue("ses_drain_child", {
    path: "Brain/X.md",
    kind: "escaped-wikilink",
    detail: "repair write failed",
    repaired: false,
  })

  await runIngest(hooks, "ses_parent", "ses_drain_child")

  assert.equal((await readMem(dir)).length, 3)
  const events = await readLog(dir)
  assert.ok(events.some((e) => e.event === "ingest-verification-blocked"))
  // The failure is surfaced as a deduped TUI toast (not a transcript injection).
  assert.equal(client.calls.toasts.length, 1)
  assert.equal(client.calls.toasts[0].body.variant, "warning")
  assert.match(client.calls.toasts[0].body.message, /write verification incomplete/)
  resetVerification()
})

test("an ambiguous write-guard issue does not block the drain", async () => {
  automationChildSessions.clear()
  resetVerification()
  const dir = await freshProject()
  const client = makeClient({ childReply: "done\n\n```consolidated\n#1\n#2\n#3\n```" })
  const hooks = await createHook({ client, directory: dir } as any)
  await delay(20)
  await seedMemory(dir, [
    memEntry(1, DURABLE_USER, DURABLE_ASSISTANT),
    memEntry(2, DURABLE_USER, DURABLE_ASSISTANT),
    memEntry(3, DURABLE_USER, DURABLE_ASSISTANT),
  ])
  // The exact false positive that wedged the live FIFO head: the guard could
  // not prove the bullet rewrite was serializer-only. The write already
  // landed, so the batch must still be pruned.
  recordIssue("ses_drain_child", {
    path: "Dev/Retrieval Gate Failure Diagnosis.md",
    kind: "ambiguous",
    detail: "write changed bullet markers or content in a way the guard could not safely repair",
    repaired: false,
  })

  await runIngest(hooks, "ses_parent", "ses_drain_child")

  assert.deepEqual(await readMem(dir), [])
  const events = await readLog(dir)
  assert.equal(events.some((e) => e.event === "ingest-verification-blocked"), false)
  const ingest = events.find((e) => e.event === "ingest")
  assert.equal(ingest?.outcome.consolidated, 3)
  resetVerification()
})

test("write-receipt fallback prunes the batch when neither reply nor re-ask reported", async () => {
  automationChildSessions.clear()
  resetVerification()
  const dir = await freshProject()
  // Both the initial reply and the outcome re-ask come back without fences…
  const client = makeClient({
    childReplies: [
      "I examined the notes.", // no outcome fences
      "…still no fences.", // re-ask reply, also nothing
    ],
  })
  const hooks = await createHook({ client, directory: dir } as any)
  await delay(20)
  await seedMemory(dir, [
    memEntry(1, DURABLE_USER, DURABLE_ASSISTANT),
    memEntry(2, DURABLE_USER, DURABLE_ASSISTANT),
    memEntry(3, DURABLE_USER, DURABLE_ASSISTANT),
  ])
  // …but the per-session write receipts prove the child wrote notes.
  recordWrite("ses_drain_child", join(dir, "Brain", "AI", "Some Note.md"))

  await runIngest(hooks, "ses_parent", "ses_drain_child")

  assert.deepEqual(await readMem(dir), [])
  const events = await readLog(dir)
  const fallback = events.find((e) => e.event === "ingest-receipt-fallback")
  assert.ok(fallback, "expected an ingest-receipt-fallback ledger event")
  assert.deepEqual(fallback.batch, [1, 2, 3])
  const ingest = events.find((e) => e.event === "ingest")
  assert.equal(ingest?.outcome.failed, 0)
  assert.equal(ingest?.outcome.consolidated, 3)
  resetVerification()
})

test("a finished child with an empty reply still flows to the re-ask and prunes", async () => {
  automationChildSessions.clear()
  resetVerification()
  const dir = await freshProject()
  // First message: empty final assistant text (the known "child ended on an
  // empty message" failure). Re-ask reply carries the outcome fences.
  const client = makeClient({ childReplies: ["", "done\n\n```consolidated\n#1\n#2\n#3\n```"] })
  const hooks = await createHook({ client, directory: dir } as any)
  await delay(20)
  await seedMemory(dir, [
    memEntry(1, DURABLE_USER, DURABLE_ASSISTANT),
    memEntry(2, DURABLE_USER, DURABLE_ASSISTANT),
    memEntry(3, DURABLE_USER, DURABLE_ASSISTANT),
  ])

  await runIngest(hooks, "ses_parent", "ses_drain_child")

  assert.deepEqual(await readMem(dir), [])
  const events = await readLog(dir)
  assert.ok(events.some((e) => e.event === "ingest-no-reply"), "expected an ingest-no-reply event")
  assert.ok(events.some((e) => e.event === "ingest-reask"))
  const ingest = events.find((e) => e.event === "ingest")
  assert.equal(ingest?.outcome.failed, 0)
})

test("quarantines a turn after max_attempts failed drains", async () => {
  automationChildSessions.clear()
  resetVerification()
  const dir = await freshProject()
  await writeSection(dir, "knowledge", [
    "enabled: true",
    "min_ready_turns: 1",
    "max_attempts: 2",
    "drain_cooldown_ms: 0",
    "max_turn_age: 0",
    "skip_triage: false",
    "log_guard: false",
    "tag_gate: false",
  ])
  // The child never reports anything and leaves no write receipts, so the
  // cycle fails and retains — the retry budget must eventually quarantine.
  const client = makeClient({ childReply: "hmm." })
  const hooks = await createHook({ client, directory: dir } as any)
  await delay(20)
  await seedMemory(dir, [memEntry(1, DURABLE_USER, DURABLE_ASSISTANT)])

  // Drain cycle 1: fails, attempts -> 1 (retained).
  await runIngest(hooks, "ses_parent", "ses_drain_child")
  assert.equal((await readMem(dir)).length, 1)
  assert.equal((await readMem(dir))[0].attempts, 1)

  // Drain cycle 2: fails, attempts -> 2 == max_attempts -> quarantined.
  await runIngest(hooks, "ses_parent", "ses_drain_child")
  assert.deepEqual(await readMem(dir), [])

  const events = await readLog(dir)
  const quarantine = events.find((e) => e.event === "ingest-quarantine")
  assert.ok(quarantine, "expected an ingest-quarantine ledger event")
  assert.equal(quarantine.reason, "outcome-missing")
  assert.deepEqual(quarantine.turns, [1])
  assert.equal(quarantine.maxAttempts, 2)
  // The quarantine is surfaced as a TUI toast.
  assert.ok(
    client.calls.toasts.some((t: any) => /quarantined 1 turn/.test(t.body.message)),
    "expected a quarantine toast",
  )
  resetVerification()
})

test("temporal_search returns rendered hits from the buffer", async () => {
  automationChildSessions.clear()
  const dir = await freshProject()
  const hooks = await createHook({ client: makeClient({}), directory: dir } as any)
  await delay(20)
  await seedMemory(dir, [
    memEntry(1, "widget alpha install", "reply"),
    memEntry(2, "unrelated note", "reply"),
  ])

  const out = await hooks.tool.temporal_search.execute({ query: "widget" }, { agent: "rag-search" } as any)
  assert.match(String(out), /#1/)
  assert.match(String(out), /widget alpha/)
})

test("startup catch-up ingests a backlog left by a previous exit", async () => {
  automationChildSessions.clear()
  const dir = await freshProject()
  await seedMemory(dir, [
    memEntry(1, DURABLE_USER, DURABLE_ASSISTANT),
    memEntry(2, DURABLE_USER, DURABLE_ASSISTANT),
    memEntry(3, DURABLE_USER, DURABLE_ASSISTANT),
  ])
  const hooks = await createHook({
    client: makeClient({
      childId: "ses_child_startup",
      childReply: "done\n\n```consolidated\n#1\n#2\n#3\n```",
      createIds: ["ses_coord", "ses_child_startup"],
    }),
    directory: dir,
  } as any)

  await waitFor(() => automationChildSessions.has("ses_child_startup"))
  for (let i = 0; i < 400 && existsSync(memoryPath(dir)); i++) {
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "ses_child_startup" } },
    } as any)
    await delay(5)
  }
  assert.equal(await waitFor(() => !existsSync(memoryPath(dir))), true)
})

test("max_turn_age: 0 disables the age bound (backlog below min_ready_turns stays)", async () => {
  automationChildSessions.clear()
  const dir = await freshProject()
  await writeSection(dir, "knowledge", [
    "enabled: true",
    "min_ready_turns: 3",
    "max_turn_age: 0",
    "drain_cooldown_ms: 0",
  ])
  const client = makeClient({})
  const hooks = await createHook({ client, directory: dir } as any)
  await delay(20)
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  await seedMemory(dir, [memEntry(1, DURABLE_USER, DURABLE_ASSISTANT, old)])

  await hooks.event({
    event: { type: "session.idle", properties: { sessionID: "ses_parent" } },
  } as any)

  assert.equal((await readMem(dir)).length, 1)
  assert.equal(client.calls.create, 0)
})

test("a stale turn is force-eligible below min_ready_turns and bypasses cooldown", async () => {
  automationChildSessions.clear()
  const dir = await freshProject()
  await writeSection(dir, "knowledge", [
    "enabled: true",
    "min_ready_turns: 3",
    "max_turn_age: 1",
    "drain_cooldown_ms: 60000",
  ])
  const hooks = await createHook({
    client: makeClient({ childReply: "done\n\n```consolidated\n#1\n```" }),
    directory: dir,
  } as any)
  await delay(20)
  // A recent cycle time would normally suppress a new pass; the stale turn must
  // bypass the cooldown.
  await mkdir(dirname(stateFile(dir)), { recursive: true })
  await writeFile(stateFile(dir), JSON.stringify({ lastDrainAt: Date.now() }), "utf8")
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  await seedMemory(dir, [memEntry(1, DURABLE_USER, DURABLE_ASSISTANT, old)])

  await runIngest(hooks, "ses_parent", "ses_drain_child")

  assert.deepEqual(await readMem(dir), [])
})
