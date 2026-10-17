import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  DREAM_FIXED_PROMPT,
  DREAM_TONE_EVENT,
  DREAM_TONES,
  appendDream,
  buildDreamPrompt,
  dreamHash,
  formatDreamEntry,
  newDreamId,
  parseDreamBucket,
  parseDreamOutcome,
  type DreamMeta,
} from "./dream.ts"
import { applyEvent, defaultMoodState } from "./mood.ts"

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

// --- typed outcome parser (§17.5 "LLM proposes, hook disposes") -------------

test("parseDreamOutcome: bare JSON object", () => {
  const o = parseDreamOutcome(
    '{"title":"Glass elevator","narrative":"I rode an elevator made of rain.","tone":"bizarre","seeds":["Agent.md"]}',
  )
  assert.ok(o)
  assert.equal(o.title, "Glass elevator")
  assert.equal(o.tone, "bizarre")
  assert.deepEqual(o.seeds, ["Agent.md"])
})

test("parseDreamOutcome: fenced JSON inside prose is found; prose outside ignored", () => {
  const text = [
    "Here is my dream:",
    "```json",
    '{"title":"Tide","narrative":"The sea whispered my username.","tone":"anxious","seeds":[1,"Soul.md",null,"  "]}',
    "```",
    "Hope that helps!",
  ].join("\n")
  const o = parseDreamOutcome(text)
  assert.ok(o)
  assert.equal(o.tone, "anxious")
  assert.deepEqual(o.seeds, ["Soul.md"], "non-string and blank seeds are filtered")
})

test("parseDreamOutcome: prose-wrapped bare object (first balanced block)", () => {
  const o = parseDreamOutcome('Sure! {"title":"X","narrative":"Y.","tone":"pleasant"} done')
  assert.ok(o)
  assert.equal(o.title, "X")
})

test("parseDreamOutcome: a model-invented mood_delta field is ignored (never carried out)", () => {
  const o = parseDreamOutcome(
    '{"title":"T","narrative":"N.","tone":"pleasant","mood_delta":{"valence":99,"arousal":-99},"seeds":[]}',
  )
  assert.ok(o)
  assert.equal("mood_delta" in (o as Record<string, unknown>), false)
  assert.deepEqual(Object.keys(o).sort(), ["narrative", "seeds", "title", "tone"])
})

test("parseDreamOutcome: malformed inputs are null, never throw", () => {
  assert.equal(parseDreamOutcome(""), null)
  assert.equal(parseDreamOutcome("no json here"), null)
  assert.equal(parseDreamOutcome('{"title":"T"}'), null, "missing narrative")
  assert.equal(parseDreamOutcome('{"narrative":"N."}'), null, "missing title")
  assert.equal(parseDreamOutcome('{"title":"T","narrative":"N.","tone":"ecstatic"}'), null, "unknown tone")
  assert.equal(parseDreamOutcome('{"title":"T","narrative":"N.",  "tone":"pleasant"'), null, "truncated")
  assert.equal(parseDreamOutcome("{ broken }"), null)
})

// --- bucket (§17.6) ---------------------------------------------------------

function meta(over: Partial<DreamMeta> = {}): DreamMeta {
  return {
    id: newDreamId(1_000),
    created: "2026-10-15T02:00:00.000Z",
    tone: "pleasant",
    mood_before: { valence: 0.1, arousal: 0.3 },
    mood_after: { valence: 0.25, arousal: 0.25 },
    seeds: ["Agent.md"],
    hash: "",
    ...over,
  }
}

test("formatDreamEntry + parseDreamBucket: round-trip keeps title, meta, narrative", () => {
  const outcome = { title: "Neon Orchard", narrative: "Trees hummed in binary.", tone: "pleasant" as const, seeds: ["Agent.md"] }
  const m = meta({ hash: dreamHash(outcome.narrative) })
  const entry = formatDreamEntry(outcome, m)
  assert.ok(entry.startsWith("### Neon Orchard\n<!-- dream: {"))
  const parsed = parseDreamBucket(entry)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].title, "Neon Orchard")
  assert.equal(parsed[0].narrative.trim(), "Trees hummed in binary.")
  assert.ok(parsed[0].meta, "metadata comment parses")
  assert.equal(parsed[0].meta!.tone, "pleasant")
  assert.equal(parsed[0].meta!.hash, dreamHash("Trees hummed in binary."))
  assert.deepEqual(parsed[0].meta!.seeds, ["Agent.md"])
})

test("parseDreamBucket: two entries, malformed comment kept as meta:null, junk skipped", () => {
  const a = formatDreamEntry({ title: "A", narrative: "aaa", tone: "mundane", seeds: [] }, meta({ hash: "h1" }))
  const b = formatDreamEntry({ title: "B", narrative: "bbb", tone: "anxious", seeds: [] }, meta({ hash: "h2" }))
  const text = `${a}\n${b}\n### Broken\n<!-- dream: not-json -->\nkeep me\n### Empty\n`
  const parsed = parseDreamBucket(text)
  assert.deepEqual(parsed.map((p) => p.title), ["A", "B", "Broken"])
  assert.equal(parsed[2].meta, null)
  assert.ok(parsed[2].narrative.includes("keep me"))
})

test("appendDream: creates the bucket on first use and separates entries", async () => {
  const { mkdtemp } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const vault = await mkdtemp(join(tmpdir(), "dream-bucket-"))
  const e1 = formatDreamEntry({ title: "One", narrative: "first", tone: "pleasant", seeds: [] }, meta())
  const e2 = formatDreamEntry({ title: "Two", narrative: "second", tone: "bizarre", seeds: [] }, meta())
  const file = await appendDream(vault, e1)
  assert.ok(file.endsWith("Kael Dreams.md"))
  await appendDream(vault, e2)
  const text = await readFile(file, "utf8")
  const parsed = parseDreamBucket(text)
  assert.deepEqual(parsed.map((p) => p.title), ["One", "Two"], "append-only, both entries parseable")
})

test("dreamHash: stable 16-hex over the narrative", () => {
  assert.equal(dreamHash("abc"), dreamHash("abc"))
  assert.match(dreamHash("abc"), /^[0-9a-f]{16}$/)
  assert.notEqual(dreamHash("abc"), dreamHash("abd"))
})

// --- §17.7 tone → mood: delta equals the table, never the LLM's numbers ----

test("DREAM_TONE_EVENT: applying each tone yields exactly the tone-table delta", () => {
  // The shipped §17.7 table lives in lib/mood.ts DELTAS (card M); pleasant /
  // bizarre carry the small arousal wobbles the table shipped with. Locking
  // the numbers here ties the dream hook's mapping to that table: if DELTAS
  // ever drifts, this test forces the change to be deliberate — and a
  // model-supplied mood_delta can never reach applyEvent (parser test above).
  const cases: Array<[string, number, number]> = [
    ["pleasant", 0.15, -0.05], // dream_pleasant: valence +0.15
    ["anxious", -0.1, 0.2], // valence −0.1, arousal +0.2
    ["bizarre", 0.05, 0.05], // valence +0.05 (novelty wobble)
    ["mundane", 0, 0], // none
  ]
  assert.deepEqual([...DREAM_TONES].sort(), cases.map(([t]) => t).sort())
  for (const [tone, dv, da] of cases) {
    const event = DREAM_TONE_EVENT[tone as (typeof DREAM_TONES)[number]]
    const before = defaultMoodState("2026-10-15T02:00:00.000Z")
    const after = applyEvent(before, event, "2026-10-15T02:01:00.000Z")
    const baseline = before.baseline
    assert.ok(Math.abs(after.valence - baseline.valence - dv) < 1e-9, `${tone}: valence Δ ${after.valence - baseline.valence} ≠ ${dv}`)
    assert.ok(Math.abs(after.arousal - baseline.arousal - da) < 1e-9, `${tone}: arousal Δ ${after.arousal - baseline.arousal} ≠ ${da}`)
  }
})

// --- fixed prompt + seeds (§17.5) -------------------------------------------

test("buildDreamPrompt: fragments injected; empty seeds degrade to the fixed prompt", () => {
  const withSeeds = buildDreamPrompt({ recent: "recent fragment", random: "note: Agent.md" })
  assert.ok(withSeeds.startsWith(DREAM_FIXED_PROMPT))
  assert.ok(withSeeds.includes("Subconscious fragments:"))
  assert.ok(withSeeds.includes("1. recent fragment"))
  assert.ok(withSeeds.includes("2. note: Agent.md"))
  assert.equal(buildDreamPrompt({ recent: null, random: null }), DREAM_FIXED_PROMPT)
  assert.ok(DREAM_FIXED_PROMPT.includes('"title"'), "the contract asks for the typed outcome")
  assert.ok(DREAM_FIXED_PROMPT.includes("NO tools"), "the dreamer is tool-free")
})

// --- permission matrix (§17.12: dreamer child cannot execute any tool) ------

test("dreamer agent permission matrix: every execution tool is denied in opencode.json", async () => {
  const raw = JSON.parse(await readFile(join(PROJECT_ROOT, "opencode.json"), "utf8"))
  const dreamer = raw?.agent?.dreamer
  assert.ok(dreamer, "agent.dreamer must exist in opencode.json")
  const permission = dreamer.permission as Record<string, string>
  const tools = (dreamer.tools ?? {}) as Record<string, boolean>
  // The plan's named denials (§17.5) + the full native tool surface.
  for (const key of ["read", "write", "edit", "bash", "task", "glob", "grep", "webfetch", "websearch"]) {
    const denied = permission[key] === "deny" || tools[key] === false
    assert.ok(denied, `dreamer must deny "${key}" (permission=${permission[key]}, tools=${tools[key]})`)
  }
  // Belt and suspenders: nothing enabled in the tools map.
  for (const [name, on] of Object.entries(tools)) {
    assert.equal(on, false, `dreamer tools["${name}"] must be false`)
  }
})
