import { test } from "node:test"
import assert from "node:assert/strict"
import {
  unescapeOutsideCode,
  normalizeFrontmatterDates,
  diffBulletRewrites,
  extractWritePaths,
  maskCode,
} from "./write-guard.ts"

// ---------------------------------------------------------------------------
// Escaped wikilinks

test("unescapeOutsideCode repairs prose escapes", () => {
  const { out, count } = unescapeOutsideCode("See \\[\\[Home Lab]] and \\[\\[Btrfs]].")
  assert.equal(count, 2)
  assert.equal(out, "See [[Home Lab]] and [[Btrfs]].")
})

test("unescapeOutsideCode leaves intended escapes inside code untouched", () => {
  const src = "prose \\[\\[Real]]\n```md\nexample \\[\\[NotReal]]\n```\ninline `\\[\\[Also]]`"
  const { out, count } = unescapeOutsideCode(src)
  assert.equal(count, 1) // only the prose escape
  assert.match(out, /prose \[\[Real]]/)
  assert.ok(out.includes("\\[\\[NotReal]]"), "fenced-code escape preserved")
  assert.ok(out.includes("`\\[\\[Also]]`"), "inline-code escape preserved")
})

test("maskCode round-trips masked regions", () => {
  const { work, restore } = maskCode("a `b` c")
  assert.doesNotMatch(work, /`b`/)
  assert.equal(restore(work), "a `b` c")
})

// ---------------------------------------------------------------------------
// Frontmatter dates

test("normalizeFrontmatterDates fixes quoted and ISO-timestamp dates", () => {
  const src = "---\ntitle: X\ncreated: '2026-08-05'\nupdated: 2026-08-04T00:00:00.000Z\n---\nbody"
  const { out, fixed, invalid } = normalizeFrontmatterDates(src)
  assert.equal(fixed, 2)
  assert.equal(invalid, 0)
  assert.match(out, /^created: 2026-08-05$/m)
  assert.match(out, /^updated: 2026-08-04$/m)
})

test("normalizeFrontmatterDates leaves canonical and invalid dates alone", () => {
  const src = "---\ncreated: 2026-08-05\nupdated: 2026-13-99\n---\nbody"
  const { out, fixed, invalid } = normalizeFrontmatterDates(src)
  assert.equal(fixed, 0)
  assert.equal(invalid, 1)
  assert.equal(out, src)
})

test("normalizeFrontmatterDates ignores dates outside frontmatter", () => {
  const src = "created: 2026-08-05T00:00:00Z\nbody"
  const { out, fixed } = normalizeFrontmatterDates(src)
  assert.equal(fixed, 0)
  assert.equal(out, src)
})

// ---------------------------------------------------------------------------
// Bullet rewrites

test("diffBulletRewrites detects and safely restores marker-only changes", () => {
  const before = "- one\n- two\n"
  const after = "* one\n* two\n"
  const diff = diffBulletRewrites(before, after)
  assert.equal(diff.kind, "safe")
  if (diff.kind === "safe") {
    assert.equal(diff.count, 2)
    assert.equal(diff.repaired, before)
  }
})

test("diffBulletRewrites returns none for identical content", () => {
  const same = "- one\n- two\n"
  assert.equal(diffBulletRewrites(same, same).kind, "none")
})

test("diffBulletRewrites refuses to guess on ambiguous changes", () => {
  const diff = diffBulletRewrites("- one\n- two\n", "* one\n- two\n* three\n")
  assert.equal(diff.kind, "ambiguous")

  const contentChange = diffBulletRewrites("- one\n", "- one changed\n")
  assert.equal(contentChange.kind, "ambiguous")
})

test("diffBulletRewrites treats a plain content edit as ambiguous", () => {
  assert.equal(diffBulletRewrites("a\n", "b\n").kind, "ambiguous")
})

// ---------------------------------------------------------------------------
// Write-path extraction

test("extractWritePaths handles native edit and write", () => {
  assert.deepEqual(extractWritePaths("edit", { filePath: "/v/a.md" }, "/v"), ["/v/a.md"])
  assert.deepEqual(extractWritePaths("write", { file_path: "/v/b.md" }, "/v"), ["/v/b.md"])
})

test("extractWritePaths parses apply_patch add/update/move/delete headers", () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: /v/new.md",
    "+hi",
    "*** Update File: /v/old.md",
    "*** Move to: /v/moved.md",
    "*** Delete File: /v/dead.md",
    "*** End Patch",
  ].join("\n")
  assert.deepEqual(extractWritePaths("apply_patch", { patchText: patch }, "/v"), [
    "/v/new.md",
    "/v/old.md",
    "/v/moved.md",
    "/v/dead.md",
  ])
})

test("extractWritePaths resolves markdown-vault write actions under the vault root", () => {
  assert.deepEqual(
    extractWritePaths("markdown-vault_vault", { action: "update", path: "Linux/X.md" }, "/v"),
    ["/v/Linux/X.md"],
  )
  // read-only actions are not write targets
  assert.deepEqual(extractWritePaths("markdown-vault_vault", { action: "read", path: "Linux/X.md" }, "/v"), [])
})
