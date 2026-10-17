import { test } from "node:test"
import assert from "node:assert/strict"
import type { CandidateNote } from "./candidates.ts"
import { buildConsolidationPrompt, type ConsolidationItem } from "./prompt.ts"

const ITEMS: ConsolidationItem[] = [
  {
    title: "Wireguard Setup",
    tags: ["linux/network", "vpn"],
    atoms: ["/etc/wireguard/wg0.conf", "--no-cache"],
    summary: "Configure wg0 with wg-quick.",
  },
  {
    title: "Backup Policy",
    tags: ["ops/backup"],
    atoms: ["borg create --stats"],
    summary: "Nightly borg backups to the NAS.",
  },
]

const CANDIDATES: CandidateNote[] = [
  {
    title: "Wireguard Setup",
    path: "Networking/Wireguard Setup.md",
    score: 30,
    snippet: "Existing note about wg0.",
    hash: "abc123def456",
  },
]

test("the first line is exactly Consolidation mode.", () => {
  const prompt = buildConsolidationPrompt(ITEMS)
  assert.equal(prompt.split("\n")[0], "Consolidation mode.")
})

test("items are labelled #1..N with title, tags, atoms, and summary", () => {
  const prompt = buildConsolidationPrompt(ITEMS)
  assert.match(prompt, /### Knowledge item #1\ntitle: Wireguard Setup\ntags: linux\/network, vpn\natoms:\n- \/etc\/wireguard\/wg0\.conf\n- --no-cache\nsummary:\nConfigure wg0 with wg-quick\./)
  assert.match(prompt, /### Knowledge item #2\ntitle: Backup Policy/)
  assert.equal(prompt.includes("#3"), false)
})

test("candidates are included when present and omitted when empty", () => {
  const withCandidates = buildConsolidationPrompt(ITEMS, CANDIDATES)
  assert.match(withCandidates, /Candidate existing notes \(deterministic prefetch — may be incomplete\):/)
  assert.match(withCandidates, /- Wireguard Setup \(Networking\/Wireguard Setup\.md\) \[score 30, sha1:abc123def456\]: Existing note about wg0\./)

  const without = buildConsolidationPrompt(ITEMS, [])
  assert.equal(without.includes("Candidate existing notes"), false)
})

test("the byte cap drops candidates first and keeps every item label", () => {
  const longItems: ConsolidationItem[] = ITEMS.map((item) => ({
    ...item,
    summary: "x".repeat(5000),
  }))
  const prompt = buildConsolidationPrompt(longItems, CANDIDATES, { maxBytes: 1200 })

  assert.ok(Buffer.byteLength(prompt, "utf8") <= 1200)
  assert.equal(prompt.includes("Candidate existing notes"), false)
  assert.match(prompt, /### Knowledge item #1/)
  assert.match(prompt, /### Knowledge item #2/)
  assert.match(prompt, /--no-cache/)
  assert.equal(prompt.split("\n")[0], "Consolidation mode.")
})

test("a zero cap disables truncation", () => {
  const longItems: ConsolidationItem[] = ITEMS.map((item) => ({
    ...item,
    summary: "x".repeat(5000),
  }))
  const prompt = buildConsolidationPrompt(longItems, CANDIDATES, { maxBytes: 0 })
  assert.ok(prompt.length > 10_000)
})
