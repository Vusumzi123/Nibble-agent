import { test } from "node:test"
import assert from "node:assert/strict"
import { createNotifier } from "./notify.ts"

test("createNotifier is a no-op when disabled", async () => {
  const calls: any[] = []
  const n = createNotifier({
    client: { tui: { showToast: async (a) => void calls.push(a) } },
    directory: "/d",
    enabled: false,
    channel: "ch",
  })
  await n.toast("hi", "success")
  assert.equal(calls.length, 0)
})

test("createNotifier emits the exact body shape and error duration", async () => {
  const calls: any[] = []
  const n = createNotifier({
    client: { tui: { showToast: async (a) => void calls.push(a) } },
    directory: "/proj",
    enabled: true,
    channel: "profile-hook",
  })
  await n.toast("ok", "success")
  await n.toast("boom", "error")
  assert.deepEqual(calls[0], {
    body: { title: "profile-hook", message: "ok", variant: "success", duration: 5000 },
    query: { directory: "/proj" },
  })
  assert.equal(calls[1].body.duration, 8000)
})

test("createNotifier defaults the variant to info", async () => {
  const calls: any[] = []
  const n = createNotifier({
    client: { tui: { showToast: async (a) => void calls.push(a) } },
    directory: "/d",
    enabled: true,
    channel: "ch",
  })
  await n.toast("note")
  assert.equal(calls[0].body.variant, "info")
  assert.equal(calls[0].body.duration, 5000)
})

test("createNotifier is silent without a tui and routes failures to onError", async () => {
  const errors: unknown[] = []
  const headless = createNotifier({
    client: {},
    directory: "/d",
    enabled: true,
    channel: "ch",
    onError: (e) => errors.push(e),
  })
  await headless.toast("x", "info")
  assert.equal(errors.length, 0)

  const throwing = createNotifier({
    client: { tui: { showToast: async () => { throw new Error("headless") } } },
    directory: "/d",
    enabled: true,
    channel: "ch",
    onError: (e) => errors.push(e),
  })
  await throwing.toast("x", "error")
  assert.equal(errors.length, 1)
})

test("createNotifier swallows failures when no onError is supplied", async () => {
  const n = createNotifier({
    client: { tui: { showToast: async () => { throw new Error("headless") } } },
    directory: "/d",
    enabled: true,
    channel: "ch",
  })
  await n.toast("x", "error")
})
