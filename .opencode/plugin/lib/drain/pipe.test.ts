import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { DEFAULT_DRAIN, type DrainConfig } from "./config.ts"
import { loadCursor, resolveCursorFile } from "./cursor.ts"
import { createDrainLedger, DRAIN_LEDGER_FILE } from "./ledger.ts"
import { createBrainProvider } from "../memory/providers/builtin/brain.ts"
import { resolveProvider } from "../memory/registry.ts"
import { runDrainPipe, type DrainPipeClient, type DrainPipeDeps } from "./pipe.ts"

const PROJECT = "/work/project-a"

const ONE_ITEM = JSON.stringify({
  items: [
    {
      title: "Wireguard Restart",
      summary: "Restart wg0 after changing the config.",
      tags: ["linux/network"],
      atoms: ["sudo systemctl restart wg0"],
    },
  ],
})

const TWO_ITEMS = JSON.stringify({
  items: [
    { title: "Wireguard Restart", summary: "Restart wg0.", tags: [], atoms: [] },
    { title: "Backup Policy", summary: "Nightly borg backups.", tags: [], atoms: [] },
  ],
})

function report(labels: string[], skipped: string[] = []): string {
  return [
    "```consolidated",
    ...labels,
    "```",
    "```skipped",
    ...skipped,
    "```",
  ].join("\n")
}

function assistant(text: string): unknown[] {
  return [
    {
      info: { role: "assistant", tokens: { input: 5, output: 2 }, cost: 0.001 },
      parts: [{ type: "text", text }],
    },
  ]
}

function fakeClient(opts: {
  summaryReply?: string
  writerReply?: string
  sdkSessions?: unknown[]
  sdkTurns?: Record<string, unknown[]>
  waitForIdle?: (sessionID: string) => Promise<boolean>
} = {}): { client: DrainPipeClient; prompts: any[] } {
  let summarizers = 0
  const prompts: any[] = []
  const client: DrainPipeClient = {
    session: {
      async list() {
        return { data: opts.sdkSessions ?? [] }
      },
      async create(args) {
        if (args.body.title === "drain-summarize") {
          summarizers++
          return { data: { id: `ses_sum_${summarizers}` } }
        }
        if (args.body.title === "knowledge-consolidate") return { data: { id: "ses_writer" } }
        return { data: { id: "ses_other" } }
      },
      async promptAsync(args) {
        prompts.push(args)
        return { response: { ok: true } }
      },
      async messages(args) {
        const id = args.path.id as string
        if (opts.sdkTurns && opts.sdkTurns[id]) return { data: opts.sdkTurns[id] }
        if (id === "ses_writer") return { data: assistant(opts.writerReply ?? report(["#1"])) }
        if (id.startsWith("ses_sum_")) return { data: assistant(opts.summaryReply ?? ONE_ITEM) }
        return { data: [] }
      },
    },
  }
  return { client, prompts }
}

async function workspace(): Promise<{ stateDir: string; vaultDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "drain-pipe-"))
  const stateDir = join(root, "state")
  const vaultDir = join(root, "vault")
  await mkdir(stateDir, { recursive: true })
  await mkdir(vaultDir, { recursive: true })
  return { stateDir, vaultDir }
}

async function seedDb(
  opts: {
    text?: string
    partType?: string
    time?: number
    sessionTime?: number
    sessionDirectory?: string
  } = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "drain-pipe-db-"))
  const file = join(dir, "opencode.db")
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, time_updated INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '');
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX message_session_time_created_id_idx ON message(session_id, time_created, id);
  `)
  db.prepare("INSERT INTO session (id, parent_id, directory, time_updated) VALUES (?, ?, ?, ?)").run(
    "top-1",
    null,
    opts.sessionDirectory ?? PROJECT,
    opts.sessionTime ?? 1000,
  )
  const text = opts.text ?? "run sudo systemctl restart wg0"
  db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
    "m1",
    "top-1",
    opts.time ?? 1000,
    JSON.stringify({ role: "user" }),
  )
  db.prepare("INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)").run(
    "m1-p",
    "m1",
    JSON.stringify({ type: opts.partType ?? "text", text }),
  )
  db.close()
  return file
}

function config(overrides: Partial<DrainConfig> = {}): DrainConfig {
  return {
    ...DEFAULT_DRAIN,
    writer_model: "test/writer",
    summarize_model: "test/sum",
    initial_lookback_hours: 0,
    ...overrides,
  }
}

function deps(
  base: { stateDir: string; vaultDir: string; dbFile: string },
  client: DrainPipeClient,
  opts: {
    config?: Partial<DrainConfig>
    waitForIdle?: (id: string) => Promise<boolean>
    ledger?: DrainPipeDeps["ledger"]
  } = {},
): DrainPipeDeps {
  const cfg = config(opts.config)
  return {
    directory: PROJECT,
    stateDir: base.stateDir,
    vaultDir: base.vaultDir,
    dbFile: base.dbFile,
    config: cfg,
    client,
    provider: createBrainProvider({
      directory: PROJECT,
      stateDir: base.stateDir,
      vaultDir: base.vaultDir,
      drain: cfg,
      summaryWords: 400,
      dbFile: base.dbFile,
    }),
    waitForIdle: opts.waitForIdle ?? (async () => true),
    registerChild: () => {},
    ledger: opts.ledger,
    onWarn: () => {},
  }
}

test("a valid run advances the cursor, stores continuity, and ledgers both spawns", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client, prompts } = fakeClient({ writerReply: report(["#1"]) })
  const ledger = createDrainLedger({ logDir: join(base.stateDir, "logs") })

  const result = await runDrainPipe(deps(base, client, { ledger }))

  assert.equal(result.outcome, "completed")
  assert.equal(result.sessions, 1)
  assert.equal(result.items, 1)
  assert.equal(result.consolidated, 1)
  assert.equal(result.skipped, 0)
  assert.equal(result.cursorBefore, 0)
  assert.equal(result.cursorAfter, 1000)
  assert.equal(result.session, "ses_writer", "writer session is exposed for the transcript")
  assert.equal(result.tokens, 14, "summarizer 7 + writer 7")

  const cursor = await loadCursor(resolveCursorFile(base.stateDir))
  assert.equal(cursor.last_ts, 1000)
  assert.match(cursor.summaries["top-1"].text, /Restart wg0/)

  const writerPrompt = prompts.find((p) => p.body.agent === "rag-brain")?.body.parts[0].text
  assert.match(writerPrompt, /^Consolidation mode\./)
  assert.match(writerPrompt, /### Knowledge item #1/)
  const summarizerPrompt = prompts.find((p) => p.body.agent === "session-summarizer")?.body.parts[0].text
  assert.match(summarizerPrompt, /## Session delta/)

  await ledger.flush()
  const lines = (await readFile(join(base.stateDir, "logs", DRAIN_LEDGER_FILE), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  assert.deepEqual(lines.map((l) => l.source), ["writer", "pipe"])
  assert.equal(lines[0].outcome, "ok")
  assert.equal(lines[1].cursor_after, 1000)
})

test("a fresh cursor starts at the configured lookback, not at epoch", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client, prompts } = fakeClient()
  const before = Date.now()

  const result = await runDrainPipe(
    deps(base, client, { config: { initial_lookback_hours: 1 } }),
  )

  const lookback = 3_600_000
  assert.equal(result.outcome, "nothing")
  assert.equal(result.sessions, 0)
  assert.ok(result.cursorBefore >= before - lookback - 1000)
  assert.ok(result.cursorBefore <= Date.now() - lookback + 1000)
  const cursor = await loadCursor(resolveCursorFile(base.stateDir))
  assert.equal(cursor.last_ts, result.cursorBefore)
  assert.equal(prompts.length, 0, "old sessions are not summarized")
})

test("lookback still picks up a session inside the window", async () => {
  const now = Date.now()
  const base = { ...(await workspace()), dbFile: await seedDb({ time: now - 60_000, sessionTime: now - 60_000 }) }
  const { client } = fakeClient({ writerReply: report(["#1"]) })

  const result = await runDrainPipe(
    deps(base, client, { config: { initial_lookback_hours: 1 } }),
  )

  assert.equal(result.outcome, "completed")
  assert.equal(result.sessions, 1)
  assert.equal(result.items, 1)
  assert.ok(result.cursorAfter >= now - 60_000)
})

test("nothing to do leaves the cursor untouched", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb({ text: "   " }) }
  const { client } = fakeClient()
  const result = await runDrainPipe(deps(base, client))

  assert.equal(result.outcome, "nothing")
  assert.equal(result.cursorAfter, 0)
  const cursor = await loadCursor(resolveCursorFile(base.stateDir))
  assert.equal(cursor.last_ts, 0)
})

test("disabled config is a no-op", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client } = fakeClient()
  const result = await runDrainPipe(deps(base, client, { config: { enabled: false } }))
  assert.equal(result.outcome, "nothing")
  assert.equal(result.error, undefined)
})

test("a partial writer report blocks the cursor and counts attempts", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client } = fakeClient({ summaryReply: TWO_ITEMS, writerReply: report(["#1"]) })

  const first = await runDrainPipe(deps(base, client))
  assert.equal(first.outcome, "error")
  assert.match(first.error ?? "", /invalid report/)
  assert.equal(first.cursorAfter, 0)

  const cursor1 = await loadCursor(resolveCursorFile(base.stateDir))
  assert.equal(cursor1.last_ts, 0)
  assert.deepEqual(cursor1.blocked, { ts: 1000, attempts: 1 })

  await runDrainPipe(deps(base, client))
  const cursor2 = await loadCursor(resolveCursorFile(base.stateDir))
  assert.deepEqual(cursor2.blocked, { ts: 1000, attempts: 2 })
})

test("poison advances past a batch that never reports completely", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client } = fakeClient({ summaryReply: TWO_ITEMS, writerReply: report(["#1"]) })

  await runDrainPipe(deps(base, client))
  await runDrainPipe(deps(base, client))
  const third = await runDrainPipe(deps(base, client))

  assert.equal(third.outcome, "dropped")
  assert.equal(third.cursorAfter, 1000)
  const cursor = await loadCursor(resolveCursorFile(base.stateDir))
  assert.equal(cursor.last_ts, 1000)
  assert.deepEqual(cursor.blocked, { ts: 1000, attempts: 0 })
})

test("a writer timeout is reported and does not advance", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client } = fakeClient({ writerReply: report(["#1"]) })
  const result = await runDrainPipe(
    deps(base, client, { waitForIdle: async (id) => id !== "ses_writer" }),
  )

  assert.equal(result.outcome, "error")
  assert.match(result.error ?? "", /timeout/)
  assert.equal(result.cursorAfter, 0)
})

test("summarizer fallback still runs the writer and degrades the result", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client, prompts } = fakeClient({
    summaryReply: "not json",
    writerReply: report(["#1"]),
  })
  const result = await runDrainPipe(deps(base, client))

  assert.equal(result.outcome, "degraded")
  assert.equal(result.degraded, "summarizer-fallback")
  assert.equal(result.consolidated, 1)
  assert.ok(prompts.some((p) => p.body.agent === "rag-brain"))
})

test("schema mismatch degrades to the SDK lane and still completes", async () => {
  const base = await workspace()
  const file = join(base.stateDir, "broken.db")
  const db = new DatabaseSync(file)
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY);")
  db.close()

  const { client } = fakeClient({
    sdkSessions: [
      { id: "s-top", parentID: null, directory: PROJECT, time: { updated: 1000 } },
    ],
    sdkTurns: {
      "s-top": [
        {
          info: { id: "m1", sessionID: "s-top", role: "user", time: { created: 1000 } },
          parts: [{ type: "text", text: "run sudo systemctl restart wg0" }],
        },
      ],
    },
    writerReply: report(["#1"]),
  })

  const result = await runDrainPipe(deps({ ...base, dbFile: file }, client))
  assert.equal(result.outcome, "degraded")
  assert.equal(result.degraded, "schema-mismatch")
  assert.equal(result.cursorAfter, 1000)
})

test("candidate prefetch is included when the vault has a matching note", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  await mkdir(join(base.vaultDir, "Networking"), { recursive: true })
  await writeFile(
    join(base.vaultDir, "Networking", "Wireguard Setup.md"),
    "---\ntitle: Wireguard Setup\n---\nWireguard tunnel notes.",
    "utf8",
  )
  const { client, prompts } = fakeClient({ writerReply: report(["#1"]) })
  await runDrainPipe(deps(base, client))

  const prompt = prompts.find((p) => p.body.agent === "rag-brain")?.body.parts[0].text
  assert.match(prompt, /Candidate existing notes/)
  assert.match(prompt, /Wireguard Setup/)
})

test("a completed batch is not reprocessed on the next run", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client, prompts } = fakeClient({ writerReply: report(["#1"]) })

  const first = await runDrainPipe(deps(base, client))
  assert.equal(first.outcome, "completed")

  const promptsAfterFirst = prompts.length
  const second = await runDrainPipe(deps(base, client))

  assert.equal(second.outcome, "nothing")
  assert.equal(second.items, 0)
  assert.equal(second.cursorAfter, 1000)
  assert.equal(prompts.length, promptsAfterFirst, "no second summarizer/writer spawn")
})

test("a provider without a writer is a no-op and never opens the DB", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client } = fakeClient()
  const result = await runDrainPipe({
    ...deps(base, client),
    provider: resolveProvider("none", {
      directory: PROJECT,
      stateDir: base.stateDir,
      vaultDir: base.vaultDir,
      config: DEFAULT_DRAIN,
    } as any),
  } as any)
  assert.equal(result.outcome, "nothing")
  assert.match(result.error ?? "", /no writer/)
  assert.equal(result.cursorAfter, 0)
})

test("a batch over max_items_per_batch is chunked into complete writer reports", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client } = fakeClient({ summaryReply: TWO_ITEMS })
  const ledger = createDrainLedger({ logDir: join(base.stateDir, "logs") })

  const result = await runDrainPipe(
    deps(base, client, { config: { max_items_per_batch: 1 }, ledger }),
  )

  assert.equal(result.outcome, "completed")
  assert.equal(result.items, 2)
  assert.equal(result.consolidated, 2)
  assert.equal(result.skipped, 0)
  assert.equal(result.cursorAfter, 1000)
  assert.equal(result.session, "ses_writer")
  assert.equal(result.tokens, 21, "summarizer 7 + two writer chunks")

  await ledger.flush()
  const lines = (await readFile(join(base.stateDir, "logs", DRAIN_LEDGER_FILE), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  assert.deepEqual(lines.map((l) => l.source), ["writer", "writer", "pipe"])
})

test("a later chunk failure blocks the cursor even when earlier chunks succeeded", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client } = fakeClient({ summaryReply: TWO_ITEMS })
  let calls = 0
  const provider: any = {
    ...createBrainProvider({
      directory: PROJECT,
      stateDir: base.stateDir,
      vaultDir: base.vaultDir,
      drain: config(),
      summaryWords: 400,
      dbFile: base.dbFile,
    }),
    async consolidate() {
      calls++
      if (calls === 2) {
        return { ok: false, consumed: [], skipped: [], errorKind: "permanent", detail: "chunk two failed" }
      }
      return { ok: true, consumed: [1], skipped: [] }
    },
  }

  const result = await runDrainPipe({
    ...deps(base, client, { config: { max_items_per_batch: 1 } }),
    provider,
  })

  assert.equal(result.outcome, "error")
  assert.equal(result.consolidated, 1)
  assert.equal(result.cursorAfter, 0)
  assert.match(result.error ?? "", /chunk two failed/)
  const cursor = await loadCursor(resolveCursorFile(base.stateDir))
  assert.deepEqual(cursor.blocked, { ts: 1000, attempts: 1 })
})

test("a transient provider error backs off without poisoning the boundary", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client } = fakeClient()
  const provider: any = {
    ...createBrainProvider({
      directory: PROJECT,
      stateDir: base.stateDir,
      vaultDir: base.vaultDir,
      drain: config(),
      summaryWords: 400,
      dbFile: base.dbFile,
    }),
    async consolidate() {
      return { ok: false, consumed: [], skipped: [], errorKind: "transient", detail: "backend down" }
    },
  }

  const result = await runDrainPipe({ ...deps(base, client), provider })
  assert.equal(result.outcome, "error")
  assert.match(result.error ?? "", /backend down/)
  assert.equal(result.cursorAfter, 0)
  const cursor = await loadCursor(resolveCursorFile(base.stateDir))
  assert.equal(cursor.blocked?.attempts ?? 0, 0)
})

test("an atomic provider report advances the whole batch", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client } = fakeClient({ summaryReply: TWO_ITEMS })
  const provider: any = {
    ...createBrainProvider({
      directory: PROJECT,
      stateDir: base.stateDir,
      vaultDir: base.vaultDir,
      drain: config(),
      summaryWords: 400,
      dbFile: base.dbFile,
    }),
    async consolidate() {
      return { ok: true, consumed: [], skipped: [], atomic: true }
    },
  }

  const result = await runDrainPipe({ ...deps(base, client), provider })
  assert.equal(result.outcome, "completed")
  assert.equal(result.cursorAfter, 1000)
})
