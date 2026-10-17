import { test } from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_DRAIN } from "../drain/config.ts"
import { memoryToolBlocked } from "./guard.ts"
import { resolveProvider } from "./registry.ts"

const deps = {
  directory: "/p",
  stateDir: "/s",
  vaultDir: "/v",
  drain: DEFAULT_DRAIN,
  summaryWords: 400,
}

test("provider none blocks every built-in memory agent", () => {
  const none = resolveProvider("none", deps)
  for (const agent of ["rag-search", "rag-brain", "memory-explorer"]) {
    const reason = memoryToolBlocked(none, "task", { subagent_type: agent })
    assert.match(reason ?? "", /memory is disabled in config/)
  }
})

test("a Brain-only profile blocks the explorer agent but allows its own", () => {
  const brain = resolveProvider("rag-brain", deps)
  assert.equal(memoryToolBlocked(brain, "task", { subagent_type: "rag-search" }), null)
  assert.equal(memoryToolBlocked(brain, "task", { subagent_type: "rag-brain" }), null)
  assert.match(
    memoryToolBlocked(brain, "task", { subagent_type: "memory-explorer" }) ?? "",
    /belongs to the disabled built-in memory provider/,
  )
})

test("both owns every built-in agent", () => {
  const both = resolveProvider("both", deps)
  for (const agent of ["rag-search", "rag-brain", "memory-explorer"]) {
    assert.equal(memoryToolBlocked(both, "task", { subagent_type: agent }), null)
  }
})

test("non-memory agents are never blocked by this guard", () => {
  const none = resolveProvider("none", deps)
  assert.equal(memoryToolBlocked(none, "task", { subagent_type: "explore" }), null)
})

test("memory_search is gated on the active provider's tool capability", () => {
  assert.match(
    memoryToolBlocked(resolveProvider("rag-brain", deps), "memory_search") ?? "",
    /not exposed by the active memory provider/,
  )
  assert.equal(memoryToolBlocked(resolveProvider("memory-explorer", deps), "memory_search"), null)
  assert.equal(memoryToolBlocked(resolveProvider("both", deps), "memory_search"), null)
})

test("an unknown (future-provider) agent name passes the built-in guard", () => {
  const future = { ...resolveProvider("none", deps), id: "mnemosyne", agents: ["mnemosyne-reader"] } as any
  assert.equal(memoryToolBlocked(future, "task", { subagent_type: "mnemosyne-reader" }), null)
})
