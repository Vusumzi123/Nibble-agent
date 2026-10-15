import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_IDEA,
  DEFAULT_IDEA_STATE,
  IDEA_BUCKET_TEMPLATE,
  IDEA_CATEGORIES,
  appendIdeaToBucket,
  buildIdeaReviewRequest,
  drawCategory,
  drawDailyCount,
  drawWeightedIndex,
  extractIdea,
  ideaDayContext,
  ideaHash,
  ideaId,
  isDuplicate,
  jaccard,
  keywordsOf,
  localDayKey,
  parseBucket,
  parseIdeaConfig,
  parseWeights,
  readBucket,
  readIdeaConfig,
  recordExpressed,
  recordGenerated,
  renderIdeaEntry,
  resolveIdeaFile,
  reviewAccepted,
  writeIdeaToBucket,
  type IdeaEntry,
} from "./idea.ts"

// ---------------------------------------------------------------------------
// Config

test("parseIdeaConfig overlays only the idea block; unknown keys ignored", () => {
  const yaml = [
    "heartbeat:",
    "  enabled: true",
    "idea:",
    "  enabled: true",
    '  daily_weights: "10,60,30"',
    "  dedupe_threshold: 0.75",
    "  express_min_gap_hours: 24",
    "  interval_ms: 999",
    "  bogus_key: 1",
    "",
  ].join("\n")
  const parsed = parseIdeaConfig(yaml)
  assert.deepEqual(parsed, {
    enabled: true,
    daily_weights: "10,60,30",
    dedupe_threshold: 0.75,
    express_min_gap_hours: 24,
  })
})

test("readIdeaConfig: missing file -> defaults; garbage thresholds clamped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "idea-cfg-"))
  try {
    const defaults = await readIdeaConfig(dir)
    assert.deepEqual(defaults, DEFAULT_IDEA)
    assert.equal(defaults.enabled, false, "block absent -> pipeline off (fail closed)")

    const bad = join(dir, ".opencode")
    await mkdir(bad, { recursive: true })
    await writeFile(
      join(bad, "sysop-config.yaml"),
      ["idea:", "  dedupe_threshold: 7", "  review_threshold: -1", "  express_min_gap_hours: 0", "  bucket_file: ", ""].join("\n"),
      "utf8",
    )
    const cfg = await readIdeaConfig(dir)
    assert.equal(cfg.dedupe_threshold, DEFAULT_IDEA.dedupe_threshold, "out-of-range -> default")
    assert.equal(cfg.review_threshold, DEFAULT_IDEA.review_threshold, "negative -> default")
    assert.equal(cfg.express_min_gap_hours, DEFAULT_IDEA.express_min_gap_hours, "non-positive -> default")
    assert.equal(cfg.bucket_file, DEFAULT_IDEA.bucket_file, "empty leaf -> default")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("resolveIdeaFile: absolute leaf passes through, relative joins the vault", () => {
  assert.equal(resolveIdeaFile("/vault", "/tmp/x.md"), "/tmp/x.md")
  assert.equal(resolveIdeaFile("/vault", "Kael Ideas.md"), join("/vault", "Kael Ideas.md"))
})

// ---------------------------------------------------------------------------
// Draws (injectable RNG)

test("parseWeights: valid, garbage, empty", () => {
  assert.deepEqual(parseWeights("25,55,20"), [25, 55, 20])
  assert.deepEqual(parseWeights(" 1 , 0 , 2 "), [1, 0, 2])
  assert.deepEqual(parseWeights("x,-3,10"), [0, 0, 10])
  assert.deepEqual(parseWeights(""), [])
})

test("drawWeightedIndex: boundaries of the daily draw (25,55,20)", () => {
  assert.equal(drawWeightedIndex([25, 55, 20], () => 0), 0)
  assert.equal(drawWeightedIndex([25, 55, 20], () => 0.249), 0)
  assert.equal(drawWeightedIndex([25, 55, 20], () => 0.26), 1)
  assert.equal(drawWeightedIndex([25, 55, 20], () => 0.79), 1)
  assert.equal(drawWeightedIndex([25, 55, 20], () => 0.81), 2)
  assert.equal(drawWeightedIndex([25, 55, 20], () => 0.999), 2)
  assert.equal(drawWeightedIndex([0, 0, 0], () => 0.5), 0, "all-zero -> 0")
  assert.equal(drawWeightedIndex([], () => 0.5), 0, "empty -> 0")
})

test("drawDailyCount maps the weight index to the day's count", () => {
  assert.equal(drawDailyCount("25,55,20", () => 0.1), 0)
  assert.equal(drawDailyCount("25,55,20", () => 0.5), 1)
  assert.equal(drawDailyCount("25,55,20", () => 0.9), 2)
})

test("drawCategory: weighted over the three categories; malformed weights degrade uniform", () => {
  assert.equal(drawCategory("1,1,1", () => 0), "improve-self")
  assert.equal(drawCategory("1,1,1", () => 0.99), "business")
  assert.equal(drawCategory("garbage", () => 0.1), "improve-self")
  assert.equal(drawCategory("garbage", () => 0.99), "business")
  assert.ok((IDEA_CATEGORIES as readonly string[]).includes(drawCategory("", () => 0.5)))
})

test("localDayKey: YYYY-MM-DD", () => {
  assert.equal(localDayKey(new Date(2026, 0, 5)), "2026-01-05")
  assert.equal(localDayKey(new Date(2026, 11, 31)), "2026-12-31")
})

// ---------------------------------------------------------------------------
// Day state (`.opencode/state/idea.json` semantics)

test("ideaDayContext: same day passes through, new day rolls over and resets the count", () => {
  const now = new Date(2026, 9, 14, 12, 0).getTime()
  const sameKey = localDayKey(new Date(now))
  const steady = { ...DEFAULT_IDEA_STATE, dayKey: sameKey, dailyTarget: 1, generatedToday: 1 }
  const a = ideaDayContext(steady, now, "25,55,20", () => 0.99)
  assert.equal(a.changed, false)
  assert.deepEqual(a.day, { target: 1, generated: 1 }, "budget spent stays spent")
  assert.equal(a.state, steady, "no mutation on a same-day read")

  const nextDay = now + 24 * 3_600_000
  const b = ideaDayContext({ ...steady, generatedToday: 1 }, nextDay, "25,55,20", () => 0.99)
  assert.equal(b.changed, true)
  assert.equal(b.state.dayKey, localDayKey(new Date(nextDay)))
  assert.equal(b.state.dailyTarget, 2, "rng 0.99 -> count 2")
  assert.equal(b.state.generatedToday, 0, "count resets on rollover")
  assert.equal(b.state.lastExpressedAt, steady.lastExpressedAt, "express gap survives the rollover")
  assert.deepEqual(b.day, { target: 2, generated: 0 })
})

test("recordGenerated / recordExpressed are pure updates", () => {
  const s = recordGenerated(DEFAULT_IDEA_STATE)
  assert.equal(s.generatedToday, 1)
  assert.equal(recordGenerated(s).generatedToday, 2)
  const e = recordExpressed(s, 1_000)
  assert.equal(e.lastExpressedAt, 1_000)
  assert.equal(e.generatedToday, 1, "express stamp does not touch the count")
  assert.equal(DEFAULT_IDEA_STATE.generatedToday, 0, "input untouched")
})

// ---------------------------------------------------------------------------
// Bucket note

const ENTRY: IdeaEntry = {
  title: "Cache the retrieval filters",
  category: "improve-self",
  id: "idea-cafebabe",
  created: "2026-10-14",
  hash: "cafebabe",
  body: "Memoize the retrieval filter pipeline so a turn costs one disk scan instead of five.",
}

test("bucket: render -> append -> parse round-trip; empty note seeds the shell", () => {
  const seeded = appendIdeaToBucket("", ENTRY, "2026-10-14")
  assert.ok(seeded.startsWith("---"), "shell frontmatter seeded")
  assert.ok(seeded.includes(IDEA_BUCKET_TEMPLATE.split("\n")[1]), "title line present")
  const second = appendIdeaToBucket(seeded, { ...ENTRY, title: "Second", id: "idea-00000001" }, "2026-10-15")
  const parsed = parseBucket(second)
  assert.equal(parsed.length, 2)
  assert.deepEqual(parsed.map((p) => p.title), ["Cache the retrieval filters", "Second"])
  assert.equal(parsed[0].category, "improve-self")
  assert.equal(parsed[0].hash, "cafebabe")
})

test("bucket: tolerant parser skips malformed metadata, synthesizes missing", () => {
  const text = [
    "## Ideas",
    "",
    "### Good one",
    '<!-- idea: {"id":"idea-aaaa","category":"thought","created":"2026-10-01","hash":"aaaa1111"} -->',
    "Body A.",
    "",
    "### Broken metadata",
    "<!-- idea: {not json} -->",
    "Body B should be skipped.",
    "",
    "### Hand written",
    "No comment here — metadata synthesized.",
    "",
  ].join("\n")
  const parsed = parseBucket(text)
  assert.deepEqual(parsed.map((p) => p.title), ["Good one", "Hand written"])
  assert.equal(parsed[1].id, ideaId("No comment here — metadata synthesized."))
  assert.equal(parsed[1].hash, ideaHash("No comment here — metadata synthesized."))
  assert.equal(parsed[1].category, "note")
  assert.deepEqual(parseBucket(""), [])
  assert.deepEqual(parseBucket("garbage\n### \nempty title"), [])
})

test("bucket: renderIdeaEntry emits the hidden comment block", () => {
  const out = renderIdeaEntry(ENTRY)
  assert.ok(out.startsWith("### Cache the retrieval filters\n"))
  assert.ok(out.includes("<!-- idea: "))
  assert.ok(out.includes('"category":"improve-self"'))
  assert.ok(out.trimEnd().endsWith(ENTRY.body))
})

test("writeIdeaToBucket: creates the file, seeds the shell, bumps updated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "idea-bucket-"))
  try {
    const file = join(dir, "Brain", "Kael Ideas.md")
    await writeIdeaToBucket(file, ENTRY, "2026-10-14")
    const onDisk = await readFile(file, "utf8")
    assert.ok(onDisk.includes("updated: 2026-10-14"))
    await writeIdeaToBucket(file, { ...ENTRY, title: "Second idea", id: "idea-00000002" }, "2026-10-15")
    const parsed = parseBucket(await readFile(file, "utf8"))
    assert.equal(parsed.length, 2)
    assert.ok((await readFile(file, "utf8")).includes("updated: 2026-10-15"))
    assert.equal(await readBucket(join(dir, "missing.md")), "", "missing bucket reads empty")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Extract + dedupe

test("extractIdea: strict block with wrapper tolerance", () => {
  const block = ["<<<IDEA", "TITLE: Ship a fleet dashboard", "CATEGORY: business", "BODY:", "Two paragraphs of markdown.", ">>>"].join("\n")
  const parsed = extractIdea(`Some lead-in.\n${block}\nTrailing summary.`)
  assert.ok(parsed)
  assert.equal(parsed.title, "Ship a fleet dashboard")
  assert.equal(parsed.category, "business")
  assert.equal(parsed.body, "Two paragraphs of markdown.")
  assert.equal(extractIdea("no markers here"), null)
  assert.equal(extractIdea("<<<IDEA\nCATEGORY: business\nBODY:\nB\n>>>"), null, "missing TITLE")
  assert.equal(extractIdea("<<<IDEA\nTITLE: t\nCATEGORY: business\n>>>"), null, "missing BODY")
  assert.equal(extractIdea("<<<IDEA\nTITLE: t\nCATEGORY: unknown\nBODY:\nB\n>>>"), null, "bad category")
  assert.equal(extractIdea(block.replace("<<<IDEA", "```")), null, "unclosed")
})

test("dedupe: keyword Jaccard flags near-duplicates, lets novel bodies through", () => {
  const a = "Memoize the retrieval filter pipeline so a turn costs one disk scan instead of five scans."
  const b = "Memoize retrieval filters so one turn costs a single disk scan instead of five scans."
  const c = "Add a Telegram bridge that relays approval prompts to the phone with inline buttons."
  assert.ok(jaccard(keywordsOf(a), keywordsOf(a)) === 1)
  assert.ok(isDuplicate(b, [{ body: a }], 0.6), "near-duplicate rejected")
  assert.ok(!isDuplicate(c, [{ body: a }], 0.6), "novel body accepted")
  assert.ok(!isDuplicate(c, [], 0.6), "empty bucket never dedupes")
})

// ---------------------------------------------------------------------------
// JEV reviewer (fail-closed for the write)

test("buildIdeaReviewRequest: noul, no abstain, state carries category/idea/titles", () => {
  const req = buildIdeaReviewRequest(
    { title: "T", category: "thought", body: "B" },
    ["Existing one", "Existing two"],
  )
  assert.equal(req.kind, "noul")
  assert.equal(req.allow_abstain, false)
  assert.ok(typeof req.state === "string")
  const state = req.state as string
  assert.ok(state.includes("=== CATEGORY ===\nthought"))
  assert.ok(state.includes("# T"))
  assert.ok(state.includes("- Existing one"))
  assert.ok(req.assertion.length > 0)
  const empty = buildIdeaReviewRequest({ title: "T", category: "thought", body: "B" }, [])
  assert.ok((empty.state as string).includes("(none yet)"))
})

test("reviewAccepted: fail-closed matrix", () => {
  const T = 0.6
  assert.equal(reviewAccepted(true, 0.9, false, false, T), true, "confident yes")
  assert.equal(reviewAccepted(true, 0.6, false, false, T), true, "threshold inclusive")
  assert.equal(reviewAccepted(true, 0.5, false, false, T), false, "sub-threshold")
  assert.equal(reviewAccepted(true, 0.9, true, false, T), false, "fallback never writes")
  assert.equal(reviewAccepted(true, 0.9, false, true, T), false, "abstain never writes")
  assert.equal(reviewAccepted(false, 0.9, false, false, T), false, "no")
  assert.equal(reviewAccepted(null, 0.9, false, false, T), false, "null verdict")
  assert.equal(reviewAccepted(true, Number.NaN, false, false, T), false, "missing pTrue")
})
