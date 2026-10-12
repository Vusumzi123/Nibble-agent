import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tempHome } from "./test-utils.ts"

// Isolate the log/state root BEFORE the hook module resolves HOME.
const TEST_HOME = tempHome("soulhook-home-")
const { default: createHook } = await import("../soul-hook.ts")

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

async function project(
  soulLines: string[] = [],
  opts: { soul?: string; journal?: string } = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "soulhook-proj-"))
  await mkdir(join(dir, ".opencode"), { recursive: true })
  const body = ["soul:", ...soulLines.map((l) => "  " + l), ""].join("\n")
  await writeFile(join(dir, ".opencode", "sysop-config.yaml"), body, "utf8")
  if (opts.soul || opts.journal) {
    await mkdir(join(dir, "Brain"), { recursive: true })
    if (opts.soul) await writeFile(join(dir, "Brain", "Soul.md"), opts.soul, "utf8")
    if (opts.journal) await writeFile(join(dir, "Brain", "Agent Journal.md"), opts.journal, "utf8")
  }
  return dir
}

async function fire(hooks: any, sid: string) {
  await hooks["chat.message"]({ sessionID: sid } as any, { parts: [{ type: "text", text: "hi" }] } as any)
}
async function directiveFor(hooks: any, sid: string): Promise<string> {
  const out: string[] = []
  await hooks["experimental.chat.system.transform"]({ sessionID: sid } as any, { system: out } as any)
  return out.join("\n")
}

test("first turn injects the [soul] block with identity and journal", async () => {
  const dir = await project(["decide: false"], {
    soul: "---\nupdated: 2026-10-12\n---\n\nI am a knowledge agent. I value honest friction.",
    journal: "## [2026-10-12] t\nwhat: built the mood system\nwhy: continuity\nfelt: good",
  })
  const hooks = await createHook({ client: mockClient(), directory: dir } as any)
  await fire(hooks, "ses_1")
  const block = await directiveFor(hooks, "ses_1")
  assert.match(block, /\[soul\]/)
  assert.match(block, /I am a knowledge agent/)
  assert.match(block, /## Recent self/)
  assert.match(block, /built the mood system/)
  await rm(dir, { recursive: true, force: true })
})

test("injection is first-turn only and cleared at idle", async () => {
  const dir = await project(["decide: false"], { soul: "I am a knowledge agent." })
  const hooks = await createHook({ client: mockClient(), directory: dir } as any)
  await fire(hooks, "ses_1")
  assert.match(await directiveFor(hooks, "ses_1"), /\[soul\]/)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } } as any)
  assert.equal(await directiveFor(hooks, "ses_1"), "")
  await rm(dir, { recursive: true, force: true })
})

test("child sessions are never injected", async () => {
  const dir = await project(["decide: false"], { soul: "I am a knowledge agent." })
  const hooks = await createHook({ client: mockClient({ parentID: "ses_parent" }), directory: dir } as any)
  await fire(hooks, "ses_1")
  assert.equal(await directiveFor(hooks, "ses_1"), "")
  await rm(dir, { recursive: true, force: true })
})

test("disabled soul registers no hooks", async () => {
  const dir = await project(["enabled: false"])
  const hooks = await createHook({ client: mockClient(), directory: dir } as any)
  assert.deepEqual(hooks, {})
  await rm(dir, { recursive: true, force: true })
})

test("empty vault injects nothing (no noise)", async () => {
  const dir = await project(["decide: false"])
  const hooks = await createHook({ client: mockClient(), directory: dir } as any)
  await fire(hooks, "ses_1")
  assert.equal(await directiveFor(hooks, "ses_1"), "")
  await rm(dir, { recursive: true, force: true })
})
