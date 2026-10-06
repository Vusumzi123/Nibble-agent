import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tempHome } from "./test-utils.ts"
import { clearLoggerCache } from "./logging.ts"

// Isolate the log root BEFORE the hook module resolves HOME.
const TEST_HOME = tempHome("telhook-home-")

const { default: createHook } = await import("../telemetry-hook.ts")

// Logs are project-local: <project>/.opencode/logs/ (fresh dir per test).
function brainLog(dir: string): string {
  return join(dir, ".opencode", "logs", "rag-search.log")
}

function webLogPath(dir: string): string {
  return join(dir, ".opencode", "logs", "web-usage.log")
}

// One assistant step carrying usage + a tool call, matching drainAccounting's
// expected `info.tokens` shape.
const childRow = {
  info: {
    role: "assistant",
    id: "d1",
    tokens: { input: 1200, output: 300, reasoning: 40, cache: { read: 100, write: 20 } },
    cost: 0.004,
  },
  parts: [{ type: "tool" }, { type: "text", text: "ok" }],
}

// Fresh project dirs carry no logs; only the process-wide logger cache needs
// resetting between tests.
async function reset(): Promise<void> {
  clearLoggerCache()
}

async function freshProject(config?: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "telhook-proj-"))
  if (config) {
    await mkdir(join(dir, ".opencode"), { recursive: true })
    await writeFile(
      join(dir, ".opencode", "sysop-config.yaml"),
      ["telemetry:", ...config.map((l) => "  " + l), ""].join("\n"),
      "utf8",
    )
  }
  return dir
}

async function readLog(file: string): Promise<any[]> {
  try {
    const raw = await readFile(file, "utf8")
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

function mockClient(opts: {
  childMessages?: any[]
  messagesThrow?: boolean
  meta?: Record<string, any>
} = {}) {
  const calls = { messages: 0, messagesIds: [] as string[] }
  return {
    calls,
    session: {
      get: async ({ path }: any) => ({ data: opts.meta?.[path.id] ?? {} }),
      messages: async ({ path }: any) => {
        calls.messages++
        calls.messagesIds.push(path.id)
        if (opts.messagesThrow) throw new Error("boom")
        return { data: opts.childMessages ?? [] }
      },
    },
  }
}

function taskOutput(metadata: Record<string, unknown>, state = "completed") {
  return {
    title: "task",
    output: `<task id="t1" state="${state}">done</task>`,
    metadata,
  }
}

async function fire(
  hooks: any,
  args: Record<string, unknown>,
  output: unknown,
  callID = "call_1",
): Promise<void> {
  await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_parent", callID }, { args } as any)
  await hooks["tool.execute.after"](
    { tool: "task", sessionID: "ses_parent", callID, args },
    output as any,
  )
}

test("a rag-search delegation emits one brain line with summed usage", async () => {
  await reset()
  const dir = await freshProject()
  const client = mockClient({ childMessages: [childRow] })
  const hooks = await createHook({ client, directory: dir } as any)

  const prompt = "rag-search: find the WAL policy\nBudget: ..."
  await fire(
    hooks,
    { subagent_type: "rag-search", description: "search the vault", prompt },
    taskOutput({
      sessionId: "ses_child",
      parentSessionId: "ses_parent",
      model: { providerID: "deepseek", modelID: "deepseek-flash" },
    }),
  )

  const brain = await readLog(brainLog(dir))
  assert.equal(brain.length, 1)
  const e = brain[0]
  assert.equal(e.event, "rag-search")
  assert.equal(e.delegate, "rag-search")
  assert.equal(e.childSession, "ses_child")
  assert.equal(e.parentSession, "ses_parent")
  assert.equal(e.topSession, "ses_parent")
  assert.equal(e.description, "search the vault")
  assert.equal(e.promptBytes, Buffer.byteLength(prompt, "utf8"))
  assert.equal(e.outcome, "ok")
  assert.equal(e.usage.inputTokens, 1200)
  assert.equal(e.usage.outputTokens, 300)
  assert.equal(e.usage.reasoningTokens, 40)
  assert.equal(e.usage.cacheReadTokens, 100)
  assert.equal(e.usage.cacheWriteTokens, 20)
  assert.equal(e.usage.toolCalls, 1)
  assert.equal(e.usage.usageKnown, true)
  assert.equal(typeof e.wallMs, "number")
  assert.equal((await readLog(webLogPath(dir))).length, 0)
  await rm(dir, { recursive: true, force: true })
})

test("a browser delegation routes to the web ledger as web-task", async () => {
  await reset()
  const dir = await freshProject()
  const hooks = await createHook({ client: mockClient({ childMessages: [childRow] }), directory: dir } as any)

  await fire(
    hooks,
    { subagent_type: "safe-browser", description: "look up htop", prompt: "fetch ..." },
    taskOutput({ sessionId: "ses_child", parentSessionId: "ses_parent" }),
  )

  const web = await readLog(webLogPath(dir))
  assert.equal(web.length, 1)
  assert.equal(web[0].event, "web-task")
  assert.equal(web[0].delegate, "safe-browser")
  assert.equal((await readLog(brainLog(dir))).length, 0)
  await rm(dir, { recursive: true, force: true })
})

test("an unwatched agent emits nothing", async () => {
  await reset()
  const dir = await freshProject()
  const hooks = await createHook({ client: mockClient(), directory: dir } as any)

  await fire(
    hooks,
    { subagent_type: "general", description: "do work", prompt: "x" },
    taskOutput({ sessionId: "ses_child", parentSessionId: "ses_parent" }),
  )

  assert.equal((await readLog(brainLog(dir))).length, 0)
  assert.equal((await readLog(webLogPath(dir))).length, 0)
  await rm(dir, { recursive: true, force: true })
})

test("a missing child session id degrades to an error line and never throws", async () => {
  await reset()
  const dir = await freshProject()
  const hooks = await createHook({ client: mockClient(), directory: dir } as any)

  await fire(
    hooks,
    { subagent_type: "rag-search", description: "search", prompt: "x" },
    taskOutput({ parentSessionId: "ses_parent" }),
  )

  const brain = await readLog(brainLog(dir))
  assert.equal(brain.length, 1)
  assert.equal(brain[0].outcome, "error")
  assert.equal(brain[0].reason, "no-child")
  assert.ok(!("usage" in brain[0]))
  await rm(dir, { recursive: true, force: true })
})

test("a duplicate after for one callID emits exactly one line", async () => {
  await reset()
  const dir = await freshProject()
  const hooks = await createHook({ client: mockClient({ childMessages: [childRow] }), directory: dir } as any)
  const args = { subagent_type: "rag-search", description: "search", prompt: "x" }
  const output = taskOutput({ sessionId: "ses_child", parentSessionId: "ses_parent" })

  await fire(hooks, args, output)
  await hooks["tool.execute.after"](
    { tool: "task", sessionID: "ses_parent", callID: "call_1", args },
    output as any,
  )

  assert.equal((await readLog(brainLog(dir))).length, 1)
  await rm(dir, { recursive: true, force: true })
})

test("a background task records outcome background without reading usage", async () => {
  await reset()
  const dir = await freshProject()
  const client = mockClient({ childMessages: [childRow] })
  const hooks = await createHook({ client, directory: dir } as any)

  await fire(
    hooks,
    { subagent_type: "rag-search", description: "search", prompt: "x" },
    taskOutput({ sessionId: "ses_child", parentSessionId: "ses_parent", background: true, jobId: "job_1" }, "running"),
  )

  const brain = await readLog(brainLog(dir))
  assert.equal(brain.length, 1)
  assert.equal(brain[0].outcome, "background")
  assert.ok(!("usage" in brain[0]))
  assert.equal(client.calls.messages, 0)
  await rm(dir, { recursive: true, force: true })
})

test("a child-messages read failure becomes an error line and never throws", async () => {
  await reset()
  const dir = await freshProject()
  const hooks = await createHook({ client: mockClient({ messagesThrow: true }), directory: dir } as any)

  await fire(
    hooks,
    { subagent_type: "rag-search", description: "search", prompt: "x" },
    taskOutput({ sessionId: "ses_child", parentSessionId: "ses_parent" }),
  )

  const brain = await readLog(brainLog(dir))
  assert.equal(brain.length, 1)
  assert.equal(brain[0].outcome, "error")
  assert.ok(!("usage" in brain[0]))
  await rm(dir, { recursive: true, force: true })
})

test("a resume call resolves the agent from the child session meta", async () => {
  await reset()
  const dir = await freshProject()
  const hooks = await createHook({
    client: mockClient({ childMessages: [childRow], meta: { ses_child: { agent: "rag-search" } } }),
    directory: dir,
  } as any)

  await fire(hooks, { description: "continue", prompt: "x", task_id: "t1" }, taskOutput({ sessionId: "ses_child" }))

  const brain = await readLog(brainLog(dir))
  assert.equal(brain.length, 1)
  assert.equal(brain[0].delegate, "rag-search")
  await rm(dir, { recursive: true, force: true })
})

test("an error envelope overrides an otherwise-ok outcome", async () => {
  await reset()
  const dir = await freshProject()
  const hooks = await createHook({ client: mockClient({ childMessages: [childRow] }), directory: dir } as any)

  await fire(
    hooks,
    { subagent_type: "rag-search", description: "search", prompt: "x" },
    taskOutput({ sessionId: "ses_child", parentSessionId: "ses_parent" }, "error"),
  )

  const brain = await readLog(brainLog(dir))
  assert.equal(brain[0].outcome, "error")
  await rm(dir, { recursive: true, force: true })
})

test("telemetry disabled registers no handlers", async () => {
  await reset()
  const dir = await freshProject(["enabled: false"])
  const hooks = await createHook({ client: mockClient(), directory: dir } as any)
  assert.deepEqual(hooks, {})
  await rm(dir, { recursive: true, force: true })
})
