import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { DEFAULT_DRAIN } from "../../../drain/config.ts"
import { createBrainProvider } from "./brain.ts"
import type { MemoryWriteClient, WriteContext } from "../../types.ts"

const ITEM = {
  title: "Wireguard Restart",
  summary: "Restart wg0 after changing the config.",
  tags: ["linux/network"],
  atoms: ["sudo systemctl restart wg0"],
}

function report(labels: string[], skipped: string[] = []): string {
  return ["```consolidated", ...labels, "```", "```skipped", ...skipped, "```"].join("\n")
}

function workspace(): Promise<{ directory: string; stateDir: string; vaultDir: string }> {
  return mkdtemp(join(tmpdir(), "memory-brain-")).then(async (root) => {
    const stateDir = join(root, "state")
    const vaultDir = join(root, "vault")
    await mkdir(stateDir, { recursive: true })
    await mkdir(vaultDir, { recursive: true })
    return { directory: root, stateDir, vaultDir }
  })
}

function client(opts: { reply?: string; fail?: boolean } = {}): MemoryWriteClient {
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
        return {
          data: [
            {
              info: { role: "assistant", tokens: { input: 10, output: 2 }, cost: 0.01 },
              parts: [{ type: "text", text: opts.reply ?? report(["#1"]) }],
            },
          ],
        }
      },
    },
  }
}

function ctx(
  ws: { directory: string; stateDir: string; vaultDir: string },
  c: MemoryWriteClient,
): WriteContext {
  return {
    directory: ws.directory,
    vaultDir: ws.vaultDir,
    config: { ...DEFAULT_DRAIN, writer_model: "test/writer" },
    client: c,
    waitForIdle: async () => true,
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
  const writes: any[] = []
  const c = client({ reply: report(["#1"]) })
  const original = c.session.promptAsync
  c.session.promptAsync = async (args: any) => {
    writes.push(args)
    return original(args)
  }

  const result = await provider.consolidate!([ITEM], ctx(ws, c))

  assert.equal(result.ok, true)
  assert.deepEqual(result.consumed, [1])
  assert.deepEqual(result.skipped, [])
  assert.ok((result.promptBytes ?? 0) > 0)
  assert.equal(result.session, "ses_writer")
  assert.match(writes[0].body.parts[0].text, /^Consolidation mode\./)
  assert.match(writes[0].body.parts[0].text, /### Knowledge item #1/)
  assert.equal(writes[0].body.agent, "rag-brain")
})

test("an invalid report is a permanent error that does not consume items", async () => {
  const ws = await workspace()
  const provider = createBrainProvider({ ...ws, drain: DEFAULT_DRAIN, summaryWords: 400 })
  const result = await provider.consolidate!([ITEM], ctx(ws, client({ reply: "no fences here" })))

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, "permanent")
  assert.deepEqual(result.consumed, [])
  assert.match(result.detail ?? "", /invalid report/)
})

test("a spawn failure is transient", async () => {
  const ws = await workspace()
  const provider = createBrainProvider({ ...ws, drain: DEFAULT_DRAIN, summaryWords: 400 })
  const result = await provider.consolidate!([ITEM], ctx(ws, client({ fail: true })))

  assert.equal(result.ok, false)
  assert.equal(result.errorKind, "transient")
  assert.match(result.detail ?? "", /spawn boom/)
})

test("pending counts turns after the cursor", async () => {
  const ws = await workspace()
  const dbFile = join(ws.directory, "opencode.db")
  const db = new DatabaseSync(dbFile)
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, data TEXT NOT NULL);
  `)
  db.prepare("INSERT INTO session (id, parent_id, directory, time_updated) VALUES (?, ?, ?, ?)").run(
    "top-1",
    null,
    ws.directory,
    2000,
  )
  db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
    "m1",
    "top-1",
    2000,
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
