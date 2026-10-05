import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_KEY_RE,
  HYPHEN_KEY_RE,
  extractBlock,
  parseFlatBlock,
  readSection,
  schemaFromDefaults,
  sectionCoercer,
  stripAnyQuotes,
  stripPairQuotes,
} from "./config.ts"

test("extractBlock slices only the indented body of the named section", () => {
  const yaml = ["a:", "  x: 1", "b:", "  y: 2", "  z: 3"].join("\n")
  assert.equal(extractBlock(yaml, "b"), "  y: 2\n  z: 3")
  assert.equal(extractBlock(yaml, "missing"), "")
  // A similar-prefixed section must not match.
  assert.equal(extractBlock("mail_extra:\n  x: 1\n", "mail"), "")
})

test("schemaFromDefaults infers bool/int/float/string", () => {
  assert.deepEqual(
    schemaFromDefaults({ a: true, b: 3, c: 1.5, d: "s", e: null }),
    { a: "bool", b: "int", c: "float", d: "string", e: "string" },
  )
})

test("strip helpers preserve pair-quotes and strip any-quotes", () => {
  assert.equal(stripPairQuotes('"a"'), "a")
  assert.equal(stripPairQuotes("'a b'"), "a b")
  assert.equal(stripPairQuotes('"'), '"')
  assert.equal(stripPairQuotes("a"), "a")
  assert.equal(stripAnyQuotes('"a"'), "a")
  assert.equal(stripAnyQuotes('a"'), "a")
  assert.equal(stripAnyQuotes('"a'), "a")
})

test("pair-quotes + strict sets match the telegram/mail/browser rule", () => {
  const coerce = sectionCoercer({
    bools: new Set(["enabled"]),
    ints: new Set(["max_chars"]),
    stringMode: "pair-quotes",
  })
  const parse = (raw: string) => parseFlatBlock(`telegram:\n  ${raw}\n`, "telegram", {
    knownKeys: new Set(["enabled", "max_chars", "agent"]),
    coerce,
  })
  assert.deepEqual(parse('agent: ""   # empty'), { agent: "" })
  assert.deepEqual(parse("agent: value"), { agent: "value" })
  assert.deepEqual(parse("agent:   "), {})
  assert.deepEqual(parse("enabled: true"), { enabled: true })
  assert.deepEqual(parse("enabled: maybe"), {})
  assert.deepEqual(parse("enabled: \"true\""), {})
  assert.deepEqual(parse("max_chars: 2000"), { max_chars: 2000 })
  assert.deepEqual(parse("max_chars: -1"), {})
})

test("any-quotes matches the audit string rule", () => {
  const coerce = sectionCoercer({
    bools: new Set(["enabled"]),
    stringMode: "any-quotes",
  })
  const parse = (line: string) =>
    parseFlatBlock(`audit:\n  ${line}\n`, "audit", {
      knownKeys: new Set(["enabled", "log"]),
      coerce,
    })
  assert.deepEqual(parse("log: audit.log"), { log: "audit.log" })
  assert.deepEqual(parse('log: "audit.log"'), { log: "audit.log" })
  assert.deepEqual(parse('log: audit.log"'), { log: "audit.log" })
})

test("valueTyped matches the knowledge rule (signed ints, bool by value)", () => {
  const coerce = sectionCoercer({ valueTyped: true, intPattern: /^-?\d+$/ })
  const parse = (line: string) =>
    parseFlatBlock(`knowledge:\n  ${line}\n`, "knowledge", {
      knownKeys: new Set(["enabled", "raw_dir", "chunk_bytes", "threshold_turns"]),
      coerce,
    })
  assert.deepEqual(parse("enabled: false"), { enabled: false })
  assert.deepEqual(parse("chunk_bytes: -1"), { chunk_bytes: -1 })
  assert.deepEqual(parse("threshold_turns: 0"), { threshold_turns: 0 })
  assert.deepEqual(parse("raw_dir: Raw"), { raw_dir: "Raw" })
  assert.deepEqual(parse("chunk_bytes: 300000  # comment"), { chunk_bytes: 300000 })
})

test("stripQuotesFirst + Number float matches profile", () => {
  const coerce = sectionCoercer({
    bools: new Set(["enabled"]),
    floats: new Set(["review_threshold"]),
    coerceFloat: (raw) => {
      const n = Number(raw)
      return Number.isFinite(n) ? n : undefined
    },
    stripQuotesFirst: true,
    stringMode: "raw",
  })
  const parse = (line: string) =>
    parseFlatBlock(`profile:\n  ${line}\n`, "profile", {
      knownKeys: new Set(["enabled", "review_threshold", "writer_model"]),
      coerce,
    })
  assert.deepEqual(parse('enabled: "true"'), { enabled: true })
  assert.deepEqual(parse("enabled: maybe"), {})
  assert.deepEqual(parse('writer_model: "deepseek/deepseek-flash"'), {
    writer_model: "deepseek/deepseek-flash",
  })
  assert.deepEqual(parse('writer_model: ""'), {})
  assert.deepEqual(parse("review_threshold: 0.72"), { review_threshold: 0.72 })
  assert.deepEqual(parse("review_threshold: 1e3"), { review_threshold: 1000 })
})

test("paths rule: hyphen keys, raw strings, empty dropped", () => {
  const coerce = sectionCoercer({ stringMode: "raw" })
  const yaml = ["paths:", "  vault: Brain  # comment", "  x-y: keep"].join("\n")
  assert.deepEqual(
    parseFlatBlock(yaml, "paths", {
      knownKeys: new Set(["vault", "sysop", "diagrams", "x-y"]),
      keyPattern: HYPHEN_KEY_RE,
      coerce,
    }),
    { vault: "Brain", "x-y": "keep" },
  )
})

test("default schema coercion preserves a quoted empty when asked", () => {
  const opts = { schema: { agent: "string" as const }, knownKeys: new Set(["agent"]) }
  // Without preserveQuotedEmpty the raw quoted text is kept verbatim.
  assert.deepEqual(parseFlatBlock('s:\n  agent: ""\n', "s", opts), { agent: '""' })
  // With it, a quoted empty becomes the empty string.
  assert.deepEqual(
    parseFlatBlock('s:\n  agent: ""\n', "s", { ...opts, preserveQuotedEmpty: true }),
    { agent: "" },
  )
  assert.deepEqual(parseFlatBlock("s:\n  agent:\n", "s", { ...opts, preserveQuotedEmpty: true }), {})
})

test("readSection overlays defaults, ignores unknown keys, never throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfg-"))
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(
    join(dir, ".opencode", "sysop-config.yaml"),
    "demo:\n  b: 42\n  c: extra\n  unknown: 1\n",
    "utf8",
  )
  const defaults = { a: true, b: 1 }
  const got = await readSection(dir, "demo", defaults)
  assert.deepEqual(got, { a: true, b: 42 })

  const missing = await readSection(join(dir, "nope"), "demo", defaults)
  assert.deepEqual(missing, defaults)
})

test("DEFAULT_KEY_RE rejects hyphen keys that HYPHEN_KEY_RE accepts", () => {
  assert.equal(DEFAULT_KEY_RE.test("  x-y: 1"), false)
  assert.equal(HYPHEN_KEY_RE.test("  x-y: 1"), true)
})
