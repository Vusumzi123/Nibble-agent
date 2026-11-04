import { test } from "node:test"
import assert from "node:assert/strict"
import { newestUserMessageID, observeSession } from "./observe.ts"

type RowOpts = {
  id: string
  role: "user" | "assistant"
  parentID?: string
  created?: number
  completed?: number | null
  finish?: string
  error?: unknown
  text?: string
}

function row(opts: RowOpts): unknown {
  return {
    info: {
      id: opts.id,
      role: opts.role,
      ...(opts.parentID ? { parentID: opts.parentID } : {}),
      ...(opts.finish ? { finish: opts.finish } : {}),
      ...(opts.error !== undefined ? { error: opts.error } : {}),
      time: { created: opts.created ?? 0, ...(opts.completed !== null ? { completed: opts.completed } : {}) },
    },
    parts: opts.text ? [{ type: "text", text: opts.text }] : [],
  }
}

function user(id: string, created = 0): unknown {
  return row({ id, role: "user", created })
}

function assistant(opts: {
  id: string
  parentID: string
  created?: number
  completed?: number | null
  finish?: string
  error?: unknown
  text?: string
}): unknown {
  return row({ ...opts, role: "assistant" })
}

function fakeClient(snapshots: unknown[][]): {
  messages: { calls: number[] }
  client: { session: { messages(args: any): Promise<{ data?: any }> } }
} {
  const calls: number[] = []
  let index = 0
  return {
    messages: { calls },
    client: {
      session: {
        async messages() {
          calls.push(index)
          return { data: snapshots[Math.min(index++, snapshots.length - 1)] }
        },
      },
    },
  }
}

function clock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: () => number } {
  let at = 0
  let slept = 0
  return {
    now: () => at,
    sleep: async (ms: number) => {
      at += ms
      slept += ms
    },
    slept: () => slept,
  }
}

test("a running reply becomes complete when time.completed and finish stop land", async () => {
  const c = clock()
  const { client, messages } = fakeClient([
    [user("u_old"), user("u_new", 10), assistant({ id: "a1", parentID: "u_new", created: 11 })],
    [
      user("u_old"),
      user("u_new", 10),
      assistant({ id: "a1", parentID: "u_new", created: 11, completed: 20, finish: "stop", text: "done" }),
    ],
  ])

  const observation = await observeSession(client, "/work", "ses_child", {
    promptUserID: "u_old",
    timeoutMs: 1000,
    pollMs: 10,
    now: c.now,
    sleep: c.sleep,
  })

  assert.equal(observation.phase, "complete")
  assert.deepEqual(observation.replies, ["done"])
  assert.equal(observation.progress.messages, 3)
  assert.equal(observation.progress.newestId, "a1")
  assert.equal(messages.calls.length, 2)
  assert.equal(c.slept(), 10)
})

test("a reused session ignores the previous completed reply and waits for the new prompt", async () => {
  const c = clock()
  const previous = [
    user("u_old"),
    assistant({ id: "a_old", parentID: "u_old", completed: 5, finish: "stop", text: "old answer" }),
  ]
  const { client } = fakeClient([
    previous,
    [...previous, user("u_new", 10), assistant({ id: "a1", parentID: "u_new", created: 11 })],
    [
      ...previous,
      user("u_new", 10),
      assistant({ id: "a1", parentID: "u_new", created: 11, completed: 20, finish: "stop", text: "new answer" }),
    ],
  ])

  const observation = await observeSession(client, "/work", "ses_child", {
    promptUserID: "u_old",
    timeoutMs: 1000,
    pollMs: 10,
    now: c.now,
    sleep: c.sleep,
  })

  assert.equal(observation.phase, "complete")
  assert.deepEqual(observation.replies, ["new answer"], "the old reply is not returned")
})

test("tool-calls keeps polling after a completed step", async () => {
  const c = clock()
  const { client, messages } = fakeClient([
    [user("u_new", 1), assistant({ id: "a1", parentID: "u_new", completed: 2, finish: "tool-calls" })],
    [
      user("u_new", 1),
      assistant({ id: "a1", parentID: "u_new", completed: 2, finish: "tool-calls" }),
      assistant({ id: "a2", parentID: "u_new", created: 3, completed: 4, finish: "stop", text: "final" }),
    ],
  ])

  const observation = await observeSession(client, "/work", "ses_child", {
    promptUserID: null,
    timeoutMs: 1000,
    pollMs: 10,
    now: c.now,
    sleep: c.sleep,
  })

  assert.equal(observation.phase, "complete")
  assert.deepEqual(observation.replies, ["final"])
  assert.equal(messages.calls.length, 2)
})

test("the deadline reads once more and returns the latest replies as timeout", async () => {
  const c = clock()
  const rows = [
    user("u_new", 1),
    assistant({ id: "a1", parentID: "u_new", created: 2, text: "still working" }),
  ]
  const { client } = fakeClient([rows])

  const observation = await observeSession(client, "/work", "ses_child", {
    promptUserID: null,
    timeoutMs: 50,
    pollMs: 10,
    now: c.now,
    sleep: c.sleep,
  })

  assert.equal(observation.phase, "timeout")
  assert.deepEqual(observation.replies, ["still working"])
  assert.ok(c.slept() >= 50)
})

test("a missing time.completed stays running until the deadline", async () => {
  const c = clock()
  const rows = [
    user("u_new", 1),
    assistant({ id: "a1", parentID: "u_new", created: 2, text: "partial" }),
  ]
  const { client } = fakeClient([rows])

  const observation = await observeSession(client, "/work", "ses_child", {
    promptUserID: null,
    timeoutMs: 100,
    pollMs: 25,
    now: c.now,
    sleep: c.sleep,
  })

  assert.equal(observation.phase, "timeout")
  assert.deepEqual(observation.replies, ["partial"])
  assert.ok(c.slept() >= 100)
  assert.ok(c.slept() < 125, "the deadline is not overshot by a full poll")
})

test("a failed reply is a failure, not a report", async () => {
  const c = clock()
  const { client } = fakeClient([
    [
      user("u_new", 1),
      assistant({
        id: "a1",
        parentID: "u_new",
        completed: 2,
        finish: "error",
        error: { message: "model failed" },
      }),
    ],
  ])

  const observation = await observeSession(client, "/work", "ses_child", {
    promptUserID: null,
    timeoutMs: 100,
    now: c.now,
    sleep: c.sleep,
  })

  assert.equal(observation.phase, "failed")
})

test("progress reports message count, newest id, and the newest part time", async () => {
  const c = clock()
  const { client } = fakeClient([
    [
      user("u_new", 1),
      assistant({ id: "a1", parentID: "u_new", created: 2 }),
      assistant({ id: "a2", parentID: "u_new", created: 5, completed: 9, finish: "stop", text: "ok" }),
    ],
  ])

  const observation = await observeSession(client, "/work", "ses_child", {
    promptUserID: null,
    timeoutMs: 100,
    now: c.now,
    sleep: c.sleep,
  })

  assert.deepEqual(observation.progress, {
    messages: 3,
    newestId: "a2",
    newestPartAt: 9,
  })
})

test("newestUserMessageID picks the newest user row, not the last row", () => {
  assert.equal(
    newestUserMessageID([
      user("u1", 1),
      user("u2", 3),
      assistant({ id: "a1", parentID: "u2", created: 4, completed: 5, finish: "stop" }),
    ]),
    "u2",
  )
  assert.equal(newestUserMessageID([]), null)
})

test("a child that keeps producing rows for ten minutes is not stalled", async () => {
  const c = clock()
  const client = {
    session: {
      async messages() {
        const at = c.now()
        const rows: unknown[] = [user("u_new", 1)]
        const produced = Math.floor(at / 30_000)
        for (let i = 0; i <= produced; i++) {
          rows.push(assistant({ id: `a${i}`, parentID: "u_new", created: i * 30_000 }))
        }
        if (at >= 600_000) {
          rows.push(
            assistant({
              id: "done",
              parentID: "u_new",
              created: 600_000,
              completed: 600_001,
              finish: "stop",
              text: "done",
            }),
          )
        }
        return { data: rows }
      },
    },
  }

  const observation = await observeSession(client, "/work", "ses_child", {
    promptUserID: null,
    timeoutMs: 900_000,
    stallMs: 120_000,
    pollMs: 10_000,
    now: c.now,
    sleep: c.sleep,
  })

  assert.equal(observation.phase, "complete")
  assert.deepEqual(observation.replies, ["done"])
  assert.ok(c.slept() >= 600_000)
})

test("a child with no new row for stall_ms is timed out", async () => {
  const c = clock()
  const { client } = fakeClient([
    [user("u_new", 1), assistant({ id: "a1", parentID: "u_new", created: 2, text: "working" })],
  ])

  const observation = await observeSession(client, "/work", "ses_child", {
    promptUserID: null,
    timeoutMs: 900_000,
    stallMs: 120_000,
    pollMs: 10_000,
    now: c.now,
    sleep: c.sleep,
  })

  assert.equal(observation.phase, "timeout")
  assert.deepEqual(observation.replies, ["working"], "the timeout still returns the latest rows")
  assert.ok(c.slept() >= 120_000)
  assert.ok(c.slept() < 130_000, "the stall window is not overshot by a full poll")
})

test("the absolute ceiling stops a child even when stall_ms is larger", async () => {
  const c = clock()
  const { client } = fakeClient([
    [user("u_new", 1), assistant({ id: "a1", parentID: "u_new", created: 2, text: "working" })],
  ])

  const observation = await observeSession(client, "/work", "ses_child", {
    promptUserID: null,
    timeoutMs: 100,
    stallMs: 1_000_000,
    pollMs: 25,
    now: c.now,
    sleep: c.sleep,
  })

  assert.equal(observation.phase, "timeout")
  assert.ok(c.slept() >= 100)
  assert.ok(c.slept() < 125, "the ceiling is not overshot by a full poll")
})

test("continuous progress does not extend the absolute ceiling", async () => {
  const c = clock()
  const client = {
    session: {
      async messages() {
        const at = c.now()
        const rows: unknown[] = [user("u_new", 1)]
        for (let i = 0; i <= Math.floor(at / 10); i++) {
          rows.push(assistant({ id: `a${i}`, parentID: "u_new", created: i * 10 }))
        }
        return { data: rows }
      },
    },
  }

  const observation = await observeSession(client, "/work", "ses_child", {
    promptUserID: null,
    timeoutMs: 100,
    stallMs: 50,
    pollMs: 10,
    now: c.now,
    sleep: c.sleep,
  })

  assert.equal(observation.phase, "timeout")
  assert.ok(c.slept() >= 100)
})
