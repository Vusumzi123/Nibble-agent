import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_KEY_RE,
  HYPHEN_KEY_RE,
  extractBlock,
  isDuration,
  overlayNestedSection,
  parseFlatBlock,
  parseInlineList,
  parseNestedSection,
  readNestedSection,
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
  assert.deepEqual(parse('writer_model: "example/model"'), {
    writer_model: "example/model",
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

// ---------------------------------------------------------------------------
// Nested sections (autonomy harness — card 1)

test("extractBlock tolerates a trailing comment on the section line", () => {
  const yaml = ["mood:   # harness dials", "  dispatch_influence: true", ""].join("\n")
  assert.equal(extractBlock(yaml, "mood"), "  dispatch_influence: true\n")
  // A similar-prefixed section still must not match.
  assert.equal(extractBlock("mood_x:\n  a: 1\n", "mood"), "")
})

test("parseInlineList parses bracketed lists and rejects non-lists", () => {
  assert.deepEqual(parseInlineList("[drain, dream]"), ["drain", "dream"])
  assert.deepEqual(parseInlineList("[ a , 'b' , \"c\" ]"), ["a", "b", "c"])
  assert.deepEqual(parseInlineList("[]"), [])
  assert.equal(parseInlineList("drain"), undefined)
  assert.equal(parseInlineList("[unclosed"), undefined)
})

test("isDuration accepts whole hours/minutes only", () => {
  assert.equal(isDuration("12h"), true)
  assert.equal(isDuration("30m"), true)
  assert.equal(isDuration("1.5h"), false)
  assert.equal(isDuration("off"), false)
})

test("parseNestedSection splits scalars from one-level sub-blocks", () => {
  const yaml = [
    "autonomy:",
    "  level: 2              # cap dial",
    "  root_classes: []",
    "  heartbeat:",
    "    frequency: 12h",
    "    in_progress_lock: false  # comment",
    "  quiet:",
    '    window: "23:00-08:00"',
    "    dream_missions: [drain, dream]",
    "",
  ].join("\n")
  const got = parseNestedSection(yaml, "autonomy", {
    scalarKeys: new Set(["level", "root_classes"]),
    blockKeys: { heartbeat: new Set(["frequency", "in_progress_lock"]), quiet: new Set(["window", "dream_missions"]) },
    listKeys: new Set(["root_classes"]),
    blockListKeys: new Set(["quiet.dream_missions"]),
    coerce: (path, raw) => ({ ok: true, value: `${path}=${raw}` }),
  })
  assert.deepEqual(got.scalars, { level: "level=2", root_classes: "root_classes=[]" })
  assert.deepEqual(got.blocks, {
    heartbeat: { frequency: "heartbeat.frequency=12h", in_progress_lock: "heartbeat.in_progress_lock=false" },
    quiet: { window: 'quiet.window="23:00-08:00"', dream_missions: "quiet.dream_missions=[drain, dream]" },
  })
  assert.deepEqual(got.rejects, [])
})

test("parseNestedSection reads block-form lists and flushes them through coerce", () => {
  const yaml = [
    "autonomy:",
    "  root_classes:",
    "    - pacman -Syu",
    "    - systemctl restart foo",
    "",
  ].join("\n")
  const got = parseNestedSection(yaml, "autonomy", {
    scalarKeys: new Set(["root_classes"]),
    listKeys: new Set(["root_classes"]),
    coerce: (path, raw) => ({ ok: true, value: `${path}=${raw}` }),
  })
  assert.deepEqual(got.scalars, {
    root_classes: "root_classes=[pacman -Syu, systemctl restart foo]",
  })
  assert.deepEqual(got.rejects, [])
})

test("parseNestedSection reports unknown keys and coercion failures as rejects", () => {
  const yaml = [
    "autonomy:",
    "  level: 7",
    "  typo_key: hello",
    "  empty_scalar:",
    "  quiet:",
    "    window: bogus",
    "    nope: 1",
    "",
  ].join("\n")
  const got = parseNestedSection(yaml, "autonomy", {
    scalarKeys: new Set(["level", "empty_scalar"]),
    blockKeys: { quiet: new Set(["window"]) },
    coerce: (path, raw) =>
      path === "level"
        ? /^\d+$/.test(raw)
          ? { ok: true, value: parseInt(raw, 10) }
          : { ok: false, reason: "int" }
        : path === "quiet.window"
          ? raw === "bogus"
            ? { ok: false, reason: "bad window" }
            : { ok: true, value: raw }
          : { ok: true, value: raw },
  })
  assert.deepEqual(got.scalars, { level: 7 })
  assert.deepEqual(got.rejects.map((r) => r.path), ["typo_key", "empty_scalar", "quiet.window", "quiet.nope"])
})

test("overlayNestedSection keeps defaults for rejected and absent keys", () => {
  const defaults = {
    scalars: { level: 1, budget: 32000 },
    blocks: { quiet: { window: "23:00-08:00", backoff: true } },
  }
  const parsed = {
    scalars: { level: 3 },
    blocks: { quiet: { backoff: false } },
    rejects: [{ path: "quiet.window", raw: "bogus", reason: "bad" }],
  }
  const got = overlayNestedSection(defaults, parsed)
  assert.deepEqual(got.scalars, { level: 3, budget: 32000 })
  assert.deepEqual(got.blocks, { quiet: { window: "23:00-08:00", backoff: false } })
  assert.equal(got.rejects.length, 1)
  // Defaults are not mutated.
  assert.equal((defaults.scalars as { level: number }).level, 1)
})

test("readNestedSection falls back to defaults for a missing config dir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfg-"))
  const defaults = { scalars: { a: 1 }, blocks: { b: { c: true } } }
  const got = await readNestedSection(join(dir, "nope"), "autonomy", defaults, {
    scalarKeys: new Set(["a"]),
    blockKeys: { b: new Set(["c"]) },
  })
  assert.deepEqual(got.scalars, { a: 1 })
  assert.deepEqual(got.blocks, { b: { c: true } })
  assert.deepEqual(got.rejects, [])
})
