import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tempHome } from "./test-utils.ts"

// Isolate the log/state root BEFORE the hook module resolves HOME.
const TEST_HOME = tempHome("mhook-home-")
const { default: createHook } = await import("../mood-hook.ts")

function mockClient(opts: { parentID?: string } = {}) {
  return {
    session: {
      get: async ({ path }: any) => ({
        data: opts.parentID && path.id === "ses_1" ? { parentID: opts.parentID } : {},
      }),
      messages: async () => ({ data: [] }),
      create: async () => ({ data: { id: "ses_child" } }),
      promptAsync: async () => ({ response: { ok: true, status: 200 } }),
    },
  }
}

async function project(moodLines: string[] = []): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mhook-proj-"))
  await mkdir(join(dir, ".opencode"), { recursive: true })
  const body = ["mood:", ...moodLines.map((l) => "  " + l), ""].join("\n")
  await writeFile(join(dir, ".opencode", "sysop-config.yaml"), body, "utf8")
  return dir
}

function stateFile(dir: string): string {
  return join(dir, ".opencode", "state", "mood.json")
}
function logFile(dir: string): string {
  return join(dir, ".opencode", "logs", "mood.ndjson")
}

async function readLog(dir: string): Promise<any[]> {
  try {
    const raw = await readFile(logFile(dir), "utf8")
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

async function fire(hooks: any, sid: string) {
  await hooks["chat.message"]({ sessionID: sid } as any, { parts: [{ type: "text", text: "hi" }] } as any)
}

async function directiveFor(hooks: any, sid: string): Promise<string> {
  const out: string[] = []
  await hooks["experimental.chat.system.transform"]({ sessionID: sid } as any, { system: out } as any)
  return out.join("\n")
}

test("a user message feeds `engaged` and journals to mood.ndjson", async () => {
  const dir = await project()
  const hooks = await createHook({ client: mockClient(), directory: dir } as any)
  await fire(hooks, "ses_1")
  const entries = await readLog(dir)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].event, "engaged")
  assert.ok(entries[0].valence_after > 0)
  await rm(dir, { recursive: true, force: true })
})

test("system.transform injects a [mood] line every turn", async () => {
  const dir = await project()
  const hooks = await createHook({ client: mockClient(), directory: dir } as any)
  const block = await directiveFor(hooks, "ses_1")
  assert.match(block, /\[mood\]/)
  await rm(dir, { recursive: true, force: true })
})

test("child sessions never feed `engaged`", async () => {
  const dir = await project()
  const hooks = await createHook({ client: mockClient({ parentID: "ses_parent" }), directory: dir } as any)
  await fire(hooks, "ses_1")
  const entries = await readLog(dir)
  assert.equal(entries.length, 0)
  await rm(dir, { recursive: true, force: true })
})

test("session idle decays and persists the state file", async () => {
  const dir = await project(["decay_half_life: 6h"])
  const hooks = await createHook({ client: mockClient(), directory: dir } as any)
  await fire(hooks, "ses_1")
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } } as any)
  const raw = JSON.parse(await readFile(stateFile(dir), "utf8"))
  assert.equal(raw.version, 1)
  assert.ok("valence" in raw && "arousal" in raw && "label" in raw)
  await rm(dir, { recursive: true, force: true })
})

test("a malformed half-life falls back to the default and still works", async () => {
  const dir = await project(["decay_half_life: bogus"])
  const hooks = await createHook({ client: mockClient(), directory: dir } as any)
  await fire(hooks, "ses_1")
  const entries = await readLog(dir)
  assert.equal(entries[0].event, "engaged")
  await rm(dir, { recursive: true, force: true })
})
