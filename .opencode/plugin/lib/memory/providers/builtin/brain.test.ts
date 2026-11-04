import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { ChildExecutor, ChildOutcome, ChildRequest } from "../../../drain/child.ts"
import { DEFAULT_DRAIN } from "../../../drain/config.ts"
import { DRAIN_REPORT_TOOL } from "./brain/report.ts"
import { createBrainProvider } from "./brain.ts"
import type { MemoryWriteClient, WriteContext } from "../../types.ts"

const ITEM = {
  title: "Wireguard Restart",
  summary: "Restart wg0 after changing the config.",
  tags: ["linux/network"],
  atoms: ["sudo systemctl restart wg0"],
}

function reportRows(
  itemCount: number,
  consolidated: Array<string | number>,
  skipped: Array<string | number> = [],
  partial = false,
  text = "done",
): unknown[] {
  return [
    {
      info: { role: "assistant", tokens: { input: 10, output: 2 }, cost: 0.01 },
      parts: [
        { type: "text", text },
        {
          type: "tool",
          tool: DRAIN_REPORT_TOOL,
          state: { input: { item_count: itemCount, consolidated, skipped, partial } },
        },
      ],
    },
  ]
}

const RECENT = Date.now() - 3_600_000

function workspace(): Promise<{ directory: string; stateDir: string; vaultDir: string }> {
  return mkdtemp(join(tmpdir(), "memory-brain-")).then(async (root) => {
    const stateDir = join(root, "state")
    const vaultDir = join(root, "vault")
    await mkdir(stateDir, { recursive: true })
    await mkdir(vaultDir, { recursive: true })
    return { directory: root, stateDir, vaultDir }
  })
}

function client(opts: { fail?: boolean } = {}): MemoryWriteClient {
  return {
    session: {
      async create() {
        if (opts.fail) throw new Error("spawn boom")
        return { data: { id: "ses_writer" } }
      },
      async promptAsync() {
        return { response: { ok: true } }
      },
      async messages() {
        return { data: [] }
      },
    },
  }
}

type ExecutorOptions = {
  rows?: unknown[]
  promptRows?: unknown[]
  ok?: boolean
  timedOut?: boolean
  late?: boolean
  error?: string
}

function fakeExecutor(opts: ExecutorOptions = {}): {
  executor: ChildExecutor
  calls: { spawn: ChildRequest[]; prompt: Array<{ sessionID: string; request: ChildRequest }> }
} {
  const calls = {
    spawn: [] as ChildRequest[],
    prompt: [] as Array<{ sessionID: string; request: ChildRequest }>,
  }
  const make = (request: ChildRequest, rows: unknown[] | undefined): ChildOutcome => ({
    jobId: request.id ?? "ses_writer",
    sessionID: "ses_writer",
    phase: opts.timedOut ? "timeout" : opts.ok === false ? "failed" : "complete",
    ok: opts.ok ?? true,
    started: true,
    rows: rows ?? [],
    replies: [],
    late: opts.late ?? false,
    timedOut: opts.timedOut ?? false,
    attempts: 1,
    tokens: 12,
    cost: 0.01,
    spawnMs: 1,
    queueMs: 2,
    runMs: 3,
    steps: 2,
    spanMs: 4,
    modelMs: 3,
    toolMs: 1,
    ...(opts.error ? { error: opts.error } : {}),
  })
  return {
    calls,
    executor: {
      async spawn(request) {
        calls.spawn.push(request)
        return make(request, opts.rows)
      },
      async prompt(sessionID, request) {
        calls.prompt.push({ sessionID, request })
        return make(request, opts.promptRows ?? opts.rows)
      },
      async abort() {},
    },
  }
}

function ctx(
  ws: { directory: string; stateDir: string; vaultDir: string },
  c: MemoryWriteClient,
  executor: ChildExecutor,
): WriteContext {
  return {
    directory: ws.directory,
    vaultDir: ws.vaultDir,
    config: { ...DEFAULT_DRAIN, writer_model: "test/writer" },
    client: c,
    executor,
    searchText: `${ITEM.title}\n${ITEM.summary}\n${ITEM.atoms.join(" ")}`,
  }
}

test("readPlan is the Brain delegation body", () => {
  const provider = createBrainProvider({
    ...{ directory: "/p", stateDir: "/s", vaultDir: "/v" },
    drain: DEFAULT_DRAIN,
    summaryWords: 400,
  })
  const plan = provider.readPlan()!
  assert.match(plan, /rag-search/)
  assert.match(plan, /answer-first synthesis of about 400 words/)
  assert.equal(plan.includes("memory-explorer"), false)
})

test("consolidate owns the prompt/spawn/report contract", async () => {
  const ws = await workspace()
  const provider = createBrainProvider({ ...ws, drain: DEFAULT_DRAIN, summaryWords: 400 })
  const { executor, calls } = fakeExecutor({ rows: reportRows(1, ["#1"]) })

  const result = await provider.consolidate!([ITEM], ctx(ws, client(), executor))

  assert.equal(result.ok, true)
  assert.deepEqual(result.consumed, [1])
  assert.deepEqual(result.skipped, [])
  assert.ok((result.promptBytes ?? 0) > 0)
  assert.equal(result.session, "ses_writer")
  assert.equal(calls.spawn.length, 1)
  assert.match(calls.spawn[0].prompt, /^Consolidation mode\./)
  assert.match(calls.spawn[0].prompt, /### Knowledge item #1/)
  assert.match(calls.spawn[0].prompt, /drain_report/)
  assert.equal(calls.spawn[0].agent, "drain-writer")
})

test("the drain path spawns drain-writer and a 4-item prompt stays lean", async () => {
  const ws = await workspace()
  const provider = createBrainProvider({ ...ws, drain: DEFAULT_DRAIN, summaryWords: 400 })
  const { executor, calls } = fakeExecutor({ rows: reportRows(4, ["#1", "#2", "#3", "#4"]) })
  const items = Array.from({ length: 4 }, (_, i) => ({
    ...ITEM,
    title: `${ITEM.title} ${i + 1}`,
    summary: `${ITEM.summary} Copy ${i + 1}.`,
  }))

  const result = await provider.consolidate!(items, ctx(ws, client(), executor))

  assert.equal(result.ok, true)
  assert.equal(calls.spawn[0].agent, "drain-writer")
  assert.ok(
    Buffer.byteLength(calls.spawn[0].prompt, "utf8") < 12_000,
    "a default batch prompt stays under 12 KB",
  )
})

test("an invalid report is a permanent error that does not consume items", async () => {
  const ws = await workspace()
  const provider = createBrainProvider({ ...ws, drain: DEFAULT_DRAIN, summaryWords: 400 })
  const warnings: string[] = []
  const { executor } = fakeExecutor({ rows: reportRows(2, ["#1", "#2"]) })
  const c = {
    ...ctx(ws, client(), executor),
    onWarn: (msg: string) => warnings.push(msg),
  }
  const result = await provider.consolidate!([ITEM], c)

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, "permanent")
  assert.deepEqual(result.consumed, [1, 2])
  assert.match(result.detail ?? "", /invalid report/)
  assert.match(warnings[0] ?? "", /invalid report \(unknown labels\)/)
})

test("a timed-out child with a valid late report advances the batch", async () => {
  const ws = await workspace()
  const provider = createBrainProvider({ ...ws, drain: DEFAULT_DRAIN, summaryWords: 400 })
  const { executor } = fakeExecutor({
    rows: reportRows(1, ["#1"]),
    timedOut: true,
    late: true,
    ok: false,
  })

  const result = await provider.consolidate!([ITEM], ctx(ws, client(), executor))

  assert.equal(result.ok, true)
  assert.equal(result.late, true, "the late report is accepted and marked")
  assert.deepEqual(result.consumed, [1])
})

test("a missing drain_report gets exactly one correction turn in the same child", async () => {
  const ws = await workspace()
  const provider = createBrainProvider({ ...ws, drain: DEFAULT_DRAIN, summaryWords: 400 })
  const { executor, calls } = fakeExecutor({
    rows: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "no tool" }] }],
    promptRows: reportRows(1, ["#1"]),
  })

  const result = await provider.consolidate!([ITEM], ctx(ws, client(), executor))

  assert.equal(calls.spawn.length, 1, "the correction reuses the child session")
  assert.equal(calls.prompt.length, 1, "exactly one follow-up prompt")
  assert.equal(calls.prompt[0].sessionID, "ses_writer")
  assert.match(calls.prompt[0].request.prompt, /drain_report/)
  assert.equal(result.ok, true)
  assert.deepEqual(result.consumed, [1])
})

test("a writer with no report is transient", async () => {
  const ws = await workspace()
  const provider = createBrainProvider({ ...ws, drain: DEFAULT_DRAIN, summaryWords: 400 })
  const { executor } = fakeExecutor({
    rows: [],
    promptRows: [],
    error: "writer did not call drain_report",
  })
  const result = await provider.consolidate!([ITEM], ctx(ws, client(), executor))

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, "transient")
})

test("a spawn failure is transient", async () => {
  const ws = await workspace()
  const provider = createBrainProvider({ ...ws, drain: DEFAULT_DRAIN, summaryWords: 400 })
  const executor: ChildExecutor = {
    async spawn(request) {
      return {
        jobId: "x",
        sessionID: null,
        phase: "failed",
        ok: false,
        started: false,
        rows: [],
        replies: [],
        late: false,
        timedOut: false,
        error: "spawn boom",
        errorKind: "transient",
        attempts: 1,
      }
    },
    async prompt(_sessionID, request) {
      return this.spawn(request)
    },
    async abort() {},
  }
  const result = await provider.consolidate!([ITEM], ctx(ws, client(), executor))

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, "transient")
  assert.match(result.detail ?? "", /spawn boom/)
})

test("pending counts turns after the cursor", async () => {
  const ws = await workspace()
  const dbFile = join(ws.directory, "opencode.db")
  const db = new DatabaseSync(dbFile)
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, time_updated INTEGER NOT NULL, time_created INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL DEFAULT '');
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, data TEXT NOT NULL);
  `)
  db.prepare("INSERT INTO session (id, parent_id, directory, time_updated) VALUES (?, ?, ?, ?)").run(
    "top-1",
    null,
    ws.directory,
    RECENT,
  )
  db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
    "m1",
    "top-1",
    RECENT,
    JSON.stringify({ role: "user" }),
  )
  db.prepare("INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)").run(
    "p1",
    "m1",
    JSON.stringify({ type: "text", text: "hello" }),
  )
  db.close()

  const provider = createBrainProvider({ ...ws, drain: DEFAULT_DRAIN, summaryWords: 400, dbFile })
  assert.equal(await provider.pending!(), 1)
})
