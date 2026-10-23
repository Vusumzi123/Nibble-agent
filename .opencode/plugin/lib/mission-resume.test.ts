import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DETERMINISTIC_DONE_MAX_CHARS,
  TRANSCRIPT_MAX_BYTES,
  buildMissionSummaryPrompt,
  deterministicResumeSummary,
  parseResumeReply,
  renderMissionTranscript,
  resumeContextBlock,
  summarizeMissionAttempt,
  type ResumePayload,
  type SummarizerClient,
} from "./mission-resume.ts"

function rows(...texts: string[]): unknown[] {
  return texts.map((text, i) => ({
    info: { role: i % 2 === 0 ? "user" : "assistant" },
    parts: [{ type: "text", text }],
  }))
}

test("renderMissionTranscript renders role: text and tool names/statuses only", () => {
  const out = renderMissionTranscript([
    { info: { role: "user" }, parts: [{ type: "text", text: "fix\nthe lock" }] },
    {
      info: { role: "assistant" },
      parts: [
        { type: "text", text: "editing file-lock.ts" },
        {
          type: "tool",
          tool: "bash",
          state: { status: "completed", input: { command: "cat secret" }, output: "TOP-SECRET-OUTPUT" },
        },
      ],
    },
  ])
  assert.match(out, /^user: fix the lock$/m)
  assert.match(out, /^assistant: editing file-lock\.ts \[tool bash:completed\]$/m)
  assert.ok(!out.includes("TOP-SECRET-OUTPUT"))
  assert.ok(!out.includes("cat secret"))
})

test("renderMissionTranscript caps by bytes and keeps the most recent lines", () => {
  const many = rows(...Array.from({ length: 120 }, (_, i) => `turn ${i} ${"x".repeat(1000)}`))
  const out = renderMissionTranscript(many)
  assert.ok(Buffer.byteLength(out, "utf8") <= TRANSCRIPT_MAX_BYTES)
  assert.match(out, /earlier transcript truncated/)
  assert.match(out, /turn 119 /)
  assert.doesNotMatch(out, /turn 0 /)

  const tight = renderMissionTranscript(many, 200)
  assert.ok(Buffer.byteLength(tight, "utf8") <= 200)
  assert.match(tight, /turn 119 /)
})

test("renderMissionTranscript skips empty rows", () => {
  assert.equal(
    renderMissionTranscript([
      { info: { role: "assistant" }, parts: [] },
      { info: { role: "user" }, parts: [{ type: "text", text: "  " }] },
    ]),
    "",
  )
})

test("parseResumeReply accepts strict JSON and tolerates fences", () => {
  const json = '{"done":"wrote module","remaining":"tests","next_steps":["run tests","move card"],"notes":"dirty tree"}'
  const parsed = parseResumeReply(json)
  assert.deepEqual(parsed, {
    done: "wrote module",
    remaining: "tests",
    next_steps: ["run tests", "move card"],
    notes: "dirty tree",
  })
  assert.deepEqual(parseResumeReply("```json\n" + json + "\n```"), parsed)
  assert.equal(parseResumeReply("not json"), null)
  assert.equal(parseResumeReply('{"done":"","remaining":"","next_steps":[],"notes":""}'), null)
  assert.equal(parseResumeReply('{"unrelated":true}'), null)
})

test("deterministicResumeSummary uses the last assistant text + tool outcomes", () => {
  const summary = deterministicResumeSummary(
    [
      { info: { role: "assistant" }, parts: [{ type: "text", text: "first try" }] },
      {
        info: { role: "assistant" },
        parts: [
          { type: "text", text: "y".repeat(DETERMINISTIC_DONE_MAX_CHARS + 100) },
          { type: "tool", tool: "bash", state: { status: "completed", output: "nope" } },
        ],
      },
    ],
    "summarizer timed out",
  )
  assert.equal(summary.done.length, DETERMINISTIC_DONE_MAX_CHARS)
  assert.match(summary.notes, /summary unavailable: summarizer timed out/)
  assert.match(summary.notes, /bash:completed/)
  assert.ok(!summary.notes.includes("nope"))
})

test("buildMissionSummaryPrompt carries the mission and JSON contract", () => {
  const prompt = buildMissionSummaryPrompt("user: hi", { id: "mission:x", title: "Do the thing" })
  assert.match(prompt, /\{"done":"","remaining":"","next_steps":\[""\],"notes":""\}/)
  assert.match(prompt, /mission:x — Do the thing/)
  assert.match(prompt, /## Transcript\nuser: hi/)
  assert.match(prompt, /tool outputs are omitted/i)
})

test("resumeContextBlock renders the resumed-mission block", () => {
  const payload: ResumePayload = {
    resume: true,
    prior_session: "ses_1",
    stopped_at: "2026-10-23T17:00:00.000Z",
    aborted: true,
    timeout_count: 1,
    summary: { done: "render", remaining: "tests", next_steps: ["run tests"], notes: "cap is 24KB" },
  }
  const block = resumeContextBlock(payload)
  assert.match(block, /^=== RESUMED MISSION - previous attempt stopped ===$/m)
  assert.match(block, /[Ss]topped at the mission timeout on 2026-10-23T17:00:00\.000Z \(session ses_1, aborted=true\)/)
  assert.match(block, /Completed: render \/ Not finished: tests/)
  assert.match(block, /Remaining steps, in order: run tests \/ Notes: cap is 24KB/)
  assert.match(block, /=== END RESUMED MISSION ===$/)
})

type FakeOptions = {
  replies?: string[]
  failCreate?: boolean
  failPrompt?: boolean
  failMessages?: boolean
  failAbort?: boolean
}

function fakeClient(opts: FakeOptions = {}): {
  client: SummarizerClient
  calls: { create: any[]; prompt: any[]; messages: any[]; abort: any[] }
} {
  const calls = { create: [] as any[], prompt: [] as any[], messages: [] as any[], abort: [] as any[] }
  let replyIndex = 0
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
        return { response: { ok: true } }
      },
      async messages(args) {
        calls.messages.push(args)
        if (opts.failMessages) throw new Error("messages failed")
        const text = opts.replies?.[Math.min(replyIndex++, (opts.replies?.length ?? 1) - 1)] ?? "{}"
        return { data: [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }] }
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

const deps = (client: SummarizerClient, overrides: Record<string, unknown> = {}) => ({
  client,
  directory: "/tmp/nibble",
  timeoutMs: 5_000,
  waitForIdle: async (_id: string, _ms: number) => true,
  ...overrides,
})

test("summarizeMissionAttempt returns the parsed strict JSON", async () => {
  const { client, calls } = fakeClient({
    replies: ['{"done":"wrote mission-resume.ts","remaining":"wire P4c","next_steps":["append block"],"notes":"dirty tree"}'],
  })
  const result = await summarizeMissionAttempt(
    { transcript: "user: go", mission: { id: "mission:p4a" } },
    deps(client),
  )
  assert.equal(result.degraded, undefined)
  assert.deepEqual(result.summary, {
    done: "wrote mission-resume.ts",
    remaining: "wire P4c",
    next_steps: ["append block"],
    notes: "dirty tree",
  })
  assert.equal(calls.prompt[0].body.agent, "session-summarizer")
  assert.equal(calls.abort.length, 0)
  assert.ok(result.promptBytes > 0)
})

test("summarizeMissionAttempt retries malformed JSON once, then falls back", async () => {
  const { client, calls } = fakeClient({ replies: ["nope", "still nope"] })
  const result = await summarizeMissionAttempt(
    {
      transcript: "assistant: partial work",
      mission: { id: "mission:p4a" },
      rows: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "partial work" }] }],
    },
    deps(client),
  )
  assert.equal(result.degraded, "summarizer-fallback")
  assert.equal(result.summary.done, "partial work")
  assert.match(result.error ?? "", /malformed summarizer reply/)
  assert.equal(calls.prompt.length, 2)
  assert.equal(calls.abort.length, 2)
})

test("summarizeMissionAttempt aborts its child on timeout", async () => {
  const { client, calls } = fakeClient({ replies: ["{}"] })
  const result = await summarizeMissionAttempt(
    { transcript: "user: go", mission: { id: "mission:x" }, rows: rows("go") },
    deps(client, { waitForIdle: async () => false }),
  )
  assert.equal(result.degraded, "summarizer-fallback")
  assert.match(result.error ?? "", /timed out/)
  assert.deepEqual(calls.abort[0].path, { id: "ses_sum" })
})

test("summarizeMissionAttempt records a failed abort, never claims a stop", async () => {
  const { client } = fakeClient({ replies: ["{}"], failAbort: true })
  const result = await summarizeMissionAttempt(
    { transcript: "user: go", mission: { id: "mission:x" } },
    deps(client, { waitForIdle: async () => false }),
  )
  assert.match(result.error ?? "", /timed out; abort failed: abort rejected/)
})

test("summarizeMissionAttempt degrades on spawn failure without throwing", async () => {
  const { client } = fakeClient({ failCreate: true })
  const result = await summarizeMissionAttempt(
    { transcript: "user: go", mission: { id: "mission:x" } },
    deps(client),
  )
  assert.equal(result.degraded, "summarizer-fallback")
  assert.match(result.error ?? "", /create failed/)
  assert.equal(result.summary.done, "unknown")
})
