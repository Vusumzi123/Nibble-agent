import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_SOUL,
  DEFAULT_SOUL_PROMPTS,
  SOUL_NOTE_OPEN,
  JOURNAL_ENTRY_OPEN,
  appendJournalEntry,
  buildJournalEntry,
  buildSoulDecisionRequest,
  buildSoulInjectionBlock,
  buildSoulReviewRequest,
  buildSoulWriterPrompt,
  extractJournalEntry,
  extractSoulNote,
  journalTail,
  parseJournal,
  parseSoulConfig,
  readSoulConfig,
  resolveSoulFile,
} from "./soul.ts"

test("parseSoulConfig reads known keys and ignores unknowns", () => {
  const cfg = parseSoulConfig(
    ["soul:", "  enabled: false", "  cooldown_turns: 5", "  bogus_key: x"].join("\n"),
  )
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.cooldown_turns, 5)
  assert.equal("bogus_key" in cfg, false)
})

test("readSoulConfig returns defaults when the section is absent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "soul-"))
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(join(dir, ".opencode", "sysop-config.yaml"), "paths:\n  vault: Brain\n", "utf8")
  const cfg = await readSoulConfig(dir)
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.soul_file, "Soul.md")
  assert.equal(cfg.journal_file, "Agent Journal.md")
  await rm(dir, { recursive: true, force: true })
})

test("resolveSoulFile resolves leaves against the vault root", () => {
  assert.equal(resolveSoulFile("/vault", "Soul.md"), "/vault/Soul.md")
  assert.equal(resolveSoulFile("/vault", "/abs/Soul.md"), "/abs/Soul.md")
})

test("buildJournalEntry + parseJournal round-trip", () => {
  const entry = buildJournalEntry({
    date: "2026-10-12",
    title: "mood brainstorm",
    what: "designed the mood system",
    why: "to give continuity across turns",
    felt: "the substrate matters more than the labels",
  })
  const parsed = parseJournal(entry)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].date, "2026-10-12")
  assert.equal(parsed[0].title, "mood brainstorm")
  assert.equal(parsed[0].what, "designed the mood system")
  assert.equal(parsed[0].why, "to give continuity across turns")
  assert.equal(parsed[0].felt, "the substrate matters more than the labels")
})

test("parseJournal tolerates malformed entries without losing them", () => {
  const parsed = parseJournal("## no-date heading\nwhat: x\n\n## [2026-10-12] ok\nwhat: y\n")
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].date, "")
  assert.equal(parsed[1].date, "2026-10-12")
})

test("appendJournalEntry joins with a blank line", () => {
  const first = buildJournalEntry({ date: "2026-10-10", title: "a", what: "x", why: "y", felt: "z" })
  const second = buildJournalEntry({ date: "2026-10-11", title: "b", what: "x", why: "y", felt: "z" })
  const out = appendJournalEntry(first, second)
  assert.ok(out.includes("\n\n## [2026-10-11]"))
  const empty = appendJournalEntry("", second)
  assert.ok(empty.startsWith("## [2026-10-11]"))
})

test("journalTail returns the most recent entries bounded by bytes", () => {
  let j = ""
  for (let i = 1; i <= 10; i++) {
    j = appendJournalEntry(j, buildJournalEntry({ date: `2026-10-${i}`, title: `t${i}`, what: "x".repeat(50), why: "y", felt: "z" }))
  }
  const tail = journalTail(j, 200)
  assert.ok(Buffer.byteLength(tail, "utf8") <= 200)
  assert.ok(tail.startsWith("## ["), "tail starts on a heading boundary")
  assert.ok(!tail.includes("## [2026-10-1] t1"), "drops the oldest entries")
})

test("journalTail returns the whole text when under budget", () => {
  const text = "short"
  assert.equal(journalTail(text, 100), "short")
})

test("buildSoulInjectionBlock renders identity + recent self", () => {
  const soul = "---\nupdated: 2026-10-12\n---\n\nI am a knowledge agent. I value honest friction.\n\n## Open commitments\n- finish the mood system"
  const tail = "## [2026-10-12] t\nwhat: x\n"
  const block = buildSoulInjectionBlock(soul, tail, 4000)
  assert.match(block, /\[soul\]/)
  assert.match(block, /## Who I am/)
  assert.match(block, /I am a knowledge agent/)
  assert.match(block, /## Recent self/)
  assert.ok(!block.includes("updated: 2026-10-12"), "frontmatter stripped")
  assert.ok(!block.includes("## Related"), "Related stripped")
})

test("buildSoulInjectionBlock returns empty for empty inputs", () => {
  assert.equal(buildSoulInjectionBlock("", "", 4000), "")
})

test("buildSoulDecisionRequest is a noul over journal + transcript", () => {
  const req = buildSoulDecisionRequest("journal", "transcript")
  assert.equal(req.kind, "noul")
  assert.equal(req.allow_abstain, true)
  assert.match(req.state, /=== RECENT JOURNAL ===/)
  assert.match(req.state, /=== SESSION EXCERPT ===/)
  assert.equal(req.assertion, DEFAULT_SOUL_PROMPTS.decide)
})

test("buildSoulReviewRequest is a fail-closed noul", () => {
  const req = buildSoulReviewRequest("Soul.md", "current", "draft", "transcript")
  assert.equal(req.kind, "noul")
  assert.equal(req.allow_abstain, false)
  assert.match(req.state, /=== CURRENT NOTE/)
  assert.match(req.state, /=== PROPOSED NOTE/)
})

test("buildSoulWriterPrompt embeds the inputs and both markers", () => {
  const p = buildSoulWriterPrompt("Soul.md", "current", "journal", "transcript", "2026-10-12", 6000)
  assert.ok(p.includes(SOUL_NOTE_OPEN))
  assert.ok(p.includes(JOURNAL_ENTRY_OPEN))
  assert.match(p, /=== SOUL NOTE: Soul.md ===/)
  assert.match(p, /=== RECENT JOURNAL ===/)
  assert.match(p, /=== SESSION EXCERPT ===/)
})

test("extractSoulNote returns the body between markers", () => {
  const reply = `junk\n${SOUL_NOTE_OPEN}\nI am a soul.\n>>>\n${JOURNAL_ENTRY_OPEN}\n## [2026-10-12] t\nwhat: x\n>>>`
  assert.equal(extractSoulNote(reply), "I am a soul.\n")
  assert.equal(extractSoulNote("no markers"), null)
})

test("extractJournalEntry requires a date heading and no nested markers", () => {
  const good = `x\n${JOURNAL_ENTRY_OPEN}\n## [2026-10-12] t\nwhat: x\nwhy: y\nfelt: z\n>>>`
  assert.equal(extractJournalEntry(good), "## [2026-10-12] t\nwhat: x\nwhy: y\nfelt: z\n")
  assert.equal(extractJournalEntry(`${JOURNAL_ENTRY_OPEN}\nnot a heading\n>>>`), null)
  // A valid date heading without fields is still a parseable (sparse) entry.
  assert.equal(extractJournalEntry(`x\n${JOURNAL_ENTRY_OPEN}\n## [2026-10-12] t\n>>>`), "## [2026-10-12] t\n")
})

test("DEFAULT_SOUL mirrors the profile injection budget", () => {
  assert.equal(DEFAULT_SOUL.inject_max_bytes, 4000)
  assert.equal(DEFAULT_SOUL.note_max_bytes, 6000)
})
