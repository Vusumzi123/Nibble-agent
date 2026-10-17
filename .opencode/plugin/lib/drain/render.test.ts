import { test } from "node:test"
import assert from "node:assert/strict"
import type { DrainTurn } from "./db.ts"
import { extractAtoms, hashContent, renderSession, truncateToBytes } from "./render.ts"

function turn(id: string, time: number, role: string, text: string): DrainTurn {
  return { id, sessionID: "ses_1", time, role, text }
}

test("groups consecutive roles under User/Assistant headers", () => {
  const rendered = renderSession("ses_1", [
    turn("m3", 300, "assistant", "third"),
    turn("m1", 100, "user", "first"),
    turn("m2", 200, "user", "second"),
  ])
  assert.ok(rendered)
  assert.equal(
    rendered.text,
    "## User\nfirst\n\nsecond\n\n## Assistant\nthird",
  )
  assert.deepEqual(
    rendered.turns.map((t) => t.id),
    ["m1", "m2", "m3"],
  )
})

test("empty turns are skipped and an empty delta returns null", () => {
  assert.equal(renderSession("ses_1", [turn("m1", 1, "user", "   ")]), null)
  assert.equal(renderSession("ses_1", []), null)

  const rendered = renderSession("ses_1", [
    turn("m1", 1, "user", "   "),
    turn("m2", 2, "user", "real"),
  ])
  assert.equal(rendered?.text, "## User\nreal")
})

test("prior summary is prepended for continuity", () => {
  const rendered = renderSession("ses_1", [turn("m1", 100, "user", "new")], {
    priorSummary: "previously we configured the router",
  })
  assert.ok(rendered)
  assert.match(rendered.text, /^## Prior summary\npreviously we configured the router\n\n## User\nnew$/)
})

test("byte ceiling never splits a multi-byte code point", () => {
  const rendered = renderSession("ses_1", [turn("m1", 1, "user", "ééééé")], { maxBytes: 13 })
  assert.ok(rendered)
  assert.ok(Buffer.byteLength(rendered.text, "utf8") <= 13)
  assert.equal(rendered.text.includes("\uFFFD"), false)
  assert.equal(truncateToBytes("abc", 0), "")
  assert.equal(truncateToBytes("abc", 3), "abc")
})

test("atom extraction preserves commands, paths, URLs, keys, flags, files, decisions", () => {
  const atoms = extractAtoms(
    [
      "We decided to always use WireGuard for remote access.",
      "sudo systemctl restart wg-quick@wg0",
      "Config lives at /etc/wireguard/wg0.conf",
      "Docs: https://example.com/wireguard?mode=server",
      "BRAVE_API_KEY=abc123",
      "Run with --no-cache if needed.",
      "See config.yaml and [[Wireguard Setup]].",
    ].join("\n"),
  )

  for (const expected of [
    "We decided to always use WireGuard for remote access.",
    "sudo systemctl restart wg-quick@wg0",
    "/etc/wireguard/wg0.conf",
    "https://example.com/wireguard?mode=server",
    "BRAVE_API_KEY=abc123",
    "--no-cache",
    "config.yaml",
    "[[Wireguard Setup]]",
  ]) {
    assert.ok(atoms.includes(expected), `missing atom: ${expected}`)
  }
})

test("atoms are deduped and capped", () => {
  const atoms = extractAtoms("https://a.example\nhttps://a.example\nhttps://b.example", 1)
  assert.deepEqual(atoms, ["https://a.example"])
})

test("hashContent is stable and distinguishes atoms", () => {
  assert.equal(hashContent(" summary ", ["a"]), hashContent("summary", ["a"]))
  assert.notEqual(hashContent("summary", ["a"]), hashContent("summary", ["b"]))
  assert.match(hashContent("summary", ["a"]), /^[0-9a-f]{40}$/)
})
