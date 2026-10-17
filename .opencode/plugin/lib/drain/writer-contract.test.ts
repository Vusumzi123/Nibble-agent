import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const AGENT = new URL("../../../agents/rag-brain.md", import.meta.url)
const REFERENCE = new URL("../../../../reference/writer-tools.md", import.meta.url)

async function agent(): Promise<string> {
  return readFile(AGENT, "utf8")
}

test("the writer carries no model pin and has a step budget", async () => {
  const text = await agent()
  assert.equal(/^model:/m.test(text), false)
  assert.match(text, /^steps:\s*\d+$/m)
})

test("the writer never narrates steps or announces tool calls", async () => {
  const text = await agent()
  assert.equal(/announce what you're doing/i.test(text), false)
  assert.equal(/announce before acting/i.test(text), false)
  assert.match(text, /Never announce steps or narrate tool calls/i)
})

test("section 8 speaks the drain-pipe item-label contract", async () => {
  const text = await agent()
  assert.match(text, /## 8\. Consolidation Mode \(Drain-Pipe Ingestion\)/)
  assert.match(text, /### Knowledge item #<n>/)
  assert.match(text, /```consolidated/)
  assert.match(text, /```skipped/)
  assert.match(text, /Every item exactly once/i)
  assert.equal(/### Turn #<seq>/.test(text), false)
  assert.equal(/knowledge-hook/.test(text), false)
  assert.equal(/memory\.json/.test(text), false)
})

test("the tool matrix and cheat sheet live in the on-demand reference", async () => {
  const text = await agent()
  const reference = await readFile(REFERENCE, "utf8")
  assert.ok(Buffer.byteLength(text, "utf8") < 26_000, "rag-brain should stay slim")
  assert.match(text, /reference\/writer-tools\.md/)
  assert.match(reference, /## Tool Reference/)
  assert.match(reference, /## Search Strategy Cheat Sheet/)
  assert.match(reference, /markdown-vault_edit/)
})
