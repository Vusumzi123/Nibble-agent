import { test } from "node:test"
import assert from "node:assert/strict"
import { modelField, splitModelSpec } from "./prompt-model.ts"

test("splitModelSpec parses the first slash and rejects malformed specs", () => {
  assert.deepEqual(splitModelSpec("qwencloud/qwen3.8-flash"), {
    providerID: "qwencloud",
    modelID: "qwen3.8-flash",
  })
  assert.deepEqual(splitModelSpec("a/b/c"), { providerID: "a", modelID: "b/c" })
  assert.equal(splitModelSpec(""), null)
  assert.equal(splitModelSpec("nope"), null)
  assert.equal(splitModelSpec("/x"), null)
  assert.equal(splitModelSpec("x/"), null)
})

test("modelField emits the SDK object only for a valid spec", () => {
  assert.deepEqual(modelField("deepseek/deepseek-flash"), {
    model: { providerID: "deepseek", modelID: "deepseek-flash" },
  })
  assert.deepEqual(modelField(""), {})
  assert.deepEqual(modelField(undefined), {})
  assert.deepEqual(modelField("nope"), {})
})
