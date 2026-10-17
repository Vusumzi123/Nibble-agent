import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnConsolidationChild, type ConsolidationClient } from "./spawn.ts"

type Calls = { create: any[]; prompt: any[]; messages: any[] }

function client(opts: {
  failCreate?: boolean
  failPrompt?: boolean
  promptErrorResponse?: boolean
  rows?: unknown[]
} = {}): { client: ConsolidationClient; calls: Calls } {
  const calls: Calls = { create: [], prompt: [], messages: [] }
  return {
    calls,
    client: {
      session: {
        async create(args) {
          calls.create.push(args)
          if (opts.failCreate) throw new Error("create boom")
          return { data: { id: "ses_writer" } }
        },
        async promptAsync(args) {
          calls.prompt.push(args)
          if (opts.failPrompt) throw new Error("prompt boom")
          if (opts.promptErrorResponse) return { error: { message: "rejected" } }
          return { response: { ok: true } }
        },
        async messages(args) {
          calls.messages.push(args)
          return { data: opts.rows ?? [] }
        },
      },
    },
  }
}

const ROWS = [
  {
    info: { role: "assistant", tokens: { input: 10, output: 5 }, cost: 0.01 },
    parts: [{ type: "text", text: "first reply" }],
  },
  {
    info: { role: "assistant", tokens: { input: 2, output: 3 }, cost: 0.02 },
    parts: [{ type: "text", text: "second reply" }],
  },
]

test("spawns rag-brain directly in a top-level session and reads its reply", async () => {
  const { client: c, calls } = client({ rows: ROWS })
  const registered: string[] = []
  const result = await spawnConsolidationChild(c, {
    directory: "/work/project-a",
    prompt: "Consolidation mode.\nbody",
    model: "test/writer",
    waitForIdle: async () => true,
    registerChild: (id) => registered.push(id),
  })

  assert.equal(result.ok, true)
  assert.equal(result.sessionID, "ses_writer")
  assert.equal(result.reply, "second reply")
  assert.equal(result.tokens, 20)
  assert.ok(Math.abs((result.cost ?? 0) - 0.03) < 1e-9)
  assert.deepEqual(registered, ["ses_writer"])

  assert.equal(calls.create[0].body.title, "knowledge-consolidate")
  assert.equal(calls.create[0].body.parentID, undefined)
  assert.equal(calls.prompt[0].path.id, "ses_writer")
  assert.equal(calls.prompt[0].body.agent, "rag-brain")
  assert.equal(calls.prompt[0].body.model, "test/writer")
  assert.equal(calls.prompt[0].body.parts[0].text, "Consolidation mode.\nbody")
})

test("omits the model when writer_model is empty", async () => {
  const { client: c, calls } = client({ rows: ROWS })
  await spawnConsolidationChild(c, {
    directory: "/work",
    prompt: "Consolidation mode.",
    waitForIdle: async () => true,
  })
  assert.equal("model" in calls.prompt[0].body, false)
})

test("timeouts are non-fatal and reported", async () => {
  const { client: c } = client({ rows: ROWS })
  const result = await spawnConsolidationChild(c, {
    directory: "/work",
    prompt: "x",
    waitForIdle: async () => false,
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, "timeout")
})

test("prompt/create failures return ok:false instead of throwing", async () => {
  const rejected = await spawnConsolidationChild(client({ promptErrorResponse: true }).client, {
    directory: "/work",
    prompt: "x",
    waitForIdle: async () => true,
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error, "promptAsync failed")

  const failedPrompt = await spawnConsolidationChild(client({ failPrompt: true }).client, {
    directory: "/work",
    prompt: "x",
    waitForIdle: async () => true,
  })
  assert.equal(failedPrompt.ok, false)
  assert.match(failedPrompt.error ?? "", /prompt boom/)

  const failedCreate = await spawnConsolidationChild(client({ failCreate: true }).client, {
    directory: "/work",
    prompt: "x",
    waitForIdle: async () => true,
  })
  assert.equal(failedCreate.ok, false)
  assert.match(failedCreate.error ?? "", /create boom/)
})
