import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"

const AGENT = new URL("../../../agents/rag-brain.md", import.meta.url)
const DRAIN_WRITER = new URL("../../../agents/drain-writer.md", import.meta.url)
const SESSION_SUMMARIZER = new URL("../../../agents/session-summarizer.md", import.meta.url)
const REFERENCE = new URL("../../../../reference/writer-tools.md", import.meta.url)
const CONSOLIDATION = new URL("../../../../reference/consolidation.md", import.meta.url)
const KANBAN = new URL("../../../../reference/kanban.md", import.meta.url)
const VAULT_META = new URL("../../../../reference/vault-meta.md", import.meta.url)

async function agent(): Promise<string> {
  return readFile(AGENT, "utf8")
}

test("the writer has a step budget and no model pin", async () => {
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

test("the drain-pipe report contract lives in the writer and its reference", async () => {
  for (const url of [DRAIN_WRITER, CONSOLIDATION]) {
    const text = await readFile(url, "utf8")
    assert.match(text, /### Knowledge item #<n>/)
    assert.match(text, /drain_report/)
    assert.match(text, /exactly once/i)
    assert.equal(/```consolidated/.test(text), false)
    assert.equal(/```skipped/.test(text), false)
    assert.equal(/=== ITEM ===/.test(text), false)
    assert.equal(/NO_ITEMS/.test(text), false)
    assert.equal(/### Turn #<seq>/.test(text), false)
    assert.equal(/knowledge-hook/.test(text), false)
    assert.equal(/memory\.json/.test(text), false)
  }

  const summarizer = await readFile(SESSION_SUMMARIZER, "utf8")
  assert.match(summarizer, /summary_items/)
  assert.equal(/=== ITEM ===/.test(summarizer), false)
  assert.equal(/NO_ITEMS/.test(summarizer), false)
})

test("the tool matrix and cheat sheet live in the on-demand reference", async () => {
  const text = await agent()
  const reference = await readFile(REFERENCE, "utf8")
  assert.ok(Buffer.byteLength(text, "utf8") <= 11_500, "rag-brain should stay slim")
  assert.match(text, /reference\/writer-tools\.md/)
  assert.equal(/Five-Stage Retrieval/.test(text), false)
  assert.equal(/Read Policy/.test(text), false)
  assert.equal(/Kanban Boards/.test(text), false)
  assert.match(reference, /## Tool Reference/)
  assert.match(reference, /## Search Strategy Cheat Sheet/)
  assert.match(reference, /markdown-vault_edit/)
})

test("rare vault formats live in on-demand references", async () => {
  const text = await agent()
  for (const name of ["kanban", "consolidation", "vault-meta"]) {
    assert.match(text, new RegExp(`reference/${name}\\.md`))
    const content = await readFile(
      new URL(`../../../../reference/${name}.md`, import.meta.url),
      "utf8",
    )
    assert.ok(content.length > 0, `${name} reference must not be empty`)
  }
  assert.match(await readFile(KANBAN, "utf8"), /kanban-plugin: board/)
  assert.match(await readFile(CONSOLIDATION, "utf8"), /Consolidation mode/)
  const meta = await readFile(VAULT_META, "utf8")
  assert.match(meta, /## \[YYYY-MM-DD\] op \| Short Title/)
  assert.match(meta, /consolidation.*reclassification.*hygiene.*change/)
})

test("only the vault writers declare a predefined model", async () => {
  // No hidden pin may drift from the deployed harness: model selection comes
  // from config (drain.writer_model / drain.summarize_model) or inheritance.
  // The two vault writers are the exception: drain-writer's pin is the live
  // rag-brain default and exists so drain cost comparisons stay on the same
  // substrate. A deployed rag-brain may carry the same pin.
  const dir = new URL("../../../agents/", import.meta.url)
  const mayPin = new Set(["drain-writer.md", "rag-brain.md"])
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".md") || mayPin.has(name)) continue
    const text = await readFile(new URL(name, dir), "utf8")
    assert.equal(/^model:/m.test(text), false, `${name} must not declare model:`)
  }
  const drainWriter = await readFile(new URL("drain-writer.md", dir), "utf8")
  assert.match(drainWriter, /^model:\s*\S+$/m)
  assert.match(drainWriter, /^steps:\s*40$/m)
  assert.match(drainWriter, /drain_report:\s*true/)
  assert.match(drainWriter, /drain_report/)
})
