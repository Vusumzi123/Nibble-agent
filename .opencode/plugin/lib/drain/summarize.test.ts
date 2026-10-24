import { test } from "node:test"
import assert from "node:assert/strict"
import type { DrainTurn } from "./db.ts"
import type { RenderedSession } from "./render.ts"
import { hashContent } from "./render.ts"
import {
  buildSummarizerPrompt,
  deterministicItems,
  parseSummaryReply,
  repairJson,
  summarizeSession,
  SUMMARY_SCHEMA,
  type SummarizerClient,
} from "./summarize.ts"

const TURNS: DrainTurn[] = [
  { id: "m1", sessionID: "ses_1", time: 100, role: "user", text: "set up wireguard" },
  { id: "m2", sessionID: "ses_1", time: 200, role: "assistant", text: "used wg-quick" },
]

function rendered(): RenderedSession {
  return {
    sessionID: "ses_1",
    text: "## User\nset up wireguard\n\n## Assistant\nused wg-quick",
    atoms: ["/etc/wireguard/wg0.conf", "--no-cache"],
    turns: TURNS,
    bytes: 48,
  }
}

type FakeOptions = {
  reply?: string
  /** Sequenced replies: one per summarizer attempt (last one repeats). */
  replies?: string[]
  failCreate?: boolean
  failPrompt?: boolean
  /** Sequenced promptAsync errors: each entry is returned by that call. */
  promptErrors?: unknown[]
  failMessages?: boolean
  failAbort?: boolean
  tokens?: { input?: number; output?: number; reasoning?: number }
}

function fakeClient(opts: FakeOptions = {}): {
  client: SummarizerClient
  calls: { create: any[]; prompt: any[]; messages: any[]; abort: any[] }
} {
  const calls = { create: [] as any[], prompt: [] as any[], messages: [] as any[], abort: [] as any[] }
  let replyIndex = 0
  let promptIndex = 0
  const client: SummarizerClient = {
    session: {
      async create(args) {
        calls.create.push(args)
        if (opts.failCreate) throw new Error("create failed")
        return { data: { id: "ses_sum" } }
      },
      async promptAsync(args) {
        calls.prompt.push(args)
        if (opts.failPrompt) throw new Error("prompt failed")
        const error = opts.promptErrors?.[promptIndex++]
        if (error !== undefined) return { error }
        return { response: { ok: true } }
      },
      async messages(args) {
        calls.messages.push(args)
        if (opts.failMessages) throw new Error("messages failed")
        const text = opts.replies
          ? opts.replies[Math.min(replyIndex++, opts.replies.length - 1)] ?? "{}"
          : opts.reply ?? "{}"
        return {
          data: [
            {
              info: { role: "assistant", tokens: opts.tokens ?? { input: 10, output: 5, reasoning: 1 } },
              parts: [{ type: "text", text }],
            },
          ],
        }
      },
      async abort(args) {
        calls.abort.push(args)
        if (opts.failAbort) return { error: { message: "abort rejected" } }
        return { response: { ok: true } }
      },
    },
  }
  return { client, calls }
}

const REPLY = JSON.stringify({
  items: [
    {
      title: "Wireguard Setup",
      summary: "Configure wg0 with wg-quick.",
      tags: ["Linux/Network", "linux/network"],
      atoms: ["/etc/wireguard/wg0.conf"],
    },
    { title: "wireguard setup", summary: "Duplicate title.", tags: [], atoms: [] },
  ],
})

test("prompt carries the strict JSON contract, prior summary, and delta", () => {
  const prompt = buildSummarizerPrompt(null, "## User\nhello")
  assert.match(prompt, /Return STRICT JSON, nothing else:/)
  assert.match(prompt, /## Prior summary\nnone/)
  assert.match(prompt, /## Session delta\n## User\nhello/)

  const withPrior = buildSummarizerPrompt("earlier context", "delta")
  assert.match(withPrior, /## Prior summary\nearlier context/)
})

test("parseSummaryReply accepts bare and fenced JSON and rejects junk", () => {
  assert.equal(parseSummaryReply(REPLY)?.length, 2)
  assert.equal(parseSummaryReply("```json\n" + REPLY + "\n```")?.length, 2)
  assert.equal(parseSummaryReply("not json at all"), null)
  assert.equal(parseSummaryReply('{"items": "nope"}'), null)
})

test("successful summarization normalizes items and preserves atoms", async () => {
  const { client, calls } = fakeClient({ reply: REPLY })
  const result = await summarizeSession(
    { sessionID: "ses_1", rendered: rendered(), priorSummary: "earlier" },
    {
      client,
      directory: "/work/project-a",
      model: "test/model",
      maxItems: 6,
      waitForIdle: async () => true,
      registerChild: () => {},
    },
  )

  assert.equal(result.degraded, undefined)
  assert.equal(result.items.length, 2)
  assert.equal(result.tokens, 16)
  assert.equal(result.model, "test/model")

  assert.deepEqual(result.items[0].tags, ["linux/network"])
  assert.equal(result.items[1].title, "wireguard setup (2)")
  assert.ok(result.items[0].atoms.includes("--no-cache"), "missing atom must be attached")

  assert.equal(result.items[0].hash, hashContent(result.items[0].summary, result.items[0].atoms))
  assert.match(result.items[0].hash, /^[0-9a-f]{40}$/)

  assert.equal(calls.create[0].body.title, "drain-summarize")
  assert.equal(calls.create[0].query.directory, "/work/project-a")
  assert.equal(calls.prompt[0].body.agent, "session-summarizer")
  assert.equal(calls.prompt[0].body.model, "test/model")
  assert.ok(calls.prompt[0].body.parts[0].text.includes("## Prior summary"))
})

test("the model key is omitted when no summarize model is configured", async () => {
  const { client, calls } = fakeClient({ reply: REPLY })
  await summarizeSession(
    { sessionID: "ses_1", rendered: rendered() },
    { client, directory: "/work", maxItems: 6, waitForIdle: async () => true },
  )
  assert.equal("model" in calls.prompt[0].body, false)
})

test("maxItems caps the batch", async () => {
  const { client } = fakeClient({ reply: REPLY })
  const result = await summarizeSession(
    { sessionID: "ses_1", rendered: rendered() },
    { client, directory: "/work", maxItems: 1, waitForIdle: async () => true },
  )
  assert.equal(result.items.length, 1)
})

test("malformed replies fall back deterministically without throwing", async () => {
  const { client } = fakeClient({ reply: "I could not summarize that." })
  const result = await summarizeSession(
    { sessionID: "ses_1", rendered: rendered() },
    { client, directory: "/work", maxItems: 6, waitForIdle: async () => true },
  )

  assert.equal(result.degraded, "summarizer-fallback")
  assert.match(result.error ?? "", /malformed|no valid/i)
  assert.equal(result.items.length, TURNS.length)
  assert.ok(result.items.every((item) => item.title.length > 0))
  assert.ok(result.items[0].atoms.length > 0)
  assert.equal(result.items[0].hash, hashContent(result.items[0].summary, result.items[0].atoms))
})

test("an empty items array is a clean no-op, not a malformed reply", async () => {
  const warnings: string[] = []
  const { client } = fakeClient({ reply: '{"items":[]}' })
  const result = await summarizeSession(
    { sessionID: "ses_1", rendered: rendered() },
    {
      client,
      directory: "/work",
      maxItems: 6,
      waitForIdle: async () => true,
      onWarn: (message) => warnings.push(message),
    },
  )

  assert.equal(result.degraded, undefined)
  assert.equal(result.error, undefined)
  assert.deepEqual(result.items, [])
  assert.deepEqual(warnings, [])
})

test("a malformed reply is retried once with a correction note", async () => {
  const warnings: string[] = []
  const { client, calls } = fakeClient({ replies: ["not json", REPLY] })
  const result = await summarizeSession(
    { sessionID: "ses_1", rendered: rendered() },
    {
      client,
      directory: "/work",
      maxItems: 6,
      waitForIdle: async () => true,
      onWarn: (message) => warnings.push(message),
    },
  )

  assert.equal(result.degraded, undefined)
  assert.equal(result.items.length, 2)
  assert.equal(calls.create.length, 2, "one fresh summarizer session per attempt")
  assert.equal(calls.prompt.length, 2)
  assert.match(calls.prompt[1].body.parts[0].text, /previous reply was cut off/)
  assert.deepEqual(warnings, [])
})

test("timeouts and spawn errors degrade to the fallback", async () => {
  const timedOutClient = fakeClient({ reply: REPLY })
  const timedOut = await summarizeSession(
    { sessionID: "ses_1", rendered: rendered() },
    {
      client: timedOutClient.client,
      directory: "/work",
      maxItems: 6,
      waitForIdle: async () => false,
    },
  )
  assert.equal(timedOut.degraded, "summarizer-fallback")
  assert.match(timedOut.error ?? "", /timed out/)
  assert.equal(timedOutClient.calls.abort.length, 1, "timed-out child is aborted")
  assert.equal(timedOutClient.calls.abort[0].path.id, "ses_sum")

  const failedAbort = fakeClient({ reply: REPLY, failAbort: true })
  const abortResult = await summarizeSession(
    { sessionID: "ses_1", rendered: rendered() },
    {
      client: failedAbort.client,
      directory: "/work",
      maxItems: 6,
      waitForIdle: async () => false,
    },
  )
  assert.equal(abortResult.degraded, "summarizer-fallback")
  assert.match(abortResult.error ?? "", /abort failed: abort rejected/)

  const crashed = await summarizeSession(
    { sessionID: "ses_1", rendered: rendered() },
    {
      client: fakeClient({ failCreate: true }).client,
      directory: "/work",
      maxItems: 6,
      waitForIdle: async () => true,
    },
  )
  assert.equal(crashed.degraded, "summarizer-fallback")
  assert.match(crashed.error ?? "", /create failed/)
})

test("deterministic items dedupe identical titles and keep all atoms", () => {
  const duplicate: RenderedSession = {
    sessionID: "ses_1",
    text: "## User\nsame text\n\n## Assistant\nsame text",
    atoms: ["--flag"],
    turns: [
      { id: "m1", sessionID: "ses_1", time: 1, role: "user", text: "same text" },
      { id: "m2", sessionID: "ses_1", time: 2, role: "assistant", text: "same text" },
    ],
    bytes: 40,
  }
  const items = deterministicItems(duplicate, 6)
  assert.equal(items.length, 2)
  assert.notEqual(items[0].title, items[1].title)
  assert.ok(items.some((item) => item.atoms.includes("--flag")))
})

test("registered child id is the spawned summarizer session", async () => {
  const registered: string[] = []
  await summarizeSession(
    { sessionID: "ses_1", rendered: rendered() },
    {
      client: fakeClient({ reply: REPLY }).client,
      directory: "/work",
      maxItems: 6,
      waitForIdle: async () => true,
      registerChild: (id) => registered.push(id),
    },
  )
  assert.deepEqual(registered, ["ses_sum"])
})

test("repairJson recovers each recorded truncation shape", () => {
  const truncatedAfterAtoms = '{"items":[{"title":"A","summary":"S","tags":[],"atoms":["2026-09-24"]'
  const truncatedMidItem =
    '{"items":[{"title":"A","summary":"S","tags":[],"atoms":["x"]},{"title":"B","summary":"unfin'
  const missingRoot = '{"items":[{"title":"A","summary":"S","tags":[],"atoms":[]}]'
  const fenced = "```json\n" + truncatedAfterAtoms + "\n```"
  const braceInString = '{"items":[{"title":"A } B","summary":"S","tags":[],"atoms":["x"]'

  for (const [shape, title] of [
    [truncatedAfterAtoms, "A"],
    [truncatedMidItem, "A"],
    [missingRoot, "A"],
    [fenced, "A"],
    [braceInString, "A } B"],
  ] as const) {
    const fixed = repairJson(shape)
    assert.ok(fixed, shape)
    const items = parseSummaryReply(fixed)
    assert.ok(items && items.length > 0, shape)
    assert.equal(items[0].title, title, shape)
  }

  assert.equal(repairJson(REPLY), REPLY, "a complete reply is returned unchanged")
  assert.equal(repairJson("no json here"), null)
})

test("the structured-output format is sent, switched, or omitted", async () => {
  const schemaRun = fakeClient({ reply: REPLY })
  const schemaResult = await summarizeSession(
    { sessionID: "ses_1", rendered: rendered() },
    { client: schemaRun.client, directory: "/work", format: "json_schema", maxItems: 6, waitForIdle: async () => true },
  )
  assert.deepEqual(schemaRun.calls.prompt[0].body.format, {
    type: "json_schema",
    schema: SUMMARY_SCHEMA,
  })
  assert.equal(schemaResult.format, "json_schema")
  assert.equal(schemaResult.closed, true)
  assert.equal(schemaResult.repaired, false)
  assert.equal(schemaResult.replyBytes, Buffer.byteLength(REPLY, "utf8"))

  const objectRun = fakeClient({ reply: REPLY })
  await summarizeSession(
    { sessionID: "ses_1", rendered: rendered() },
    { client: objectRun.client, directory: "/work", format: "json_object", maxItems: 6, waitForIdle: async () => true },
  )
  assert.deepEqual(objectRun.calls.prompt[0].body.format, {
    type: "json_schema",
    schema: { type: "object", additionalProperties: true },
  })

  const offRun = fakeClient({ reply: REPLY })
  await summarizeSession(
    { sessionID: "ses_1", rendered: rendered() },
    { client: offRun.client, directory: "/work", format: "off", maxItems: 6, waitForIdle: async () => true },
  )
  assert.equal("format" in offRun.calls.prompt[0].body, false)
})

test("a provider that rejects format is retried once without it", async () => {
  const { client, calls } = fakeClient({
    reply: REPLY,
    promptErrors: [{ message: "unsupported parameter: response_format" }],
  })
  const result = await summarizeSession(
    { sessionID: "ses_1", rendered: rendered() },
    { client, directory: "/work", maxItems: 6, waitForIdle: async () => true },
  )

  assert.equal(result.degraded, undefined)
  assert.equal(result.formatFallback, true)
  assert.equal(calls.prompt.length, 2)
  assert.ok("format" in calls.prompt[0].body)
  assert.equal("format" in calls.prompt[1].body, false)
  assert.equal(calls.abort.length, 1)
})

test("a silent empty structured reply is retried once without format", async () => {
  const { client, calls } = fakeClient({ replies: ["", REPLY] })
  const result = await summarizeSession(
    { sessionID: "ses_1", rendered: rendered() },
    { client, directory: "/work", maxItems: 6, waitForIdle: async () => true },
  )

  assert.equal(result.degraded, undefined)
  assert.equal(result.formatFallback, true)
  assert.equal(calls.prompt.length, 2)
  assert.ok("format" in calls.prompt[0].body)
  assert.equal("format" in calls.prompt[1].body, false)
  assert.equal(calls.abort.length, 1)
  assert.ok((result.replyBytes ?? 0) > 0)
  assert.ok(result.items.length > 0)
})

test("an unrelated prompt error does not retry without format", async () => {
  const { client, calls } = fakeClient({
    reply: REPLY,
    promptErrors: [{ message: "model overloaded" }],
  })
  const result = await summarizeSession(
    { sessionID: "ses_1", rendered: rendered() },
    { client, directory: "/work", maxItems: 6, waitForIdle: async () => true },
  )

  assert.equal(result.degraded, "summarizer-fallback")
  assert.match(result.error ?? "", /model overloaded/)
  assert.equal(calls.prompt.length, 1)
  assert.equal(result.formatFallback, undefined)
})

test("a truncated reply is repaired and normalized like a complete reply", async () => {
  const truncated =
    '{"items":[{"title":"Wireguard Setup","summary":"Configure wg0 with wg-quick.","tags":["Linux/Network"],"atoms":["/etc/wireguard/wg0.conf","--no-cache"]'
  const { client } = fakeClient({ reply: truncated })
  const result = await summarizeSession(
    { sessionID: "ses_1", rendered: rendered() },
    { client, directory: "/work", maxItems: 6, waitForIdle: async () => true },
  )

  assert.equal(result.degraded, undefined)
  assert.equal(result.closed, false)
  assert.equal(result.repaired, true)
  assert.equal(result.items.length, 1)
  assert.deepEqual(result.items[0].tags, ["linux/network"])
  assert.ok(result.items[0].atoms.includes("/etc/wireguard/wg0.conf"))
  assert.equal(result.items[0].hash, hashContent(result.items[0].summary, result.items[0].atoms))
})
