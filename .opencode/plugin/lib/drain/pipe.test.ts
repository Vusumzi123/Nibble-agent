import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { DEFAULT_DRAIN, type DrainConfig } from "./config.ts"
import { loadCursor, resolveCursorFile } from "./cursor.ts"
import { createDrainLedger, DRAIN_LEDGER_FILE } from "./ledger.ts"
import { createBrainProvider } from "../memory/providers/builtin/brain.ts"
import { DRAIN_REPORT_TOOL } from "../memory/providers/builtin/brain/report.ts"
import { resolveProvider } from "../memory/registry.ts"
import { runDrainPipe, type DrainPipeClient, type DrainPipeDeps } from "./pipe.ts"
import { SUMMARY_ITEMS_TOOL } from "./summarize.ts"

const PROJECT = "/work/project-a"

type SummaryInput = { title: string; tags: string[]; summary: string; atoms: string[] }
type WriterReport = {
  consolidated: Array<string | number>
  skipped: Array<string | number>
  partial?: boolean
}

const ONE_ITEM: SummaryInput = {
  title: "Wireguard Restart",
  tags: ["linux/network"],
  summary: "Restart wg0 after changing the config.",
  atoms: ["sudo systemctl restart wg0"],
}

const TWO_ITEMS: SummaryInput[] = [
  ONE_ITEM,
  {
    title: "Backup Policy",
    tags: [],
    summary: "Nightly borg backups.",
    atoms: [],
  },
]

function assistantRow(opts: {
  parentID: string
  created: number
  completed?: boolean
  text?: string
  tool?: string
  input?: unknown
}): unknown {
  const parts: unknown[] = []
  if (opts.text) parts.push({ type: "text", text: opts.text })
  if (opts.tool) parts.push({ type: "tool", tool: opts.tool, state: { input: opts.input } })
  return {
    info: {
      id: `a_${Math.random().toString(36).slice(2)}`,
      role: "assistant",
      parentID: opts.parentID,
      finish: "stop",
      time: {
        created: opts.created,
        ...(opts.completed ? { completed: opts.created + 1 } : {}),
      },
      tokens: { input: 5, output: 2 },
      cost: 0.001,
    },
    parts,
  }
}

type FakeOptions = {
  summaryItemsFor?: (prompt: string) => SummaryInput[] | null
  summaryIncomplete?: boolean
  writerReportFor?: (prompt: string, itemCount: number) => WriterReport | null
  writerIncomplete?: boolean
  writerTrailing?: string
  summaryGate?: (sessionID: string, prompt: string) => Promise<void> | undefined
  sdkSessions?: unknown[]
  sdkTurns?: Record<string, unknown[]>
}

function fakeClient(opts: FakeOptions = {}): { client: DrainPipeClient; prompts: any[] } {
  let summaries = 0
  let writers = 0
  let turn = 0
  const prompts: any[] = []
  const titles = new Map<string, string>()
  const rows = new Map<string, unknown[]>()

  const client: DrainPipeClient = {
    session: {
      async list() {
        return { data: opts.sdkSessions ?? [] }
      },
      async create(args) {
        const title = String(args.body.title ?? "")
        let id: string
        if (title === "drain-summarize") id = `ses_sum_${++summaries}`
        else if (title === "knowledge-consolidate") {
          id = writers === 0 ? "ses_writer" : `ses_writer_${writers + 1}`
          writers++
        } else id = "ses_other"
        titles.set(id, title)
        rows.set(id, [])
        return { data: { id } }
      },
      async promptAsync(args) {
        prompts.push(args)
        const id = String(args.path.id ?? "")
        const text = String(args.body.parts?.[0]?.text ?? "")
        const title = titles.get(id) ?? ""
        const userID = `u_${id}_${++turn}`
        const previous = rows.get(id) ?? []
        const userRow = {
          info: { id: userID, role: "user", time: { created: Date.now() } },
          parts: [{ type: "text", text }],
        }
        const base = [...previous, userRow]

        if (title === "drain-summarize") {
          const gate = opts.summaryGate?.(id, text)
          if (gate) await gate
          const providedItems = opts.summaryItemsFor?.(text)
          const items = providedItems === undefined ? [ONE_ITEM] : providedItems
          const assistant =
            items === null
              ? assistantRow({
                  parentID: userID,
                  created: Date.now(),
                  completed: !opts.summaryIncomplete,
                  text: "no tool call",
                })
              : assistantRow({
                  parentID: userID,
                  created: Date.now(),
                  completed: !opts.summaryIncomplete,
                  tool: SUMMARY_ITEMS_TOOL,
                  input: { items },
                })
          rows.set(id, [...base, assistant])
          return { response: { ok: true } }
        }

        if (title === "knowledge-consolidate") {
          const count =
            (text.match(/### Knowledge item #\d+/g) ?? []).length ||
            Number(/item_count:\s*(\d+)/.exec(text)?.[1] ?? 0)
          const providedReport = opts.writerReportFor?.(text, count)
          const report =
            providedReport === undefined
              ? ({ consolidated: Array.from({ length: count }, (_, i) => i + 1), skipped: [] } as WriterReport)
              : providedReport
          const assistant =
            report === null
              ? assistantRow({
                  parentID: userID,
                  created: Date.now(),
                  completed: !opts.writerIncomplete,
                  text: "no tool call",
                })
              : assistantRow({
                  parentID: userID,
                  created: Date.now(),
                  completed: !opts.writerIncomplete,
                  tool: DRAIN_REPORT_TOOL,
                  input: { item_count: count, ...report },
                })
          const next = [...base, assistant]
          if (opts.writerTrailing) {
            next.push(
              assistantRow({
                parentID: userID,
                created: Date.now() + 1,
                completed: true,
                text: opts.writerTrailing,
              }),
            )
          }
          rows.set(id, next)
          return { response: { ok: true } }
        }

        rows.set(id, base)
        return { response: { ok: true } }
      },
      async abort() {
        return { response: { ok: true } }
      },
      async messages(args) {
        const id = String(args.path.id ?? "")
        if (opts.sdkTurns && opts.sdkTurns[id]) return { data: opts.sdkTurns[id] }
        return { data: rows.get(id) ?? [] }
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
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, time_updated INTEGER NOT NULL, time_created INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL DEFAULT '');
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

/** An old session with no eligible text (already consumed) ahead of a newer
 *  session that still has a text turn — the head-of-line stall shape. */
async function seedConsumedHeadDb(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "drain-pipe-db-"))
  const file = join(dir, "opencode.db")
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, time_updated INTEGER NOT NULL, time_created INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL DEFAULT '');
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX message_session_time_created_id_idx ON message(session_id, time_created, id);
  `)
  db.prepare("INSERT INTO session (id, parent_id, directory, time_updated) VALUES (?, ?, ?, ?)").run(
    "old-consumed",
    null,
    PROJECT,
    1000,
  )
  db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
    "m-old",
    "old-consumed",
    1000,
    JSON.stringify({ role: "assistant" }),
  )
  db.prepare("INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)").run(
    "m-old-p",
    "m-old",
    JSON.stringify({ type: "tool" }),
  )
  db.prepare("INSERT INTO session (id, parent_id, directory, time_updated) VALUES (?, ?, ?, ?)").run(
    "new-work",
    null,
    PROJECT,
    4000,
  )
  db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
    "m-new",
    "new-work",
    4000,
    JSON.stringify({ role: "user" }),
  )
  db.prepare("INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)").run(
    "m-new-p",
    "m-new",
    JSON.stringify({ type: "text", text: "run sudo systemctl restart wg0" }),
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
    max_attempts: 1,
    ...overrides,
  }
}

function deps(
  base: { stateDir: string; vaultDir: string; dbFile: string },
  client: DrainPipeClient,
  opts: {
    config?: Partial<DrainConfig>
    ledger?: DrainPipeDeps["ledger"]
    pollMs?: number
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
    registerChild: () => {},
    ...(opts.ledger ? { ledger: opts.ledger } : {}),
    ...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {}),
    onWarn: () => {},
  }
}

function ledgerSources(lines: any[]): string[] {
  return lines.filter((line) => line.source !== "coordinator").map((line) => line.source)
}

test("a valid run advances the cursor, stores continuity, and ledgers both spawns", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client, prompts } = fakeClient()
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
  assert.equal(cursor.watermark_ts, 1000)
  assert.match(cursor.sessions["top-1"].summary, /Restart wg0/)

  const writerPrompt = prompts.find((p) => p.body.agent === "drain-writer")?.body.parts[0].text
  assert.match(writerPrompt, /^Consolidation mode\./)
  assert.match(writerPrompt, /### Knowledge item #1/)
  assert.match(writerPrompt, /drain_report/)
  const summarizerPrompt = prompts.find((p) => p.body.agent === "session-summarizer")?.body.parts[0].text
  assert.match(summarizerPrompt, /## Session delta/)
  assert.match(summarizerPrompt, /summary_items/)

  await ledger.flush()
  const lines = (await readFile(join(base.stateDir, "logs", DRAIN_LEDGER_FILE), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  assert.deepEqual(ledgerSources(lines), ["summarizer", "writer", "pipe"])
  assert.equal(lines.find((l) => l.source === "summarizer").outcome, "ok")
  assert.equal(lines.find((l) => l.source === "writer").outcome, "ok")
  assert.equal(lines.find((l) => l.source === "pipe").cursor_after, 1000)
  assert.equal(typeof lines.find((l) => l.source === "pipe").reply_bytes, "number")
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
  assert.equal(cursor.watermark_ts, result.cursorBefore)
  assert.equal(prompts.length, 0, "old sessions are not summarized")
})

test("lookback still picks up a session inside the window", async () => {
  const now = Date.now()
  const base = {
    ...(await workspace()),
    dbFile: await seedDb({ time: now - 300_000, sessionTime: now - 300_000 }),
  }
  const { client } = fakeClient()

  const result = await runDrainPipe(
    deps(base, client, { config: { initial_lookback_hours: 1 } }),
  )

  assert.equal(result.outcome, "completed")
  assert.equal(result.sessions, 1)
  assert.equal(result.items, 1)
  assert.ok(result.cursorAfter >= now - 300_000)
})

test("a discovered session with no eligible turns is consumed, not left pending", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb({ text: "   " }) }
  const { client } = fakeClient()
  const result = await runDrainPipe(deps(base, client))

  assert.equal(result.outcome, "nothing")
  assert.equal(result.sessions, 1, "the discovered session is reported")
  assert.equal(result.cursorAfter, 1000, "the watermark advances over it")
  const cursor = await loadCursor(resolveCursorFile(base.stateDir))
  assert.equal(cursor.watermark_ts, 1000)
})

test("a consumed discovery batch cannot block newer turns (head-of-line)", async () => {
  const base = { ...(await workspace()), dbFile: await seedConsumedHeadDb() }
  const { client } = fakeClient()
  const one = { config: { batch_sessions: 1 } }

  const first = await runDrainPipe(deps(base, client, one))
  assert.equal(first.outcome, "nothing")
  assert.equal(first.sessions, 1)
  assert.equal(first.cursorAfter, 1000, "the consumed head is skipped so the queue can move")

  const second = await runDrainPipe(deps(base, client, one))
  assert.equal(second.outcome, "completed")
  assert.equal(second.sessions, 1)
  assert.equal(second.items, 1)
  assert.equal(second.cursorAfter, 4000, "the newer turn is discovered on the next pass")
})

test("disabled config is a no-op", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client } = fakeClient()
  const result = await runDrainPipe(deps(base, client, { config: { enabled: false } }))
  assert.equal(result.outcome, "nothing")
  assert.equal(result.error, undefined)
})

test("a valid empty summary advances the cursor without spawning a writer", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client, prompts } = fakeClient({ summaryItemsFor: () => [] })

  const result = await runDrainPipe(deps(base, client))

  assert.equal(result.outcome, "nothing")
  assert.equal(result.sessions, 1)
  assert.equal(result.items, 0)
  assert.equal(result.degraded, undefined)
  assert.equal(result.cursorAfter, 1000)
  assert.equal(
    prompts.some((p) => p.body.agent === "drain-writer"),
    false,
    "no writer spawn for an empty batch",
  )
  const cursor = await loadCursor(resolveCursorFile(base.stateDir))
  assert.equal(cursor.watermark_ts, 1000)
})

test("a partial writer report blocks the cursor and counts attempts", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client } = fakeClient({
    summaryItemsFor: () => TWO_ITEMS,
    writerReportFor: () => ({ consolidated: ["#1"], skipped: [] }),
  })

  const first = await runDrainPipe(deps(base, client))
  assert.equal(first.outcome, "error")
  assert.match(first.error ?? "", /invalid report/)
  assert.equal(first.cursorAfter, 0)

  const cursor1 = await loadCursor(resolveCursorFile(base.stateDir))
  assert.equal(cursor1.watermark_ts, 0)
  assert.equal(cursor1.blocked.ts, 1000)
  assert.equal(cursor1.blocked.attempts, 1)
  assert.ok(cursor1.blocked.blocked_until > 0, "a failure sets the backoff deadline")

  await runDrainPipe(deps(base, client))
  const cursor2 = await loadCursor(resolveCursorFile(base.stateDir))
  assert.equal(cursor2.blocked.ts, 1000)
  assert.equal(cursor2.blocked.attempts, 2)
})

test("poison advances past a batch that never reports completely", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client } = fakeClient({
    summaryItemsFor: () => TWO_ITEMS,
    writerReportFor: () => ({ consolidated: ["#1"], skipped: [] }),
  })

  await runDrainPipe(deps(base, client))
  await runDrainPipe(deps(base, client))
  const third = await runDrainPipe(deps(base, client))

  assert.equal(third.outcome, "dropped")
  assert.equal(third.cursorAfter, 1000)
  const cursor = await loadCursor(resolveCursorFile(base.stateDir))
  assert.equal(cursor.watermark_ts, 1000)
  assert.equal(cursor.blocked.ts, 1000)
  assert.equal(cursor.blocked.attempts, 0)
})

test("a writer deadline with no reply is reported and does not advance", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client } = fakeClient({
    writerReportFor: () => null,
    writerIncomplete: true,
  })
  const result = await runDrainPipe(
    deps(base, client, { config: { child_stall_ms: 50 }, pollMs: 10 }),
  )

  assert.equal(result.outcome, "error")
  assert.match(result.error ?? "", /drain_report|timed out/)
  assert.equal(result.cursorAfter, 0)
})

test("summarizer fallback still runs the writer and degrades the result", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client, prompts } = fakeClient({ summaryItemsFor: () => null })
  const result = await runDrainPipe(deps(base, client))

  assert.equal(result.outcome, "degraded")
  assert.equal(result.degraded, "summarizer-fallback")
  assert.match(result.error ?? "", /did not call summary_items/)
  assert.equal(result.consolidated, 1)
  assert.ok(prompts.some((p) => p.body.agent === "drain-writer"))
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
  const { client, prompts } = fakeClient()
  await runDrainPipe(deps(base, client))

  const prompt = prompts.find((p) => p.body.agent === "drain-writer")?.body.parts[0].text
  assert.match(prompt, /Candidate existing notes/)
  assert.match(prompt, /Wireguard Setup/)
})

test("a late summarizer report is accepted and marked in its ledger row", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client } = fakeClient({ summaryIncomplete: true })
  const ledger = createDrainLedger({ logDir: join(base.stateDir, "logs") })

  const result = await runDrainPipe(
    deps(base, client, {
      ledger,
      config: { child_stall_ms: 50 },
      pollMs: 10,
    }),
  )

  assert.equal(result.outcome, "completed")
  await ledger.flush()
  const lines = (await readFile(join(base.stateDir, "logs", DRAIN_LEDGER_FILE), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  const summarizer = lines.find((line) => line.source === "summarizer")
  assert.equal(summarizer.late, true, "the capped child's late report is explainable")
})

test("a late writer report advances the cursor and is marked late", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client } = fakeClient({ writerIncomplete: true })
  const ledger = createDrainLedger({ logDir: join(base.stateDir, "logs") })

  const result = await runDrainPipe(
    deps(base, client, {
      ledger,
      config: { child_stall_ms: 50 },
      pollMs: 10,
    }),
  )

  assert.equal(result.outcome, "completed")
  assert.equal(result.cursorAfter, 1000, "a valid late report advances the cursor")
  await ledger.flush()
  const lines = (await readFile(join(base.stateDir, "logs", DRAIN_LEDGER_FILE), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  const writer = lines.find((line) => line.source === "writer")
  assert.equal(writer.late, true)
  assert.equal(writer.outcome, "ok")
})

test("a completed batch is not reprocessed on the next run", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client, prompts } = fakeClient()

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
  const { client } = fakeClient({ summaryItemsFor: () => TWO_ITEMS })
  const ledger = createDrainLedger({ logDir: join(base.stateDir, "logs") })

  const result = await runDrainPipe(
    deps(base, client, { config: { max_items_per_batch: 1 }, ledger }),
  )

  assert.equal(result.outcome, "completed")
  assert.equal(result.items, 2)
  assert.equal(result.consolidated, 2)
  assert.equal(result.skipped, 0)
  assert.equal(result.cursorAfter, 1000)
  assert.match(result.session ?? "", /^ses_writer/)
  assert.equal(result.tokens, 21, "summarizer 7 + two writer chunks")

  await ledger.flush()
  const lines = (await readFile(join(base.stateDir, "logs", DRAIN_LEDGER_FILE), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  assert.deepEqual(ledgerSources(lines), ["summarizer", "writer", "writer", "pipe"])
})

test("a later chunk failure blocks the cursor even when earlier chunks succeeded", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client } = fakeClient({ summaryItemsFor: () => TWO_ITEMS })
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
  assert.equal(cursor.blocked.ts, 1000)
  assert.equal(cursor.blocked.attempts, 1)
  assert.ok(cursor.blocked.blocked_until > 0, "a failure sets the backoff deadline")
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
  assert.equal(cursor.blocked.attempts, 1, "the transient failure persists a backoff")
  assert.ok(cursor.blocked.blocked_until > Date.now() - 1_000, "backoff gets a deadline")
  assert.equal(cursor.watermark_ts, 0, "nothing is advanced")
  assert.deepEqual(cursor.failures, {}, "transient failures never poison a session")
})

test("an atomic provider report advances the whole batch", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client } = fakeClient({ summaryItemsFor: () => TWO_ITEMS })
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

test("atomic is scoped to its chunk: later chunks still run", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client } = fakeClient({ summaryItemsFor: () => TWO_ITEMS })
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
    async consolidate(items: any[]) {
      calls++
      if (calls === 1) return { ok: true, consumed: [], skipped: [], atomic: true }
      return { ok: true, consumed: items.map((_, i) => i + 1), skipped: [] }
    },
  }

  const result = await runDrainPipe({
    ...deps(base, client, { config: { max_items_per_batch: 1 } }),
    provider,
  })
  assert.equal(calls, 2, "the chunk after the atomic report is still written")
  assert.equal(result.outcome, "completed")
  assert.equal(result.cursorAfter, 1000)
})

test("a trailing acknowledgement does not hide the writer's report", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client } = fakeClient({ writerTrailing: "Done." })

  const result = await runDrainPipe(deps(base, client))
  assert.equal(result.outcome, "completed")
  assert.equal(result.consolidated, 1)
  assert.equal(result.cursorAfter, 1000)
})

test("per-session poison leaves the other session's work pending", async () => {
  const base = await workspace()
  const alpha = "alpha topic: restart the tunnel"
  const beta = "beta topic: rotate backups"
  const turn = (id: string, text: string, time: number): unknown => ({
    info: { id, sessionID: id.split(":")[0], role: "user", time: { created: time } },
    parts: [{ type: "text", text }],
  })
  const { client } = fakeClient({
    sdkSessions: [
      { id: "ses_a", directory: PROJECT, title: "Alpha", time: { created: 0, updated: 1000 } },
      { id: "ses_b", directory: PROJECT, title: "Beta", time: { created: 0, updated: 2000 } },
    ],
    sdkTurns: {
      ses_a: [turn("ses_a:1", alpha, 1000)],
      ses_b: [turn("ses_b:1", beta, 2000)],
    },
    summaryItemsFor: (prompt) =>
      prompt.includes(alpha)
        ? [ONE_ITEM]
        : [{ title: "Backup Policy", tags: ["ops/backup"], summary: "Nightly borg backups.", atoms: ["borg create"] }],
  })
  const provider: any = {
    ...createBrainProvider({
      directory: PROJECT,
      stateDir: base.stateDir,
      vaultDir: base.vaultDir,
      drain: config(),
      summaryWords: 400,
    }),
    async consolidate(items: any[]) {
      if (items.some((item) => item.title === "Backup Policy")) {
        return { ok: false, consumed: [], skipped: [], errorKind: "permanent", detail: "poisoned" }
      }
      return { ok: true, consumed: items.map((_, i) => i + 1), skipped: [] }
    },
  }

  const result = await runDrainPipe({
    ...deps({ ...base, dbFile: join(base.stateDir, "missing.db") }, client, {
      config: { poison_attempts: 1, max_items_per_batch: 1 },
    }),
    provider,
  })
  assert.equal(result.outcome, "dropped")

  const cursor = await loadCursor(resolveCursorFile(base.stateDir))
  assert.equal(cursor.sessions.ses_a?.last_ts, 1000, "the good session advanced")
  assert.equal(cursor.sessions.ses_b?.last_ts, 2000, "only the bad session was dropped")
  assert.deepEqual(cursor.failures, {}, "the poisoned session's counter is cleared")
})

test("a retried pass dedupes written items and creates no duplicate notes", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client } = fakeClient({ summaryItemsFor: () => TWO_ITEMS })
  const writes = new Map<string, number>()
  let backupAttempts = 0
  const provider: any = {
    ...createBrainProvider({
      directory: PROJECT,
      stateDir: base.stateDir,
      vaultDir: base.vaultDir,
      drain: config(),
      summaryWords: 400,
      dbFile: base.dbFile,
    }),
    async consolidate(items: any[]) {
      for (const item of items) {
        if (item.title === "Backup Policy" && backupAttempts++ === 0) {
          return { ok: false, consumed: [], skipped: [], errorKind: "permanent", detail: "rejected" }
        }
        await writeFile(join(base.vaultDir, `${item.title.replace(/\s+/g, "-")}.md`), item.summary, "utf8")
        writes.set(item.title, (writes.get(item.title) ?? 0) + 1)
      }
      return { ok: true, consumed: items.map((_, i) => i + 1), skipped: [] }
    },
  }

  const one = { config: { max_items_per_batch: 1 } }
  const first = await runDrainPipe({ ...deps(base, client, one), provider })
  assert.equal(first.outcome, "error", "the failed chunk does not advance the session")
  const second = await runDrainPipe({ ...deps(base, client, one), provider })
  assert.equal(second.outcome, "completed")

  assert.deepEqual(
    [...writes.entries()].sort(),
    [
      ["Backup Policy", 1],
      ["Wireguard Restart", 1],
    ],
    "each note is written exactly once across the retried passes",
  )
  assert.deepEqual((await readdir(base.vaultDir)).sort(), [
    "Backup-Policy.md",
    "Wireguard-Restart.md",
  ])
})

test("a rerun after a completed pass is a no-op", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client, prompts } = fakeClient()
  const first = await runDrainPipe(deps(base, client))
  assert.equal(first.outcome, "completed")
  const spawned = prompts.length

  const second = await runDrainPipe(deps(base, client))
  assert.equal(second.outcome, "nothing")
  assert.equal(second.sessions, 0)
  assert.equal(second.items, 0)
  assert.equal(prompts.length, spawned, "no summarizer or writer spawn on a rerun")
})

type PoolSession = { id: string; text: string; time: number }

function poolDb(opts: {
  sessions: PoolSession[]
  summaryItemsFor: (prompt: string) => SummaryInput[] | null
  summaryGate?: (sessionID: string, prompt: string) => Promise<void> | undefined
}): { client: DrainPipeClient; prompts: any[] } {
  const sdkSessions = opts.sessions.map((session) => ({
    id: session.id,
    directory: PROJECT,
    title: session.id,
    time: { created: 0, updated: session.time },
  }))
  const sdkTurns = Object.fromEntries(
    opts.sessions.map((session) => [
      session.id,
      [
        {
          info: {
            id: `${session.id}:1`,
            sessionID: session.id,
            role: "user",
            time: { created: session.time },
          },
          parts: [{ type: "text", text: session.text }],
        },
      ],
    ]),
  )
  return fakeClient({
    sdkSessions,
    sdkTurns,
    summaryItemsFor: opts.summaryItemsFor,
    ...(opts.summaryGate ? { summaryGate: opts.summaryGate } : {}),
  })
}

function poolItems(prompt: string): SummaryInput[] {
  if (prompt.includes("alpha topic")) {
    return [{ title: "Alpha Note", tags: ["ops"], summary: "Alpha knowledge.", atoms: [] }]
  }
  if (prompt.includes("beta topic")) {
    return [{ title: "Beta Note", tags: ["ops"], summary: "Beta knowledge.", atoms: [] }]
  }
  return [{ title: "Gamma Note", tags: ["ops"], summary: "Gamma knowledge.", atoms: [] }]
}

const POOL_SESSIONS: PoolSession[] = [
  { id: "ses_a", text: "alpha topic: restart the tunnel", time: 1000 },
  { id: "ses_b", text: "beta topic: rotate backups", time: 2000 },
  { id: "ses_c", text: "gamma topic: renew certificates", time: 3000 },
]

function pooledDeps(
  base: { stateDir: string; vaultDir: string },
  client: DrainPipeClient,
  opts: {
    concurrency: number
    tokenBudget?: number
  },
): DrainPipeDeps {
  return deps(
    { ...base, dbFile: join(base.stateDir, "missing.db") },
    client,
    {
      config: {
        summarize_concurrency: opts.concurrency,
        ...(opts.tokenBudget !== undefined ? { token_budget: opts.tokenBudget } : {}),
      },
    },
  )
}

async function waitUntil(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("waitUntil timed out")
}

test("summarizers overlap up to summarize_concurrency and fold in discovery order", async () => {
  const base = await workspace()
  const started: string[] = []
  const gates = new Map<string, () => void>()
  let inFlight = 0
  let maxInFlight = 0
  const summaryGate = (id: string): Promise<void> | undefined => {
    started.push(id)
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    if (id === "ses_sum_1" || id === "ses_sum_2") {
      return new Promise<void>((resolve) => {
        gates.set(id, () => {
          inFlight--
          resolve()
        })
      })
    }
    inFlight--
    return undefined
  }
  const { client, prompts } = poolDb({
    sessions: POOL_SESSIONS,
    summaryItemsFor: poolItems,
    summaryGate,
  })

  const running = runDrainPipe(pooledDeps(base, client, { concurrency: 2 }))
  await waitUntil(() => started.length >= 2)
  assert.equal(started.length, 2, "the second child starts before the first settles")
  assert.equal(maxInFlight, 2, "two summarizers run at once")

  gates.get("ses_sum_1")!()
  gates.get("ses_sum_2")!()
  const pooled = await running

  assert.equal(pooled.outcome, "degraded")
  assert.equal(pooled.items, 3)
  assert.equal(pooled.consolidated, 3)
  assert.equal(pooled.cursorAfter, 3000)
  assert.equal(
    prompts.filter((p) => p.body.agent === "session-summarizer").length,
    3,
    "each discovered session is summarized exactly once",
  )

  const sequentialBase = await workspace()
  const sequentialClient = poolDb({
    sessions: POOL_SESSIONS,
    summaryItemsFor: poolItems,
  })
  const sequential = await runDrainPipe(
    pooledDeps(sequentialBase, sequentialClient.client, { concurrency: 1 }),
  )
  assert.equal(sequential.items, pooled.items)
  assert.equal(sequential.consolidated, pooled.consolidated)
  assert.equal(sequential.skipped, pooled.skipped)
  assert.equal(sequential.cursorAfter, pooled.cursorAfter)
  assert.equal(sequential.outcome, pooled.outcome)
})

test("a budget stop during summarization launches no later child and reports the one that ran", async () => {
  const base = await workspace()
  const { client, prompts } = poolDb({
    sessions: POOL_SESSIONS,
    summaryItemsFor: poolItems,
  })

  const result = await runDrainPipe(
    pooledDeps(base, client, { concurrency: 1, tokenBudget: 7 }),
  )

  assert.equal(result.stopped, "token-budget")
  assert.equal(result.outcome, "degraded")
  assert.equal(result.degraded, "budget-exhausted")
  assert.equal(result.items, 1, "the summary that completed is still reported")
  assert.equal(
    prompts.filter((p) => p.body.agent === "session-summarizer").length,
    1,
    "the budget blocks the second and third launches",
  )
  assert.equal(
    prompts.some((p) => p.body.agent === "drain-writer"),
    false,
    "the budget is already spent before the writer chunk",
  )
})

test("one malformed update under concurrency degrades once and still writes the rest", async () => {
  const base = await workspace()
  const { client, prompts } = poolDb({
    sessions: POOL_SESSIONS,
    summaryItemsFor: (prompt) =>
      prompt.includes("beta topic") || !prompt.includes("## Session delta")
        ? null
        : poolItems(prompt),
  })

  const result = await runDrainPipe(pooledDeps(base, client, { concurrency: 2 }))

  assert.equal(result.outcome, "degraded")
  assert.equal(result.degraded, "sdk-fallback", "the SDK lane already marked the source")
  assert.match(result.error ?? "", /did not call summary_items/)
  assert.equal(result.consolidated, 3, "the writer still received the surviving items")
  const writerPrompt = prompts.find((p) => p.body.agent === "drain-writer")?.body.parts[0].text
  assert.match(writerPrompt, /Alpha Note/)
  assert.match(writerPrompt, /Gamma Note/)
})

test("the pass status file keeps its pass-level fields and adds the live task table", async () => {
  const base = { ...(await workspace()), dbFile: await seedDb() }
  const { client } = fakeClient()
  await runDrainPipe(deps(base, client, { config: { trigger_pending: 12 } }))

  const status = JSON.parse(
    await readFile(join(base.stateDir, "drain.current.json"), "utf8"),
  )
  assert.equal(status.state, "idle")
  assert.equal(status.outcome, "completed")
  assert.equal(status.pending, 0, "drainHealth keeps a numeric pending")
  assert.ok(
    status.oldest_pending_age_ms === null ||
      typeof status.oldest_pending_age_ms === "number",
    "drainHealth tolerates a null oldest age",
  )
  assert.match(status.updated_at, /^\d{4}-/)
  assert.equal(status.pass_id, status.pass_id, "the pass id is recorded")
  assert.equal(status.counts.total, 2, "one summarize task and one write task")
  assert.deepEqual(
    status.tasks.map((task: any) => task.state).sort(),
    ["complete", "complete"],
  )
  assert.match(status.tasks_updated_at, /^\d{4}-/)

  const disabled = await runDrainPipe(
    deps({ ...base, stateDir: join(base.stateDir, "disabled") }, client, {
      config: { enabled: false },
    }),
  )
  assert.equal(disabled.outcome, "nothing")
  const idle = JSON.parse(
    await readFile(join(base.stateDir, "disabled", "drain.current.json"), "utf8"),
  )
  assert.equal(idle.state, "idle")
  assert.equal(idle.outcome, "nothing")
})
