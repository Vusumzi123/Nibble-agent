import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  DEFAULT_CONFIG,
  buildDrainPrompt,
  buildTagIndex,
  candidateTags,
  classifyTurn,
  classifyTranscript,
  extractKeywords,
  findCandidateNotes,
  hasDurableSignal,
  parseConsolidated,
  parseFrontmatterTags,
  parseKnowledgeConfig,
  parseSkipped,
  readKnowledgeConfig,
  recoverMislabeledConsolidated,
  resolveMemoryFile,
  resolveTagIndexFile,
  selectDrainBatch,
  spawnDrainChild,
} from "./knowledge.ts"
import { entryHash, type MemoryEntry } from "./temporal.ts"

// The shared guard set spawnDrainChild registers into.
import { automationChildSessions } from "./automation.ts"

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "knowledge-"))
}

function entry(seq: number, user: string, assistant: string, over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    seq,
    session: over.session ?? "ses_x",
    ts: over.ts ?? "2026-09-26T00:00:00Z",
    user,
    assistant,
    tags: over.tags ?? [],
    salience: over.salience ?? null,
    newTag: over.newTag ?? null,
    hash: over.hash ?? entryHash(user, assistant),
  }
}

// ---------------------------------------------------------------------------
// Config

test("parseKnowledgeConfig reads a full block with typed scalars", () => {
  const yaml = [
    "other:",
    "  file: Other.md",
    "knowledge:",
    "  enabled: true",
    "  memory_file: memory.json",
    "  min_ready_turns: 4",
    "  batch_turns: 7",
    "  max_turn_age: 3600000",
    "  drain_max_tokens: 90000",
    "  drain_cooldown_ms: 60000",
    "  tag_gate: false",
    "  tag_candidates: 6",
  ].join("\n")
  const cfg = parseKnowledgeConfig(yaml)
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.memory_file, "memory.json")
  assert.equal(cfg.min_ready_turns, 4)
  assert.equal(cfg.batch_turns, 7)
  assert.equal(cfg.max_turn_age, 3600000)
  assert.equal(cfg.drain_max_tokens, 90000)
  assert.equal(cfg.drain_cooldown_ms, 60000)
  assert.equal(cfg.tag_gate, false)
  assert.equal(cfg.tag_candidates, 6)
})

test("parseKnowledgeConfig returns empty object when section is missing", () => {
  assert.deepEqual(parseKnowledgeConfig("other:\n  file: /x/Other.md\n"), {})
  assert.deepEqual(parseKnowledgeConfig(""), {})
})

test("parseKnowledgeConfig ignores inline comments and unknown keys", () => {
  const cfg = parseKnowledgeConfig(
    "knowledge:\n  batch_turns: 8  # eight turns\n  future_key: xyz\n",
  )
  assert.equal(cfg.batch_turns, 8)
  assert.equal("future_key" in cfg, false)
})

test("parseKnowledgeConfig handles false, zero, and negative numbers", () => {
  const cfg = parseKnowledgeConfig(
    "knowledge:\n  enabled: false\n  min_ready_turns: 0\n  max_turn_age: -1\n",
  )
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.min_ready_turns, 0)
  assert.equal(cfg.max_turn_age, -1)
})

test("readKnowledgeConfig overlays the real sysop-config.yaml on defaults", async () => {
  const cfg = await readKnowledgeConfig(PROJECT_ROOT)
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.memory_file, "memory.json")
  assert.equal(cfg.tag_index_file, "tag-index.json")
  assert.equal(cfg.min_ready_turns, 3)
  assert.equal(cfg.batch_turns, 8)
  assert.equal(cfg.max_turn_age, 86400000)
  assert.equal(cfg.drain_max_tokens, 150000)
  assert.equal(cfg.drain_cooldown_ms, 60000)
  assert.equal(cfg.tag_gate, true)
})

test("readKnowledgeConfig falls back to defaults for a missing config dir", async () => {
  const cfg = await readKnowledgeConfig(join(await tmpDir(), "nope"))
  assert.deepEqual(cfg, DEFAULT_CONFIG)
})

test("resolveMemoryFile resolves leaves under the state root and honors absolute", () => {
  assert.equal(resolveMemoryFile("/proj/.opencode/state", { ...DEFAULT_CONFIG, memory_file: "memory.json" }), "/proj/.opencode/state/memory.json")
  assert.equal(resolveMemoryFile("/proj/.opencode/state", { ...DEFAULT_CONFIG, memory_file: "/abs/m.json" }), "/abs/m.json")
  assert.equal(resolveTagIndexFile("/state", { ...DEFAULT_CONFIG, tag_index_file: "tag-index.json" }), "/state/tag-index.json")
})

// ---------------------------------------------------------------------------
// Per-turn prefilter

test("classifyTurn drops only whole-message trivial turns", () => {
  assert.equal(classifyTurn(entry(1, "thanks", "you're welcome")).skip, true)
  assert.equal(classifyTurn(entry(2, "thanks", "you're welcome")).reason, "trivial")

  assert.equal(classifyTurn(entry(3, "how do I install htop?", "Use your package manager.")).reason, "question")
  assert.equal(classifyTurn(entry(4, "I decided we should use fish", "ok")).reason, "durable-signal")
  assert.equal(classifyTurn(entry(5, "run this now", "```\nsudo pacman -S htop\n```")).reason, "durable-signal")
  assert.equal(classifyTurn(entry(6, "x".repeat(2000), "y")).reason, "over-size")
  // A prose-only, non-question, non-filler turn is a candidate (non-trivial).
  assert.equal(classifyTurn(entry(7, "The router firmware update went fine", "Good to hear")).reason, "non-trivial")
})

test("hasDurableSignal detects commands and decision language", () => {
  assert.equal(hasDurableSignal("please remember this"), true)
  assert.equal(hasDurableSignal("just some filler"), false)
})

test("classifyTranscript remains available to the profile prefilter", () => {
  const trivial = "<!-- turn: 1 -->\n## User\n\nthanks\n\n## Assistant\n\nyou're welcome"
  assert.equal(classifyTranscript(trivial).skip, true)
})

// ---------------------------------------------------------------------------
// Batch selection

test("selectDrainBatch accumulates turns up to batchTurns and token cap", () => {
  const entries = [
    entry(1, "a".repeat(100), "b".repeat(100)),
    entry(2, "c".repeat(100), "d".repeat(100)),
    entry(3, "e".repeat(100), "f".repeat(100)),
  ]
  const sel = selectDrainBatch(entries, 2, 1000)
  assert.deepEqual(sel.batch.map((e) => e.seq), [1, 2])
  assert.equal(sel.overshoot, false)
  assert.ok(sel.tokens > 0)

  assert.deepEqual(selectDrainBatch(entries, 10, 0).batch.map((e) => e.seq), [1, 2, 3])
})

test("selectDrainBatch drains a single oversized turn alone and flags overshoot", () => {
  const entries = [entry(1, "x".repeat(4000), "y".repeat(4000)), entry(2, "z", "w")]
  const sel = selectDrainBatch(entries, 8, 1)
  assert.deepEqual(sel.batch.map((e) => e.seq), [1])
  assert.equal(sel.overshoot, true)
})

// ---------------------------------------------------------------------------
// Prompt + outcome parsing

test("buildDrainPrompt emits turn-id blocks and candidate notes", () => {
  const turns = [
    entry(1042, "remember the router login", "use the config file", { session: "ses_a", tags: ["network"], salience: 4, newTag: "homelab/router" }),
  ]
  const prompt = buildDrainPrompt(turns, [
    { path: "Network/Router.md", title: "Router", score: 9, snippet: "router notes", hash: "abc123" },
  ])
  assert.match(prompt, /### Turn #1042 \(session ses_a, salience 4, tags: network\)/)
  assert.match(prompt, /newTag hint: homelab\/router/)
  assert.match(prompt, /## User\nremember the router login/)
  assert.match(prompt, /## Assistant\nuse the config file/)
  assert.match(prompt, /Candidate existing notes/)
  assert.match(prompt, /Network\/Router\.md/)
  assert.match(prompt, /```consolidated/)
  assert.match(prompt, /```skipped/)
})

test("parseConsolidated and parseSkipped read #<seq> ids", () => {
  const reply = "did work\n\n```consolidated\n#1042\n#1043\n```\n```skipped\n#1044\n```"
  assert.deepEqual([...parseConsolidated(reply)].sort((a, b) => a - b), [1042, 1043])
  assert.deepEqual([...parseSkipped(reply)], [1044])
  assert.deepEqual([...parseSkipped("no fences here")], [])
})

test("recoverMislabeledConsolidated recovers prose-named ids only on a mislabeled block", () => {
  const seqs = [1042, 1043]
  const mislabeled = "I consolidated turn #1042 into a note.\n\n```consolidated\nsomething-else\n```"
  assert.deepEqual([...recoverMislabeledConsolidated(mislabeled, seqs)], [1042])

  const correct = "```consolidated\n#1042\n```"
  assert.deepEqual([...recoverMislabeledConsolidated(correct, seqs)], [])
  assert.deepEqual([...recoverMislabeledConsolidated("no block at all #1042", seqs)], [])
})

// ---------------------------------------------------------------------------
// Keywords, frontmatter tags, tag index

test("extractKeywords keeps repeated long terms and drops stopwords", () => {
  const kws = extractKeywords("opencode opencode pacman package the and install")
  assert.ok(kws.includes("opencode"))
  assert.ok(kws.includes("pacman"))
  assert.equal(kws.includes("the"), false)
})

test("parseFrontmatterTags handles scalar, inline, and block lists", () => {
  assert.deepEqual(parseFrontmatterTags("---\ntitle: X\ntags: alpha, beta\n---\nbody"), ["alpha", "beta"])
  assert.deepEqual(parseFrontmatterTags("---\ntags: [alpha, beta]\n---\n"), ["alpha", "beta"])
  assert.deepEqual(parseFrontmatterTags("---\ntags:\n  - ai/opencode\n  - agent/personality\n---\n"), ["ai/opencode", "agent/personality"])
  assert.deepEqual(parseFrontmatterTags("no frontmatter"), [])
})

test("buildTagIndex walks the vault and candidateTags ranks overlaps", async () => {
  const vault = await tmpDir()
  await mkdir(join(vault, "AI"), { recursive: true })
  await writeFile(
    join(vault, "AI", "A.md"),
    "---\ntitle: A\ntags:\n  - ai/opencode\n  - agent/personality\n---\nbody",
    "utf8",
  )
  await writeFile(join(vault, "AI", "B.md"), "---\ntitle: B\ntags: ai/opencode\n---\nbody", "utf8")
  await mkdir(join(vault, ".obsidian"), { recursive: true })
  await writeFile(join(vault, ".obsidian", "C.md"), "---\ntags: ignored\n---\n", "utf8")

  const index = await buildTagIndex(vault)
  const opencode = index.find((e) => e.tag === "ai/opencode")
  assert.equal(opencode?.count, 2)
  assert.equal(index.some((e) => e.tag === "ignored"), false)

  const ranked = candidateTags(["opencode", "agent"], index, 5)
  assert.ok(ranked.includes("ai/opencode"))
  assert.ok(ranked.includes("agent/personality"))
})

// ---------------------------------------------------------------------------
// Dedupe prefetch

test("findCandidateNotes scans every vault dir (no Raw/ exclusion)", async () => {
  const vault = await tmpDir()
  await mkdir(join(vault, "Raw"), { recursive: true })
  await writeFile(join(vault, "Raw", "raw-note.md"), "---\ntitle: Raw Note\ntags: [x]\n---\nneedle in the raw dir", "utf8")
  await mkdir(join(vault, ".obsidian"), { recursive: true })
  await writeFile(join(vault, ".obsidian", "hidden.md"), "needle should be skipped", "utf8")

  const candidates = await findCandidateNotes(vault, "/state/memory.json", ["needle"], 5)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].path, "Raw/raw-note.md")
})

// ---------------------------------------------------------------------------
// Spawner

test("spawnDrainChild registers the child in the shared automation guard set", async () => {
  automationChildSessions.clear()
  const calls: any[] = []
  const client = {
    session: {
      create: async (args: any) => {
        calls.push(args)
        return { data: { id: "ses_child" } }
      },
      promptAsync: async () => ({ response: { ok: true, status: 200 } }),
    },
  }
  const res = await spawnDrainChild(client as any, {
    parentID: "ses_parent",
    directory: "/tmp",
    prompt: "hello",
  })
  assert.equal(res.ok, true)
  assert.equal(res.sessionID, "ses_child")
  assert.equal(automationChildSessions.has("ses_child"), true)
  assert.equal(calls[0].body.title, "knowledge-consolidate")
  automationChildSessions.clear()
})
