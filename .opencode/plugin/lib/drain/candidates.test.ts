import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  candidateTags,
  extractTitlePhrases,
  findCandidateNotes,
  formatCandidate,
  normalizeTitle,
} from "./candidates.ts"

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "drain-vault-"))
  const write = async (rel: string, content: string): Promise<void> => {
    const file = join(root, rel)
    await mkdir(join(file, ".."), { recursive: true })
    await writeFile(file, content, "utf8")
  }

  await write(
    "Networking/Wireguard Setup.md",
    [
      "---",
      "title: Wireguard Setup",
      "tags: [linux/network, vpn]",
      "---",
      "# Wireguard Setup",
      "Use wg-quick with the tunnel config.",
    ].join("\n"),
  )
  await write("Networking/Unrelated.md", "---\ntitle: Unrelated\n---\nNothing to see.")
  await write("Raw/Wireguard Raw.md", "Wireguard tunnel raw notes")
  await write("meta/log.md", "Wireguard tunnel changelog")
  await write(".trash/Old.md", "Wireguard tunnel trash")
  await write("Notes/Wireguard.md", "Tunnel notes without frontmatter")
  return root
}

test("candidate prefetch scores and filters the vault", async () => {
  const vaultDir = await fixture()
  const found = await findCandidateNotes({
    vaultDir,
    keywords: ["wireguard", "tunnel"],
    limit: 5,
  })

  assert.equal(found[0].title, "Wireguard Setup")
  assert.equal(found[0].path, join("Networking", "Wireguard Setup.md"))
  assert.ok(found.every((c) => !c.path.startsWith("Raw")))
  assert.ok(found.every((c) => !c.path.startsWith("meta")))
  assert.ok(found.every((c) => !c.path.startsWith(".trash")))
})

test("title-phrase match adds the +20 boost", async () => {
  const vaultDir = await fixture()
  const base = await findCandidateNotes({
    vaultDir,
    keywords: ["wireguard", "tunnel"],
    limit: 5,
  })
  const boosted = await findCandidateNotes({
    vaultDir,
    keywords: ["wireguard", "tunnel"],
    phrases: ["wireguard setup"],
    limit: 5,
  })

  assert.equal(boosted[0].path, base[0].path)
  assert.equal(boosted[0].score, base[0].score + 20)
})

test("limit and empty keywords short-circuit", async () => {
  const vaultDir = await fixture()
  assert.deepEqual(await findCandidateNotes({ vaultDir, keywords: [], limit: 3 }), [])
  assert.deepEqual(await findCandidateNotes({ vaultDir, keywords: ["wireguard"], limit: 0 }), [])
  const one = await findCandidateNotes({ vaultDir, keywords: ["wireguard", "tunnel"], limit: 1 })
  assert.equal(one.length, 1)
})

test("formatCandidate matches the prompt shape", async () => {
  const vaultDir = await fixture()
  const [candidate] = await findCandidateNotes({ vaultDir, keywords: ["wireguard"], limit: 1 })
  const line = formatCandidate(candidate)
  assert.match(
    line,
    /^- .+ \(.+\) \[score \d+, sha1:[0-9a-f]{12}\]: .+$/,
  )
})

test("title phrases drop sentence heads", () => {
  assert.deepEqual(extractTitlePhrases("We deployed Wireguard Setup today."), ["wireguard setup"])
  assert.equal(normalizeTitle("  WireGuard — Setup! "), "wireguard setup")
})

test("candidateTags prefers hierarchy matches and respects the limit", () => {
  const index = [
    { tag: "linux/network", count: 10, notes: [] },
    { tag: "linux", count: 3, notes: [] },
    { tag: "cooking", count: 50, notes: [] },
  ]
  const tags = candidateTags(["linux", "network"], index, 2)
  assert.deepEqual(tags, ["linux/network", "linux"])
  assert.deepEqual(candidateTags([], index, 2), [])
})
