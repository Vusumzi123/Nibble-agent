// Tests for the decision-prompts loader: comment-tolerant flat-YAML parsing,
// per-key fallback to the built-in defaults, and never-throwing file reads.
// Also asserts the shipped .opencode/decision-prompts.yaml parses cleanly and
// mirrors the built-in defaults (so editing the file never silently diverges
// from the fallback strings without a corresponding test read).
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_DECISION_PROMPTS,
  mergeDecisionPrompts,
  parseDecisionPrompts,
  readDecisionPrompts,
  readDecisionPromptsFrom,
  resolveDecisionPrompts,
} from "./decision-prompts.ts"
import { DEFAULT_AUTONOMY_ASSERTION } from "./autonomy-gate.ts"
import { DEFAULT_DIGEST_ASSERTION } from "./heartbeat.ts"
import { DEFAULT_RETRIEVAL_ASSERTION } from "./retrieval.ts"

const VALID_YAML = [
  "# top-level banner comment",
  "",
  "retrieval:",
  "  # what the question does",
  '  assertion: "Custom retrieval assertion."',
  "",
  "autonomy:",
  '  assertion: "Custom autonomy assertion."',
  "",
  "digest:",
  '  assertion: "Custom digest assertion."',
  "",
].join("\n")

test("defaults carry every gate key and re-use the owning modules' strings", () => {
  assert.equal(DEFAULT_DECISION_PROMPTS.retrieval.assertion, DEFAULT_RETRIEVAL_ASSERTION)
  assert.equal(DEFAULT_DECISION_PROMPTS.autonomy.assertion, DEFAULT_AUTONOMY_ASSERTION)
  assert.equal(DEFAULT_DECISION_PROMPTS.digest.assertion, DEFAULT_DIGEST_ASSERTION)
  assert.ok(DEFAULT_DIGEST_ASSERTION.includes("no_reply"))
  assert.ok(DEFAULT_DIGEST_ASSERTION.includes("mission:<id>"))
})

test("parseDecisionPrompts reads all sections and strips comment lines + quotes", () => {
  const parsed = parseDecisionPrompts(VALID_YAML)
  assert.deepEqual(parsed.retrieval, { assertion: "Custom retrieval assertion." })
  assert.deepEqual(parsed.autonomy, { assertion: "Custom autonomy assertion." })
  assert.deepEqual(parsed.digest, { assertion: "Custom digest assertion." })
})

test("parseDecisionPrompts ignores unknown sections, keys, and blank input", () => {
  const yaml = ["unknown:", "  assertion: x", "", "retrieval:", "  bogus: nope", '  assertion: "Keep me."', ""].join("\n")
  const parsed = parseDecisionPrompts(yaml)
  assert.deepEqual(parsed, { retrieval: { assertion: "Keep me." } })
  assert.deepEqual(parseDecisionPrompts(""), {})
  assert.deepEqual(parseDecisionPrompts("not yaml at all"), {})
})

test("parseDecisionPrompts drops empty values but keeps values with colons/hash-free punctuation", () => {
  const yaml = ["retrieval:", '  assertion: "   "', "", "autonomy:", '  assertion: "a: b, c (1 = x, 2 = y)."', ""].join("\n")
  const parsed = parseDecisionPrompts(yaml)
  assert.equal(parsed.retrieval, undefined)
  assert.equal(parsed.autonomy?.assertion, "a: b, c (1 = x, 2 = y).")
})

test("mergeDecisionPrompts fills per key, not per section", () => {
  const merged = mergeDecisionPrompts({ retrieval: { assertion: "Custom retrieval." } })
  assert.equal(merged.retrieval.assertion, "Custom retrieval.")
  assert.equal(merged.autonomy.assertion, DEFAULT_DECISION_PROMPTS.autonomy.assertion)
  assert.equal(merged.digest.assertion, DEFAULT_DECISION_PROMPTS.digest.assertion)

  const digestMerged = mergeDecisionPrompts({ digest: { assertion: "Custom digest." } })
  assert.equal(digestMerged.digest.assertion, "Custom digest.")
  assert.equal(digestMerged.retrieval.assertion, DEFAULT_DECISION_PROMPTS.retrieval.assertion)
})

test("readDecisionPromptsFrom returns null for missing and unparseable files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decision-prompts-"))
  assert.equal(await readDecisionPromptsFrom(join(dir, "nope.yaml")), null)
  const junk = join(dir, "junk.yaml")
  await writeFile(junk, "# comment only\n\nretrieval:\n", "utf8")
  assert.equal(await readDecisionPromptsFrom(junk), null)
})

test("readDecisionPrompts falls back to defaults when the file is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decision-prompts-"))
  const prompts = await readDecisionPrompts(dir)
  assert.deepEqual(prompts, DEFAULT_DECISION_PROMPTS)
})

test("readDecisionPrompts overlays a partial file key by key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decision-prompts-"))
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(resolveDecisionPrompts(dir), VALID_YAML, "utf8")
  const prompts = await readDecisionPrompts(dir)
  assert.equal(prompts.retrieval.assertion, "Custom retrieval assertion.")
  assert.equal(prompts.autonomy.assertion, "Custom autonomy assertion.")
})

test("resolveDecisionPrompts keeps absolute leaves absolute", () => {
  assert.equal(resolveDecisionPrompts("/project"), "/project/.opencode/decision-prompts.yaml")
})

test("the shipped .opencode/decision-prompts.yaml parses and mirrors the defaults", async () => {
  const file = new URL("../../decision-prompts.yaml", import.meta.url)
  const text = await readFile(file, "utf8")
  const parsed = parseDecisionPrompts(text)
  assert.deepEqual(parsed, DEFAULT_DECISION_PROMPTS)
})
