// Tests for the `vault:` policy loader and the readonly-path matcher shared by
// vault-readonly-guard.ts (tool-boundary block) and wikilink-guard.ts (sweep
// skip). Pure functions only — no config file I/O (readSection is covered by
// config.test.ts).
import { test } from "node:test"
import assert from "node:assert/strict"
import { isReadonlyVaultPath, parseReadonlyDirs, DEFAULT_VAULT_POLICY } from "./vault-policy.ts"

const ROOT = "/repo/Brain"

test("DEFAULT_VAULT_POLICY keeps Journal user-write-only out of the box", () => {
  assert.deepEqual(DEFAULT_VAULT_POLICY, { readonly: "Journal" })
})

test("parseReadonlyDirs normalizes separators, spacing, and empties", () => {
  assert.deepEqual(parseReadonlyDirs("Journal"), ["Journal"])
  assert.deepEqual(parseReadonlyDirs(" Journal , Private/ "), ["Journal", "Private"])
  assert.deepEqual(parseReadonlyDirs("/Journal/"), ["Journal"])
  assert.deepEqual(parseReadonlyDirs("a,,b,"), ["a", "b"])
  assert.deepEqual(parseReadonlyDirs(""), [])
  assert.deepEqual(parseReadonlyDirs("  ,  "), [])
})

test("isReadonlyVaultPath matches absolute paths inside a readonly dir", () => {
  const dirs = ["Journal"]
  assert.equal(isReadonlyVaultPath(ROOT, `${ROOT}/Journal/2026/entry.md`, dirs), true)
  assert.equal(isReadonlyVaultPath(ROOT, `${ROOT}/Journal`, dirs), true)
  assert.equal(isReadonlyVaultPath(ROOT, `${ROOT}/Journalism/note.md`, dirs), false)
  assert.equal(isReadonlyVaultPath(ROOT, `${ROOT}/Notes/note.md`, dirs), false)
})

test("isReadonlyVaultPath matches vault-relative paths with or without root basename", () => {
  const dirs = ["Journal"]
  assert.equal(isReadonlyVaultPath(ROOT, "Journal/entry.md", dirs), true)
  assert.equal(isReadonlyVaultPath(ROOT, "./Journal/entry.md", dirs), true)
  assert.equal(isReadonlyVaultPath(ROOT, "Brain/Journal/entry.md", dirs), true)
  assert.equal(isReadonlyVaultPath(ROOT, "Notes/entry.md", dirs), false)
})

test("isReadonlyVaultPath rejects traversal, outside paths, and empty input", () => {
  const dirs = ["Journal"]
  assert.equal(isReadonlyVaultPath(ROOT, "", dirs), false)
  assert.equal(isReadonlyVaultPath(ROOT, "../Journal/entry.md", dirs), false)
  assert.equal(isReadonlyVaultPath(ROOT, "/etc/passwd", dirs), false)
  // `..` inside an absolute path normalizes into Journal/ — must still block.
  assert.equal(isReadonlyVaultPath(ROOT, `${ROOT}/Notes/../Journal/x.md`, dirs), true)
})

test("isReadonlyVaultPath is false when no readonly dirs are configured", () => {
  assert.equal(isReadonlyVaultPath(ROOT, `${ROOT}/Journal/entry.md`, []), false)
})

test("isReadonlyVaultPath supports multiple configured dirs", () => {
  const dirs = parseReadonlyDirs("Journal,Private")
  assert.equal(isReadonlyVaultPath(ROOT, `${ROOT}/Private/a.md`, dirs), true)
  assert.equal(isReadonlyVaultPath(ROOT, `${ROOT}/Journal/a.md`, dirs), true)
  assert.equal(isReadonlyVaultPath(ROOT, `${ROOT}/Public/a.md`, dirs), false)
})
