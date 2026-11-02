import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { mockClient, tempDir, tempHome } from "./test-utils.ts"
import { createChron, getChron, resetChronForTests } from "./chron/chron.ts"
import type { ChronLog } from "./chron/types.ts"
import { registerChronBridge } from "./chron-bridge.ts"
import { listPendingTasks, taskSettled } from "./user-tasks.ts"

// Isolate HOME before the hook module resolves anything home-scoped.
const TEST_HOME = tempHome("chron-e2e-home-")
void TEST_HOME
const { default: createHook } = await import("../heartbeat-hook.ts")

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await delay(25)
  }
  throw new Error("waitFor: condition not met within timeout")
}

const silentLog: ChronLog = { event: () => {}, warn: () => {} }

async function writeProject(): Promise<{ dir: string; stateDir: string }> {
  const dir = await tempDir("chron-e2e-")
  await mkdir(join(dir, ".opencode", "schedule"), { recursive: true })
  await mkdir(join(dir, ".opencode", "missions"), { recursive: true })
  await writeFile(
    join(dir, ".opencode", "sysop-config.yaml"),
    ["autonomy:", "  level: 3", ""].join("\n"),
    "utf8",
  )
  await writeFile(
    join(dir, ".opencode", "schedule", "smoke.md"),
    ["---", "id: smoke", "schedule: every 1m", "---", "Write the word smoke to the log.", ""].join(
      "\n",
    ),
    "utf8",
  )
  await writeFile(
    join(dir, ".opencode", "missions", "user-task.md"),
    [
      "---",
      "id: user-task",
      "title: Execute one queued user task",
      "priority: 2",
      "menus: [both]",
      "min_level: 2",
      "approval: writes-follow-dial",
      "candidacy: always",
      "enqueue: item",
      'agent: ""',
      "enabled: true",
      "---",
      "",
      "Run the queued task.",
      "",
    ].join("\n"),
    "utf8",
  )
  return { dir, stateDir: join(dir, ".opencode", "state") }
}

function e2eClient() {
  const calls = { create: 0, prompts: [] as any[], ids: [] as string[] }
  return {
    calls,
    session: {
      get: async () => ({ data: {} }),
      messages: async () => ({
        data: [
          {
            info: { role: "assistant", id: "a1", tokens: { input: 15, output: 5 } },
            parts: [
              {
                type: "tool",
                tool: "mission_result",
                state: { input: { status: "completed", summary: "smoke written" } },
              },
              { type: "text", text: "smoke written" },
            ],
          },
        ],
      }),
      create: async () => {
        calls.create++
        const id = `ses_e2e_${calls.create}`
        calls.ids.push(id)
        return { data: { id } }
      },
      promptAsync: async (args: any) => {
        calls.prompts.push(args)
        return { response: { ok: true, status: 200 } }
      },
    },
  }
}

test("chron prompt job -> user task -> consumer run (end to end)", async () => {
  const { dir, stateDir } = await writeProject()
  const chron = createChron({
    directory: dir,
    stateDir,
    logDir: join(dir, ".opencode", "logs"),
    log: silentLog,
  })
  registerChronBridge(chron, { directory: dir, stateDir, log: silentLog })

  const t0 = Date.now()
  await chron.tick({ nowMs: t0 })
  await chron.tick({ nowMs: t0 + 60_000 })

  const pending = await listPendingTasks(stateDir)
  assert.equal(pending.length, 1, "one fire -> one prompt task")
  assert.equal(pending[0].requested_by, "chron")
  assert.equal(pending[0].dedupe_key, "chron:smoke")

  const client = e2eClient()
  const hooks = await createHook({ client, directory: dir } as any)
  await waitFor(() => client.calls.prompts.length >= 1)
  const childId = client.calls.prompts[0].path.id
  await hooks.event({
    event: { type: "session.idle", properties: { sessionID: childId } },
  } as any)

  await waitFor(async () => (await listPendingTasks(stateDir)).length === 0)
  assert.equal(await taskSettled(stateDir, pending[0].id), true)
})

test("chron-hook loads and registers its built-in code jobs", async () => {
  const { dir } = await writeProject()
  const { default: createChronHook } = await import("../chron-hook.ts")
  const result = await createChronHook({ client: mockClient(), directory: dir } as any)
  assert.deepEqual(result, {})

  const jobs = await getChron().list()
  assert.ok(jobs.some((job) => job.id === "missions"))
  assert.ok(jobs.some((job) => job.id === "drain"))
  resetChronForTests()
})
