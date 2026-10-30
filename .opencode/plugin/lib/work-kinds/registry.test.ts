import assert from "node:assert/strict"
import test from "node:test"
import { KIND_ORDER } from "../work-queue.ts"
import { allHandlers, handlerFor } from "./registry.ts"

test("every work kind has exactly one handler", () => {
  const kinds = allHandlers().map((handler) => handler.kind)
  assert.equal(new Set(kinds).size, kinds.length, "duplicate handler kind")
  for (const kind of KIND_ORDER) {
    assert.ok(handlerFor(kind), `no handler for work kind: ${kind}`)
  }
})

test("every handler kind is a known work kind", () => {
  for (const kind of allHandlers().map((handler) => handler.kind)) {
    assert.ok(KIND_ORDER.includes(kind), `handler kind not in KIND_ORDER: ${kind}`)
  }
})

test("handlerFor rejects an unknown kind", () => {
  assert.equal(handlerFor("nope"), undefined)
})
