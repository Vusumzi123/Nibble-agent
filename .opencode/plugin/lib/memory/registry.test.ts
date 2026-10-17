import { test } from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_DRAIN } from "../drain/config.ts"
import { SUBAGENT_TIERS } from "../autonomy-gate.ts"
import { BUILTIN_MEMORY_AGENTS, createNoneProvider, resolveProvider } from "./registry.ts"
import { brainReadPlan } from "./providers/builtin/brain.ts"
import { EXPLORER_LANE } from "./providers/builtin/explorer.ts"

const deps = {
  directory: "/work/project",
  stateDir: "/work/state",
  vaultDir: "/work/vault",
  drain: DEFAULT_DRAIN,
  summaryWords: 400,
}

test("profile -> provider id, capabilities, and agent sets", () => {
  const brain = resolveProvider("rag-brain", deps)
  assert.equal(brain.id, "rag-brain")
  assert.deepEqual(brain.agents, ["rag-search", "rag-brain"])
  assert.equal(brain.capabilities.write, true)
  assert.equal(brain.capabilities.searchTool, false)

  const explorer = resolveProvider("memory-explorer", deps)
  assert.equal(explorer.id, "memory-explorer")
  assert.deepEqual(explorer.agents, ["memory-explorer"])
  assert.equal(explorer.capabilities.write, false)
  assert.equal(explorer.capabilities.searchTool, true)
})

test("both is a Brain writer with the explorer read lane unioned in", () => {
  const both = resolveProvider("both", deps)
  assert.equal(both.id, "both")
  assert.equal(both.capabilities.write, true)
  assert.equal(both.capabilities.searchTool, true)
  assert.deepEqual(new Set(both.agents), new Set(["rag-search", "rag-brain", "memory-explorer"]))
  assert.equal(typeof both.consolidate, "function")
  assert.equal(typeof both.search, "function")
  assert.equal(typeof both.seed, "function")
  assert.equal(typeof both.tools, "function")
})

test("both composes the plans in Brain-then-Explorer order", () => {
  const plan = resolveProvider("both", deps).readPlan()
  assert.equal(plan, [brainReadPlan(400), EXPLORER_LANE].join("\n"))
})

test("none exposes no plan, writer, tools, pending, or agents", async () => {
  const none = resolveProvider("none", deps)
  assert.equal(none.id, "none")
  assert.equal(none.readPlan(), null)
  assert.deepEqual(none.agents, [])
  assert.equal(none.consolidate, undefined)
  assert.equal(none.tools, undefined)
  assert.equal(none.pending, undefined)
  assert.deepEqual(await none.health(), { ok: true })
})

test("an unknown profile fails closed to none", () => {
  assert.equal(resolveProvider("mnemosyne" as any, deps).id, "none")
})

test("every built-in memory agent is mapped in SUBAGENT_TIERS", () => {
  for (const agent of BUILTIN_MEMORY_AGENTS) {
    assert.ok(SUBAGENT_TIERS[agent], `${agent} is not mapped in SUBAGENT_TIERS`)
  }
  assert.equal(SUBAGENT_TIERS["memory-explorer"], "subagent-read")
})

test("the none provider is the same shape as the registry fallback", () => {
  assert.equal(createNoneProvider().id, resolveProvider("none", deps).id)
})

test("the drain pipe imports no concrete provider", async () => {
  const { readFile } = await import("node:fs/promises")
  const text = await readFile(new URL("../drain/pipe.ts", import.meta.url), "utf8")
  assert.equal(/memory\/providers|from "\.\/prompt\.ts"|from "\.\/spawn\.ts"/.test(text), false)
  assert.match(text, /memory\/types\.ts/)
})
