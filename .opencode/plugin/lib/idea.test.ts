import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_IDEA,
  DEFAULT_IDEA_PROMPTS,
  appendIdeaToBucket,
  buildGeneratePrompt,
  buildIdeaReviewRequest,
  drawDailyCount,
  drawDueTimes,
  drawWeightedIndex,
  extractIdea,
  ideaHash,
  ideaId,
  isDuplicate,
  isDue,
  isInActiveWindow,
  jaccard,
  keywordsOf,
  localDayKey,
  parseBucket,
  parseIdeaConfig,
  parseIdeaPrompts,
  parseWeights,
  readIdeaConfig,
  readIdeaPrompts,
  resolveIdeaFile,
  resolveIdeaPrompts,
  reviewAccepted,
} from "./idea.ts"

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "idea-"))
}

// Deterministic rng over a fixed sequence.
function seq(values: number[]): () => number {
  let i = 0
  return () => values[i++ % values.length]
}

test("parseIdeaConfig reads flat scalars and ignores comments/unknown keys", () => {
  const yaml = [
    "idea:",
    "  enabled: true",
    "  bucket_file: Kael Ideas.md   # under <vault>",
    "  interval_ms: 600000",
    "  dedupe_threshold: 0.42",
    "  express_email: false",
    "  bogus_key: 1",
    "other:",
    "  enabled: false",
  ].join("\n")
  const cfg = parseIdeaConfig(yaml)
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.bucket_file, "Kael Ideas.md")
  assert.equal(cfg.interval_ms, 600000)
  assert.equal(cfg.dedupe_threshold, 0.42)
  assert.equal(cfg.express_email, false)
  assert.equal((cfg as Record<string, unknown>).bogus_key, undefined)
})

test("readIdeaConfig overlays defaults, clamps, and never throws", async () => {
  const dir = await tmpDir()
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(
    join(dir, ".opencode/sysop-config.yaml"),
    "idea:\n  enabled: true\n  review_threshold: 2.5\n  active_start_hour: 23\n  active_end_hour: 9\n",
    "utf8",
  )
  const cfg = await readIdeaConfig(dir)
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.review_threshold, DEFAULT_IDEA.review_threshold)
  assert.equal(cfg.active_start_hour, DEFAULT_IDEA.active_start_hour)
  assert.equal(cfg.active_end_hour, DEFAULT_IDEA.active_end_hour)

  const missing = await readIdeaConfig(join(dir, "nope"))
  assert.deepEqual(missing, DEFAULT_IDEA)
})

test("parseWeights / drawWeightedIndex / drawDailyCount", () => {
  assert.deepEqual(parseWeights("25,55,20"), [25, 55, 20])
  assert.deepEqual(parseWeights("x,-1,5"), [0, 0, 5])
  assert.deepEqual(parseWeights(""), [])
  assert.equal(drawWeightedIndex([0, 0, 0], () => 0.5), 0)
  assert.equal(drawWeightedIndex([25, 55, 20], () => 0.1), 0)
  assert.equal(drawWeightedIndex([25, 55, 20], () => 0.5), 1)
  assert.equal(drawWeightedIndex([25, 55, 20], () => 0.99), 2)
  assert.equal(drawDailyCount("0,0,100", () => 0.5), 2)
})

test("drawDueTimes stay within the window on the base day and sort", () => {
  const base = new Date(2026, 0, 15, 12, 0, 0)
  const times = drawDueTimes(base, 3, 9, 23, seq([0.9, 0.1, 0.5]))
  assert.equal(times.length, 3)
  for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1])
  for (const t of times) {
    const d = new Date(t)
    assert.equal(d.getFullYear(), 2026)
    assert.equal(d.getMonth(), 0)
    assert.equal(d.getDate(), 15)
    assert.ok(d.getHours() >= 9 && d.getHours() < 23)
  }
  assert.deepEqual(drawDueTimes(base, 0, 9, 23, seq([0.5])), [])
})

test("localDayKey / isInActiveWindow / isDue", () => {
  const d = new Date(2026, 8, 26, 10, 30)
  assert.equal(localDayKey(d), "2026-09-26")
  assert.equal(isInActiveWindow(d, 9, 23), true)
  assert.equal(isInActiveWindow(d, 11, 23), false)
  assert.equal(isInActiveWindow(d, 0, 24), true)
  assert.equal(isDue([1000, 2000], 0, 1500), true)
  assert.equal(isDue([1000, 2000], 1, 1500), false)
  assert.equal(isDue([1000, 2000], 2, 9999), false)
})

const BUCKET = [
  "---",
  "title: Kael Ideas",
  "updated: 2026-09-27",
  "---",
  "# Kael Ideas",
  "",
  "## Ideas",
  "",
  "### First idea",
  '<!-- idea: {"id":"idea-aaa","category":"thought","created":"2026-09-27","hash":"aaa"} -->',
  "Some body text for the first idea.",
  "",
  "### Broken entry",
  "<!-- idea: {not json} -->",
  "This entry should be skipped.",
  "",
  "### Hand-written",
  "No comment here, still usable.",
].join("\n")

test("parseBucket is tolerant of malformed comments and missing metadata", () => {
  const entries = parseBucket(BUCKET)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].title, "First idea")
  assert.equal(entries[0].category, "thought")
  assert.equal(entries[0].id, "idea-aaa")
  assert.equal(entries[0].body, "Some body text for the first idea.")
  // The malformed-comment entry is skipped, not fatal.
  assert.ok(!entries.some((e) => e.title === "Broken entry"))
  const hand = entries[1]
  assert.equal(hand.title, "Hand-written")
  assert.equal(hand.category, "note")
  assert.equal(hand.hash, ideaHash("No comment here, still usable."))
  assert.equal(hand.id, ideaId("No comment here, still usable."))
})

test("appendIdeaToBucket seeds a shell when empty and round-trips", () => {
  const entry = {
    title: "Seeded",
    category: "business",
    id: ideaId("A marketable idea."),
    created: "2026-09-27",
    hash: ideaHash("A marketable idea."),
    body: "A marketable idea.",
  }
  const seeded = appendIdeaToBucket("", entry, "2026-09-27")
  assert.match(seeded, /^---\n/)
  assert.match(seeded, /## Ideas/)
  const parsedSeed = parseBucket(seeded)
  assert.equal(parsedSeed.length, 1)
  assert.equal(parsedSeed[0].title, "Seeded")
  assert.equal(parsedSeed[0].category, "business")

  const appended = appendIdeaToBucket(seeded, { ...entry, title: "Second" }, "2026-09-27")
  assert.equal(parseBucket(appended).length, 2)
})

test("extractIdea parses the marker block and rejects bad shapes", () => {
  const ok = extractIdea(
    ["<<<IDEA", "TITLE: A title", "CATEGORY: improve-self", "BODY:", "The body.", ">>>"].join("\n"),
  )
  assert.deepEqual(ok, { title: "A title", category: "improve-self", body: "The body." })
  assert.equal(extractIdea("no markers"), null)
  assert.equal(
    extractIdea(["<<<IDEA", "TITLE: t", "CATEGORY: nope", "BODY:", "b", ">>>"].join("\n")),
    null,
  )
  assert.equal(extractIdea(["<<<IDEA", "TITLE: t", "CATEGORY: thought", "BODY:", ">>>"].join("\n")), null)
})

test("jaccard / isDuplicate use keyword overlap", () => {
  const a = keywordsOf("deterministic retrieval cache eviction vector index policy")
  const b = keywordsOf("deterministic retrieval cache eviction vector index policy")
  assert.equal(jaccard(a, b), 1)
  assert.equal(jaccard(new Set(), a), 0)
  const existing = [{ body: "deterministic retrieval cache eviction vector index policy" }]
  assert.equal(
    isDuplicate("deterministic retrieval cache eviction vector index policy", existing, 0.6),
    true,
  )
  assert.equal(isDuplicate("totally unrelated business revenue idea", existing, 0.6), false)
})

test("buildGeneratePrompt embeds the category, guidance, seed and titles", () => {
  const prompt = buildGeneratePrompt({
    category: "business",
    criteria: "a plausible product",
    instructions: "Write one idea.",
    transcript: "User: hi",
    seed: "seed knowledge",
    existingTitles: ["Old idea"],
    today: "2026-09-27",
    categoryWeights: "1,1,1",
    transcriptMaxBytes: 12000,
  })
  assert.match(prompt, /<<<IDEA/)
  assert.match(prompt, /CATEGORY: business/)
  assert.match(prompt, /a plausible product/)
  assert.match(prompt, /seed knowledge/)
  assert.match(prompt, /- Old idea/)
})

test("buildIdeaReviewRequest is a noul decision with the assertion", () => {
  const req = buildIdeaReviewRequest(
    { title: "T", category: "thought", body: "B" },
    ["Other"],
    DEFAULT_IDEA_PROMPTS,
  )
  assert.equal(req.kind, "noul")
  assert.equal(req.allow_abstain, false)
  assert.equal(req.assertion, DEFAULT_IDEA_PROMPTS.review.assertion)
  assert.match(String(req.state), /Other/)
})

test("reviewAccepted is fail-closed", () => {
  assert.equal(reviewAccepted(true, 0.9, false, false, 0.6), true)
  assert.equal(reviewAccepted(true, 0.5, false, false, 0.6), false)
  assert.equal(reviewAccepted(true, 0.9, true, false, 0.6), false) // fallback
  assert.equal(reviewAccepted(true, 0.9, false, true, 0.6), false) // abstain
  assert.equal(reviewAccepted(false, 0.9, false, false, 0.6), false)
})

test("parseIdeaPrompts validates and readIdeaPrompts falls back", async () => {
  assert.ok(parseIdeaPrompts(DEFAULT_IDEA_PROMPTS))
  assert.equal(parseIdeaPrompts({ generate: {}, review: {} }), null)
  assert.equal(
    parseIdeaPrompts({
      generate: { instructions: "x", criteria: { "improve-self": "a" } },
      review: { assertion: "y" },
    }),
    null,
  )
  const dir = await tmpDir()
  assert.equal(await readIdeaPrompts(join(dir, "missing.json")), null)
  const file = join(dir, "bad.json")
  await writeFile(file, "{ nope")
  assert.equal(await readIdeaPrompts(file), null)
})

test("resolveIdeaFile / resolveIdeaPrompts", () => {
  assert.equal(resolveIdeaFile("/vault", "Kael Ideas.md"), "/vault/Kael Ideas.md")
  assert.equal(resolveIdeaFile("/vault", "/abs.md"), "/abs.md")
  assert.equal(resolveIdeaPrompts("/proj", "x.json"), "/proj/x.json")
  assert.equal(resolveIdeaPrompts("/proj", "/abs.json"), "/abs.json")
})
