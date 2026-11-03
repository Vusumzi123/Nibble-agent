import { test } from "node:test"
import assert from "node:assert/strict"
import type { ChildExecutor, ChildOutcome, ChildRequest } from "./child.ts"
import type { DrainTurn } from "./db.ts"
import type { RenderedSession } from "./render.ts"
import { hashContent } from "./render.ts"
import {
  SUMMARY_ITEMS_TOOL,
  buildSummarizerPrompt,
  deterministicItems,
  summarizeSession,
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

function toolRows(input: unknown, text = "done"): unknown[] {
  return [
    {
      info: { role: "assistant", time: { created: 1, completed: 2 }, finish: "stop" },
      parts: [
        { type: "text", text },
        { type: "tool", tool: SUMMARY_ITEMS_TOOL, state: { input } },
      ],
    },
  ]
}

type FakeResult = Partial<ChildOutcome>

function childOutcome(request: ChildRequest, overrides: FakeResult = {}): ChildOutcome {
  return {
    jobId: request.id ?? "ses_sum",
    sessionID: "ses_sum",
    phase: "complete",
    ok: true,
    started: true,
    rows: [],
    replies: [],
    late: false,
    timedOut: false,
    attempts: 1,
    tokens: 16,
    spawnMs: 1,
    runMs: 2,
    queueMs: null,
    steps: 1,
    spanMs: 5,
    modelMs: 4,
    toolMs: 1,
    cost: 0,
    ...overrides,
  }
}

function fakeExecutor(opts: {
  spawn?: FakeResult
  prompt?: FakeResult
  failSpawn?: boolean
} = {}): {
  executor: ChildExecutor
  calls: { spawn: ChildRequest[]; prompt: Array<{ sessionID: string; request: ChildRequest }>; abort: string[] }
} {
  const calls = {
    spawn: [] as ChildRequest[],
    prompt: [] as Array<{ sessionID: string; request: ChildRequest }>,
    abort: [] as string[],
  }
  const executor: ChildExecutor = {
    async spawn(request) {
      calls.spawn.push(request)
      if (opts.failSpawn) throw new Error("spawn boom")
      return childOutcome(request, opts.spawn)
    },
    async prompt(sessionID, request) {
      calls.prompt.push({ sessionID, request })
      return childOutcome(request, opts.prompt ?? opts.spawn)
    },
    async abort(sessionID) {
      calls.abort.push(sessionID)
    },
  }
  return { executor, calls }
}

const ITEMS = {
  items: [
    { title: "Wireguard Setup", tags: ["Linux/Network", "linux/network"], summary: "Configure wg0 with wg-quick.", atoms: ["/etc/wireguard/wg0.conf"] },
    { title: "wireguard setup", tags: [], summary: "Duplicate title.", atoms: [] },
  ],
}

test("prompt carries the tool contract, prior summary, and delta", () => {
  const prompt = buildSummarizerPrompt(null, "## User\nhello")
  assert.match(prompt, /summary_items/)
  assert.match(prompt, /## Prior summary\nnone/)
  assert.match(prompt, /## Session delta\n## User\nhello/)
  assert.equal(/=== ITEM ===/.test(prompt), false)
  assert.equal(/NO_ITEMS/.test(prompt), false)

  const withPrior = buildSummarizerPrompt("earlier context", "delta")
  assert.match(withPrior, /## Prior summary\nearlier context/)
})

test("successful summarization normalizes items and preserves atoms", async () => {
  const { executor, calls } = fakeExecutor({ spawn: { rows: toolRows(ITEMS) } })
  const result = await summarizeSession(
    { sessionID: "ses_1", rendered: rendered(), priorSummary: "earlier" },
    { executor, model: "test/model", maxItems: 6 },
  )

  assert.equal(result.degraded, undefined)
  assert.equal(result.items.length, 2)
  assert.equal(result.tokens, 16)
  assert.equal(result.model, "test/model")
  assert.equal(result.sessionID, "ses_sum")
  assert.equal(result.steps, 1)
  assert.equal(result.queueMs, null)

  assert.deepEqual(result.items[0].tags, ["linux/network"])
  assert.equal(result.items[1].title, "wireguard setup (2)")
  assert.ok(result.items[0].atoms.includes("--no-cache"), "missing atom must be attached")
  assert.equal(result.items[0].hash, hashContent(result.items[0].summary, result.items[0].atoms))
  assert.match(result.items[0].hash, /^[0-9a-f]{40}$/)

  assert.equal(calls.spawn[0].kind, "summarize")
  assert.equal(calls.spawn[0].agent, "session-summarizer")
  assert.equal(calls.spawn[0].model, "test/model")
  assert.ok(calls.spawn[0].prompt.includes("## Prior summary"))
  assert.equal(calls.prompt.length, 0)
})

test("the model key is omitted when no summarize model is configured", async () => {
  const { executor, calls } = fakeExecutor({ spawn: { rows: toolRows(ITEMS) } })
  await summarizeSession({ sessionID: "ses_1", rendered: rendered() }, { executor, maxItems: 6 })
  assert.equal("model" in calls.spawn[0], false)
})

test("maxItems caps the batch", async () => {
  const { executor } = fakeExecutor({ spawn: { rows: toolRows(ITEMS) } })
  const result = await summarizeSession(
    { sessionID: "ses_1", rendered: rendered() },
    { executor, maxItems: 1 },
  )
  assert.equal(result.items.length, 1)
})

test("a missing tool call gets one correction prompt and then falls back", async () => {
  const warnings: string[] = []
  const { executor, calls } = fakeExecutor({
    spawn: { rows: toolRows(undefined), replies: ["I could not summarize that."] },
    prompt: { rows: toolRows(undefined), replies: ["still no tool"] },
  })
  const result = await summarizeSession(
    { sessionID: "ses_1", rendered: rendered() },
    { executor, maxItems: 6, onWarn: (message) => warnings.push(message) },
  )

  assert.equal(calls.prompt.length, 1, "exactly one correction turn")
  assert.match(calls.prompt[0].request.prompt, /summary_items/)
  assert.equal(result.degraded, "summarizer-fallback")
  assert.match(result.error ?? "", /did not call summary_items|no valid/i)
  assert.equal(result.items.length, TURNS.length)
  assert.ok(result.items.every((item) => item.title.length > 0))
  assert.ok(warnings.length > 0)
})

test("a correction that calls the tool recovers the items", async () => {
  const { executor, calls } = fakeExecutor({
    spawn: { rows: toolRows(undefined), replies: ["I forgot the tool."] },
    prompt: { rows: toolRows(ITEMS) },
  })
  const result = await summarizeSession(
    { sessionID: "ses_1", rendered: rendered() },
    { executor, maxItems: 6 },
  )

  assert.equal(calls.prompt.length, 1)
  assert.equal(calls.prompt[0].sessionID, "ses_sum")
  assert.equal(result.degraded, undefined)
  assert.equal(result.items.length, 2)
})

test("an empty items array is a clean no-op", async () => {
  const warnings: string[] = []
  const { executor } = fakeExecutor({ spawn: { rows: toolRows({ items: [] }) } })
  const result = await summarizeSession(
    { sessionID: "ses_1", rendered: rendered() },
    { executor, maxItems: 6, onWarn: (message) => warnings.push(message) },
  )

  assert.equal(result.degraded, undefined)
  assert.equal(result.error, undefined)
  assert.deepEqual(result.items, [])
  assert.deepEqual(warnings, [])
})

test("a late reply with a valid tool call is used", async () => {
  const { executor, calls } = fakeExecutor({
    spawn: {
      rows: toolRows(ITEMS),
      timedOut: true,
      late: true,
      phase: "timeout",
      ok: false,
    },
  })
  const result = await summarizeSession(
    { sessionID: "ses_1", rendered: rendered() },
    { executor, maxItems: 6 },
  )

  assert.equal(result.degraded, undefined)
  assert.equal(result.lateReply, true)
  assert.equal(result.items.length, 2)
  assert.equal(calls.prompt.length, 0, "an aborted child is not prompted again")
})

test("a timeout without a reply falls back without a correction path", async () => {
  const { executor, calls } = fakeExecutor({
    spawn: { rows: [], timedOut: true, phase: "timeout", ok: false },
  })
  const result = await summarizeSession(
    { sessionID: "ses_1", rendered: rendered() },
    { executor, maxItems: 6 },
  )

  assert.equal(calls.prompt.length, 0)
  assert.equal(result.degraded, "summarizer-fallback")
  assert.equal(result.errorCode, "timeout")
})

test("a spawn error falls back deterministically", async () => {
  const { executor } = fakeExecutor({ failSpawn: true })
  const result = await summarizeSession(
    { sessionID: "ses_1", rendered: rendered() },
    { executor, maxItems: 6 },
  )
  assert.equal(result.degraded, "summarizer-fallback")
  assert.equal(result.errorCode, "spawn")
  assert.match(result.error ?? "", /spawn boom/)
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
