import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tempHome } from "./test-utils.ts"

// Isolate the log/state root BEFORE the hook module resolves HOME.
const TEST_HOME = tempHome("phook-home-")
const { default: createHook } = await import("../profile-hook.ts")

const AGENT_NOTE = ["---", "title: Agent", "---", "", "# Agent — Operating Instructions", "", "Answer first. No preamble."].join("\n")
const USER_NOTE = ["---", "title: User", "---", "", "# User — Context", "", "Address the user by name."].join("\n")

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

async function project(profile: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "phook-proj-"))
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await mkdir(join(dir, "Brain"), { recursive: true })
  await writeFile(join(dir, ".opencode", "sysop-config.yaml"), ["profile:", ...profile.map((l) => "  " + l), ""].join("\n"), "utf8")
  await writeFile(join(dir, "Brain", "Agent.md"), AGENT_NOTE, "utf8")
  await writeFile(join(dir, "Brain", "User.md"), USER_NOTE, "utf8")
  return dir
}

async function inject(hooks: any, sid: string): Promise<string> {
  const out: string[] = []
  await hooks["experimental.chat.system.transform"]({ sessionID: sid } as any, { system: out } as any)
  return out.join("\n")
}

test("profile disabled registers no hooks at all", async () => {
  const dir = await project(["enabled: false"])
  const hooks = await createHook({ client: mockClient(), directory: dir } as any)
  assert.deepEqual(hooks, {})
  await rm(dir, { recursive: true, force: true })
})

test("the first turn injects both profile notes as a [profile] block", async () => {
  const dir = await project(["enabled: true", "inject: true", "decide: false"])
  const hooks = await createHook({ client: mockClient(), directory: dir } as any)
  assert.equal(await inject(hooks, "ses_1"), "", "nothing injected before chat.message")
  await hooks["chat.message"]({ sessionID: "ses_1" } as any, {} as any)
  const block = await inject(hooks, "ses_1")
  assert.match(block, /^\[profile\] Operating instructions/)
  assert.match(block, /## Agent \(persona & behavior\)/)
  assert.match(block, /Answer first\. No preamble\./)
  assert.match(block, /## User \(user context\)/)
  assert.match(block, /Address the user by name\./)
  await rm(dir, { recursive: true, force: true })
})

test("the block is cleared after the first session idle and never returns", async () => {
  const dir = await project(["enabled: true", "inject: true", "decide: false"])
  const hooks = await createHook({ client: mockClient(), directory: dir } as any)
  await hooks["chat.message"]({ sessionID: "ses_1" } as any, {} as any)
  assert.match(await inject(hooks, "ses_1"), /\[profile\]/)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } } as any)
  assert.equal(await inject(hooks, "ses_1"), "")
  await hooks["chat.message"]({ sessionID: "ses_1" } as any, {} as any)
  assert.equal(await inject(hooks, "ses_1"), "")
  await rm(dir, { recursive: true, force: true })
})

test("child sessions are never injected", async () => {
  const dir = await project(["enabled: true", "inject: true", "decide: false"])
  const hooks = await createHook({ client: mockClient({ parentID: "ses_parent" }), directory: dir } as any)
  await hooks["chat.message"]({ sessionID: "ses_1" } as any, {} as any)
  assert.equal(await inject(hooks, "ses_1"), "")
  await rm(dir, { recursive: true, force: true })
})

test("a missing profile note yields no block instead of a thrown session", async () => {
  const dir = await project(["enabled: true", "inject: true", "decide: false"])
  await rm(join(dir, "Brain", "User.md"))
  const hooks = await createHook({ client: mockClient(), directory: dir } as any)
  await hooks["chat.message"]({ sessionID: "ses_1" } as any, {} as any)
  assert.equal(await inject(hooks, "ses_1"), "")
  await rm(dir, { recursive: true, force: true })
})

test("inject: false keeps the hook registered but injects nothing", async () => {
  const dir = await project(["enabled: true", "inject: false", "decide: false"])
  const hooks = await createHook({ client: mockClient(), directory: dir } as any)
  await hooks["chat.message"]({ sessionID: "ses_1" } as any, {} as any)
  assert.equal(await inject(hooks, "ses_1"), "")
  await rm(dir, { recursive: true, force: true })
})

test("TEST_HOME was redirected so no state lands in the real HOME", () => {
  assert.equal(process.env.HOME, TEST_HOME)
})
