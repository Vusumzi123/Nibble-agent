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

test("no agent declares a predefined model", async () => {
  // Model selection comes from config (drain.writer_model /
  // drain.summarize_model) or inheritance. A frontmatter pin would silently
  // defeat a config model swap.
  const dir = new URL("../../../agents/", import.meta.url)
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".md")) continue
    const text = await readFile(new URL(name, dir), "utf8")
    assert.equal(/^model:/m.test(text), false, `${name} must not declare model:`)
  }
  const drainWriter = await readFile(new URL("drain-writer.md", dir), "utf8")
  assert.match(drainWriter, /^steps:\s*\d+$/m)
  assert.match(drainWriter, /drain_report:\s*true/)
  assert.match(drainWriter, /drain_report/)
})

function frontmatter(text: string): string {
  return /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ""
}

function mapAfter(text: string, key: string): Record<string, string> {
  const out: Record<string, string> = {}
  const start = new RegExp(`^${key}:\\s*$`, "m").exec(text)
  if (!start) return out
  const rest = text.slice(start.index + start[0].length)
  for (const line of rest.split(/\r?\n/)) {
    if (/^\S/.test(line)) break
    const match = /^\s+([\w-]+):\s*(\S+)\s*$/.exec(line)
    if (match) out[match[1]] = match[2]
  }
  return out
}

function frontmatterParts(text: string): {
  tools: Record<string, string>
  permission: Record<string, string>
} {
  const fm = frontmatter(text)
  const permissionAt = fm.search(/^permission:/m)
  const toolsText = permissionAt === -1 ? fm : fm.slice(0, permissionAt)
  const permissionText = permissionAt === -1 ? "" : fm.slice(permissionAt)
  return {
    tools: mapAfter(toolsText, "tools"),
    permission: mapAfter(permissionText, "permission"),
  }
}

const WRITER_DISABLED_TOOLS = [
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "list",
  "bash",
  "task",
  "lsp",
  "webfetch",
  "websearch",
  "todowrite",
  "todoread",
  "skill",
  "question",
  "mission_result",
  "queue_add",
  "summary_items",
  "markdown-vault_edit",
  "markdown-vault_system",
  "markdown-vault_workflow",
] as const

test("the drain writer locks its tool surface to vault view/vault and drain_report", async () => {
  const { tools, permission } = frontmatterParts(await readFile(DRAIN_WRITER, "utf8"))
  for (const key of ["markdown-vault_view", "markdown-vault_vault", "drain_report"]) {
    assert.equal(tools[key], "true", `${key} must be enabled`)
  }
  for (const key of WRITER_DISABLED_TOOLS) {
    assert.equal(tools[key], "false", `${key} must be hidden`)
    assert.equal(permission[key], "deny", `${key} must be denied`)
  }
  assert.equal(permission["markdown-vault_view"], "allow")
  assert.equal(permission["markdown-vault_vault"], "allow")
})

const SUMMARIZER_DISABLED_TOOLS = [
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "list",
  "bash",
  "task",
  "lsp",
  "webfetch",
  "websearch",
  "todowrite",
  "todoread",
  "skill",
  "question",
  "queue_add",
  "mission_result",
  "drain_report",
  "markdown-vault_view",
  "markdown-vault_vault",
  "markdown-vault_edit",
  "markdown-vault_system",
  "markdown-vault_workflow",
] as const

test("the session summarizer exposes only summary_items", async () => {
  const { tools, permission } = frontmatterParts(await readFile(SESSION_SUMMARIZER, "utf8"))
  assert.equal(tools["summary_items"], "true")
  for (const key of SUMMARIZER_DISABLED_TOOLS) {
    assert.equal(tools[key], "false", `${key} must be hidden`)
    assert.equal(permission[key], "deny", `${key} must be denied`)
  }
})

test("the writer body forbids research and verification", async () => {
  const text = await readFile(DRAIN_WRITER, "utf8")
  const plain = text.replaceAll("*", "").replace(/\s+/g, " ")
  assert.match(plain, /not a researcher/i)
  assert.match(plain, /Do not verify/i)
})

test("the summarizer body stays dual-use for drain and mission resume", async () => {
  const text = await readFile(SESSION_SUMMARIZER, "utf8")
  assert.match(text, /strict JSON/i)
  assert.match(text, /mission-resume/i)
  assert.equal(/call exactly one tool/i.test(text), false)
})
