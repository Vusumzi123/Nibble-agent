import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tempHome } from "./test-utils.ts"

// Isolate the log/state root BEFORE the hook module resolves HOME.
const TEST_HOME = tempHome("rhook-home-")
const { default: createHook } = await import("../retrieval-hook.ts")

const LOG_FILE = join(TEST_HOME, ".opencode-sysop", "retrieval.log")

// The decision provider is `rules`, which abstains on the retrieval noul (it only
// answers the triage question). That makes the fail-closed path deterministic:
// an abstain/error must become a SKIP, no external process involved.
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

async function project(retrieval: string[], decisions: string[] = ["enabled: true", "provider: rules"]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rhook-proj-"))
  await mkdir(join(dir, ".opencode"), { recursive: true })
  const body = [
    "retrieval:",
    ...retrieval.map((l) => "  " + l),
    "",
    "decisions:",
    ...decisions.map((l) => "  " + l),
    "",
  ].join("\n")
  await writeFile(join(dir, ".opencode", "sysop-config.yaml"), body, "utf8")
  return dir
}

async function readLog(): Promise<any[]> {
  try {
    const raw = await readFile(LOG_FILE, "utf8")
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

async function fire(hooks: any, sid: string, text: string) {
  await hooks["chat.message"]({ sessionID: sid } as any, { parts: [{ type: "text", text }] } as any)
}

async function directiveFor(hooks: any, sid: string): Promise<string> {
  const out: string[] = []
  await hooks["experimental.chat.system.transform"]({ sessionID: sid } as any, { system: out } as any)
  return out.join("\n")
}

test("fail-closed: an abstaining provider yields a SKIP directive", async () => {
  const dir = await project(["enabled: true", "gate: true"])
  const hooks = await createHook({ client: mockClient(), directory: dir } as any)
  await fire(hooks, "ses_1", "install htop")
  const block = await directiveFor(hooks, "ses_1")
  assert.match(block, /\[brain-first: SKIP\]/)
  const entry = (await readLog()).at(-1)
  assert.equal(entry.event, "retrieval")
  assert.equal(entry.skip, true)
  assert.equal(entry.reason, "error")
  await rm(dir, { recursive: true, force: true })
})

test("explicit retrieval intent overrides the gate and injects RETRIEVE", async () => {
  const dir = await project(["enabled: true", "gate: true", "force_intent: true"])
  const hooks = await createHook({ client: mockClient(), directory: dir } as any)
  await fire(hooks, "ses_1", "search my notes for the WAL policy")
  const block = await directiveFor(hooks, "ses_1")
  assert.match(block, /\[brain-first: RETRIEVE\]/)
  const entry = (await readLog()).at(-1)
  assert.equal(entry.reason, "intent")
  assert.equal(entry.retrieve, true)
  await rm(dir, { recursive: true, force: true })
})

test("shadow mode logs the verdict but never suppresses retrieval", async () => {
  const dir = await project(["enabled: true", "gate: false"])
  const hooks = await createHook({ client: mockClient(), directory: dir } as any)
  await fire(hooks, "ses_1", "install htop")
  const block = await directiveFor(hooks, "ses_1")
  assert.match(block, /\[brain-first: RETRIEVE\]/)
  assert.match(block, /reason=shadow/)
  await rm(dir, { recursive: true, force: true })
})

test("disabled gate registers no hooks at all", async () => {
  const dir = await project(["enabled: false"])
  const hooks = await createHook({ client: mockClient(), directory: dir } as any)
  assert.deepEqual(hooks, {})
  await rm(dir, { recursive: true, force: true })
})

test("child sessions are never gated", async () => {
  const dir = await project(["enabled: true", "gate: true"])
  const hooks = await createHook({ client: mockClient({ parentID: "ses_parent" }), directory: dir } as any)
  await fire(hooks, "ses_1", "install htop")
  assert.equal(await directiveFor(hooks, "ses_1"), "")
  await rm(dir, { recursive: true, force: true })
})

test("the directive is cleared at session idle", async () => {
  const dir = await project(["enabled: true", "gate: true"])
  const hooks = await createHook({ client: mockClient(), directory: dir } as any)
  await fire(hooks, "ses_1", "install htop")
  assert.match(await directiveFor(hooks, "ses_1"), /brain-first/)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } } as any)
  assert.equal(await directiveFor(hooks, "ses_1"), "")
  await rm(dir, { recursive: true, force: true })
})

test("no provider configured means no gate", async () => {
  const dir = await project(["enabled: true", "gate: true"], ["enabled: false"])
  const hooks = await createHook({ client: mockClient(), directory: dir } as any)
  assert.deepEqual(hooks, {})
  await rm(dir, { recursive: true, force: true })
})
