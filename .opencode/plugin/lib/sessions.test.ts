import { test } from "node:test"
import assert from "node:assert/strict"
import { createSessionTools, textOf } from "./sessions.ts"

function mockClient(sessions: Record<string, any>, messages: Record<string, any[]> = {}) {
  const getCalls: string[] = []
  const messageCalls: string[] = []
  return {
    getCalls,
    messageCalls,
    client: {
      session: {
        get: async ({ path }: any) => {
          getCalls.push(path.id)
          const d = sessions[path.id]
          if (d === "throw") throw new Error("get boom")
          return { data: d }
        },
        messages: async ({ path }: any) => {
          messageCalls.push(path.id)
          if (messages[path.id] === undefined && !(path.id in messages)) return { data: [] }
          if (messages[path.id] === ("throw" as any)) throw new Error("messages boom")
          return { data: messages[path.id] }
        },
      },
    },
  }
}

test("textOf joins real text parts and drops synthetic/ignored/non-text", () => {
  const parts = [
    { type: "text", text: "hello" },
    { type: "reasoning", text: "hidden" },
    { type: "text", text: "synthetic", synthetic: true },
    { type: "text", text: "ignored", ignored: true },
    { type: "text", text: "world" },
  ]
  assert.equal(textOf(parts), "hello\nworld")
  assert.equal(textOf([]), "")
})

test("meta caches the lookup and reports child/parent/agent", async () => {
  const m = mockClient({ s1: { parentID: "p1", agent: "kael" } })
  const tools = createSessionTools(m.client as any, "/d")
  assert.deepEqual(await tools.meta("s1"), { child: true, parentID: "p1", agent: "kael" })
  assert.deepEqual(await tools.meta("s1"), { child: true, parentID: "p1", agent: "kael" })
  assert.equal(m.getCalls.length, 1)
})

test("meta defaults to a top-level session when the parentID is absent", async () => {
  const m = mockClient({ s1: { agent: "kael" } })
  const tools = createSessionTools(m.client as any, "/d")
  assert.deepEqual(await tools.meta("s1"), { child: false, parentID: null, agent: "kael" })
})

test("meta reports lookup failures and caches the fallback", async () => {
  const m = mockClient({ s1: "throw" })
  const errors: Array<[unknown, string]> = []
  const tools = createSessionTools(m.client as any, "/d", {
    onError: (err, ctx) => errors.push([err, ctx]),
  })
  assert.deepEqual(await tools.meta("s1"), { child: false, parentID: null, agent: null })
  assert.equal(errors.length, 1)
  assert.equal(errors[0][1], "get")
  await tools.meta("s1")
  assert.equal(errors.length, 1)
})

test("isChild derives from the cached meta", async () => {
  const m = mockClient({ child: { parentID: "top" }, top: {} })
  const tools = createSessionTools(m.client as any, "/d")
  assert.equal(await tools.isChild("child"), true)
  assert.equal(await tools.isChild("top"), false)
})

test("topLevel walks up the parent chain to the parent-less session", async () => {
  const m = mockClient({
    a: { parentID: "b" },
    b: { parentID: "c" },
    c: {},
  })
  const tools = createSessionTools(m.client as any, "/d")
  assert.equal(await tools.topLevel("a"), "c")
})

test("topLevel stops after the bounded walk on a cyclic chain", async () => {
  const m = mockClient({ a: { parentID: "b" }, b: { parentID: "a" } })
  const tools = createSessionTools(m.client as any, "/d")
  const top = await tools.topLevel("a")
  assert.ok(top === "a" || top === "b")
})

test("lastAssistantText finds the newest non-empty assistant text", async () => {
  const m = mockClient(
    {},
    {
      s1: [
        { info: { role: "user", id: "u1" }, parts: [{ type: "text", text: "q" }] },
        { info: { role: "assistant", id: "a1" }, parts: [{ type: "text", text: "first" }] },
        { info: { role: "assistant", id: "a2" }, parts: [{ type: "text", text: "" }] },
        { info: { role: "assistant", id: "a3" }, parts: [{ type: "text", text: "last word" }] },
      ],
    },
  )
  const tools = createSessionTools(m.client as any, "/d")
  assert.equal(await tools.lastAssistantText("s1"), "last word")
})

test("lastAssistantText returns empty and reports messages failures", async () => {
  const m = mockClient({}, { s1: "throw" as any })
  const errors: Array<[unknown, string]> = []
  const tools = createSessionTools(m.client as any, "/d", {
    onError: (err, ctx) => errors.push([err, ctx]),
  })
  assert.equal(await tools.lastAssistantText("s1"), "")
  assert.equal(errors.length, 1)
  assert.equal(errors[0][1], "messages")
})
