import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_PROFILE,
  DEFAULT_PROFILE_PROMPTS,
  atomicWriteFile,
  buildInjectionBlock,
  buildProfileDecisionRequest,
  buildProfileReviewRequest,
  buildTurnTranscript,
  buildWriterPrompt,
  extractNote,
  hasSubstantiveChange,
  parseProfileConfig,
  parseProfilePrompts,
  parseProfileTargets,
  readProfileConfig,
  readProfilePrompts,
  resolveProfileFile,
  resolveProfilePrompts,
  setFrontmatterDate,
  splitWriterModel,
  summarizePass,
  tickIdleTurn,
  validateNote,
} from "./profile.ts"

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "profile-"))
}

test("parseProfileConfig reads flat scalars and ignores comments/unknown keys", () => {
  const yaml = [
    "profile:",
    "  enabled: true",
    "  agent_file: Agent.md       # under <vault>",
    "  inject: false",
    "  inject_max_bytes: 4096",
    "  review: false",
    "  review_threshold: 0.72",
    "  prompts_file: .opencode/profile-prompts.json",
    "  writer_model: \"example/model\"",
    "  bogus_key: 1",
    "other:",
    "  enabled: false",
  ].join("\n")
  const cfg = parseProfileConfig(yaml)
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.agent_file, "Agent.md")
  assert.equal(cfg.inject, false)
  assert.equal(cfg.inject_max_bytes, 4096)
  assert.equal(cfg.review, false)
  assert.equal(cfg.review_threshold, 0.72)
  assert.equal(cfg.prompts_file, ".opencode/profile-prompts.json")
  assert.equal(cfg.writer_model, "example/model")
  assert.equal((cfg as Record<string, unknown>).bogus_key, undefined)
})

test("readProfileConfig overlays the block on defaults, never throws", async () => {
  const dir = await tmpDir()
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(join(dir, ".opencode/sysop-config.yaml"), "profile:\n  cooldown_turns: 7\n", "utf8")
  const cfg = await readProfileConfig(dir)
  assert.equal(cfg.cooldown_turns, 7)
  assert.equal(cfg.agent_file, DEFAULT_PROFILE.agent_file)

  const missing = await readProfileConfig(join(dir, "nope"))
  assert.deepEqual(missing, DEFAULT_PROFILE)
})

test("readProfileConfig clamps review_threshold and defaults an empty prompts_file", async () => {
  const dir = await tmpDir()
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(
    join(dir, ".opencode/sysop-config.yaml"),
    'profile:\n  review_threshold: 3.5\n  prompts_file: ""\n',
    "utf8",
  )
  const cfg = await readProfileConfig(dir)
  assert.equal(cfg.review_threshold, DEFAULT_PROFILE.review_threshold)
  assert.equal(cfg.prompts_file, DEFAULT_PROFILE.prompts_file)

  await writeFile(join(dir, ".opencode/sysop-config.yaml"), "profile:\n  review_threshold: -1\n", "utf8")
  assert.equal((await readProfileConfig(dir)).review_threshold, DEFAULT_PROFILE.review_threshold)

  await writeFile(join(dir, ".opencode/sysop-config.yaml"), "profile:\n  review_threshold: 0.25\n", "utf8")
  assert.equal((await readProfileConfig(dir)).review_threshold, 0.25)
})

test("resolveProfilePrompts honors absolute, ~, and project-relative leaves", () => {
  assert.equal(resolveProfilePrompts("/proj", ".opencode/p.json"), "/proj/.opencode/p.json")
  assert.equal(resolveProfilePrompts("/proj", "/abs/p.json"), "/abs/p.json")
  assert.equal(resolveProfilePrompts("/proj", "~/p.json"), join(homedir(), "p.json"))
})

test("parseProfilePrompts accepts a complete file and rejects malformed/missing keys", () => {
  const ok = parseProfilePrompts({
    choice: {
      instructions: "q",
      criteria: { none: "n", agent: "k", user: "u", both: "b" },
    },
    review: { assertion: "a" },
  })
  assert.ok(ok)
  assert.equal(ok?.choice.instructions, "q")
  assert.deepEqual(Object.keys(ok?.choice.criteria ?? {}), ["none", "agent", "user", "both"])
  assert.equal(ok?.review.assertion, "a")

  assert.equal(parseProfilePrompts(null), null)
  assert.equal(parseProfilePrompts("nope"), null)
  assert.equal(parseProfilePrompts({}), null)
  assert.equal(parseProfilePrompts({ choice: { instructions: "q", criteria: {} }, review: { assertion: "a" } }), null)
  assert.equal(
    parseProfilePrompts({
      choice: { instructions: "q", criteria: { none: "n", agent: "k", user: "u" } },
      review: { assertion: "a" },
    }),
    null,
  )
  assert.equal(
    parseProfilePrompts({
      choice: { instructions: "q", criteria: { none: "n", agent: "k", user: "u", both: "b", extra: "x" } },
      review: { assertion: "a" },
    }),
    null,
  )
  assert.equal(
    parseProfilePrompts({
      choice: { instructions: "", criteria: { none: "n", agent: "k", user: "u", both: "b" } },
      review: { assertion: "a" },
    }),
    null,
  )
  assert.equal(
    parseProfilePrompts({
      choice: { instructions: "q", criteria: { none: "n", agent: "k", user: "u", both: "b" } },
      review: { assertion: "  " },
    }),
    null,
  )
})

test("readProfilePrompts never throws and returns null for missing/invalid files", async () => {
  const dir = await tmpDir()
  assert.equal(await readProfilePrompts(join(dir, "nope.json")), null)
  const bad = join(dir, "bad.json")
  await writeFile(bad, "{ not json", "utf8")
  assert.equal(await readProfilePrompts(bad), null)

  const good = join(dir, "good.json")
  await writeFile(good, JSON.stringify(DEFAULT_PROFILE_PROMPTS), "utf8")
  assert.deepEqual(await readProfilePrompts(good), DEFAULT_PROFILE_PROMPTS)
})

test("resolveProfileFile joins relative leaves and passes absolute ones through", () => {
  assert.equal(resolveProfileFile("/vault", "Agent.md"), "/vault/Agent.md")
  assert.equal(resolveProfileFile("/vault", "/abs/Agent.md"), "/abs/Agent.md")
})

test("tickIdleTurn arms only at the cooldown threshold and counts every turn", () => {
  let turns = 0
  const ticks = [1, 2, 3, 4].map(() => {
    const t = tickIdleTurn(turns, 3)
    turns = t.idleTurns
    return t.ready
  })
  assert.deepEqual(ticks, [false, false, true, true])
  assert.equal(turns, 4)
  assert.equal(tickIdleTurn(0, 1).ready, true)
})

test("buildTurnTranscript joins turns oldest-first and caps at maxBytes", () => {
  const turns = [
    { user: "u1", assistant: "a1" },
    { user: "u2", assistant: "a2" },
  ]
  const out = buildTurnTranscript(turns, 1000)
  assert.ok(out.indexOf("u1") < out.indexOf("u2"))
  assert.ok(out.includes("User:\nu1\n\nAssistant:\na1"))
  assert.ok(out.includes("User:\nu2\n\nAssistant:\na2"))
  assert.equal(buildTurnTranscript(turns, 5), out.slice(0, 5))
  assert.equal(buildTurnTranscript([], 100), "")
})

test("buildInjectionBlock frames both notes and caps each", () => {
  const block = buildInjectionBlock("K".repeat(50), "U".repeat(50), 10)
  assert.ok(block.includes("## Agent (persona & behavior)"))
  assert.ok(block.includes("## User (user context)"))
  assert.ok(block.includes("K".repeat(10)))
  assert.ok(!block.includes("K".repeat(11)))
  assert.equal(buildInjectionBlock("", "", 10), "")
})

test("buildInjectionBlock strips frontmatter, Related, and the end marker", () => {
  const note = [
    "---",
    "title: Agent",
    "updated: 2026-09-27",
    "---",
    "",
    "# Agent — Operating Instructions",
    "",
    "## Voice",
    "- Answer first.",
    "",
    "## Related",
    "- [[A]] — link a",
    "- [[B]] — link b",
    "",
    "<<<END_PROFILE_NOTE",
  ].join("\n")
  const block = buildInjectionBlock(note, "", 4000)
  assert.ok(block.includes("## Voice"))
  assert.ok(block.includes("- Answer first."))
  assert.ok(!block.includes("title: Agent"))
  assert.ok(!block.includes("## Related"))
  assert.ok(!block.includes("[[A]]"))
  assert.ok(!block.includes("<<<END_PROFILE_NOTE"))
})

test("buildInjectionBlock keeps a mid-file Related block's later sections", () => {
  const note = "# N\n\n## Related\n- [[A]]\n\n## Behavior\n- Rule.\n"
  const block = buildInjectionBlock(note, "", 4000)
  assert.ok(!block.includes("[[A]]"))
  assert.ok(block.includes("## Behavior"))
  assert.ok(block.includes("- Rule."))
})

test("buildProfileDecisionRequest is a choice over the two notes", () => {
  const req = buildProfileDecisionRequest("hello")
  assert.equal(req.kind, "choice")
  assert.deepEqual(req.candidates, ["none", "agent", "user", "both"])
  assert.equal(req.state, "hello")
  assert.equal(req.allow_abstain, true)
  assert.equal(req.instructions, DEFAULT_PROFILE_PROMPTS.choice.instructions)
})

test("buildProfileDecisionRequest derives candidates and criteria from the prompts", () => {
  const prompts = {
    choice: {
      instructions: "custom question",
      criteria: { none: "N", agent: "K", user: "U", both: "B" },
    },
    review: { assertion: "custom assertion" },
  }
  const req = buildProfileDecisionRequest("state", prompts)
  assert.deepEqual(req.candidates, ["none", "agent", "user", "both"])
  assert.equal(req.instructions, "custom question")
  assert.equal(req.criteria, "none: N; agent: K; user: U; both: B")
})

test("buildProfileReviewRequest is a non-abstaining noul over current + draft + excerpt", () => {
  const req = buildProfileReviewRequest("Agent.md", "CURRENT", "DRAFT", "EXCERPT")
  assert.equal(req.kind, "noul")
  assert.equal(req.allow_abstain, false)
  assert.equal(req.assertion, DEFAULT_PROFILE_PROMPTS.review.assertion)
  assert.ok(req.state.includes("=== CURRENT NOTE (Agent.md) ==="))
  assert.ok(req.state.includes("CURRENT"))
  assert.ok(req.state.includes("=== PROPOSED NOTE (Agent.md) ==="))
  assert.ok(req.state.includes("DRAFT"))
  assert.ok(req.state.includes("=== SESSION EXCERPT ==="))
  assert.ok(req.state.includes("EXCERPT"))
})

test("hasSubstantiveChange ignores the updated frontmatter line", () => {
  const base = "---\ntitle: X\nupdated: 2020-01-01\n---\nbody\n"
  assert.equal(hasSubstantiveChange(base, base), false)
  assert.equal(
    hasSubstantiveChange(base, base.replace("2020-01-01", "2026-09-25")),
    false,
  )
  assert.equal(hasSubstantiveChange(base, base.replace("body", "body\nnew fact")), true)
  assert.equal(hasSubstantiveChange("no fm\n", "no fm\nmore\n"), true)
  assert.equal(hasSubstantiveChange("---\ntitle: X\n---\nbody\n", "---\ntitle: X\nupdated: 2026-09-25\n---\nbody\n"), false)
})

test("parseProfileTargets maps verdicts to targets", () => {
  assert.deepEqual(parseProfileTargets("both"), ["agent", "user"])
  assert.deepEqual(parseProfileTargets("agent"), ["agent"])
  assert.deepEqual(parseProfileTargets("user"), ["user"])
  assert.deepEqual(parseProfileTargets("Agent.md"), [])
  assert.deepEqual(parseProfileTargets("User.md"), [])
  assert.deepEqual(parseProfileTargets("none"), [])
  assert.deepEqual(parseProfileTargets("nonsense"), [])
  assert.deepEqual(parseProfileTargets(null), [])
})

test("summarizePass emits the terminal line and omits undefined optionals", () => {
  const line = summarizePass({
    pass: "p42",
    session: "ses_x",
    result: "updated",
    idleTurns: 3,
    cooldownTurns: 3,
    durationMs: 2100,
    verdict: "both",
    confidence: 0.9,
    fallback: false,
    fallbackReason: "none",
    targets: ["agent", "user"],
    updated: ["agent", "user"],
    transcriptTurns: 3,
    transcriptBytes: 1842,
  })
  assert.equal(line.event, "profile-pass")
  assert.equal(line.pass, "p42")
  assert.equal(line.result, "updated")
  assert.equal(line.fallback, false)
  assert.deepEqual(line.updated, ["agent", "user"])
  assert.equal(line.transcriptBytes, 1842)

  const withNoop = summarizePass({
    pass: "p44",
    session: "ses_z",
    result: "no-op",
    idleTurns: 3,
    cooldownTurns: 3,
    durationMs: 1,
    targets: ["agent"],
    updated: [],
    failed: [],
    noop: ["agent"],
  })
  assert.equal(withNoop.result, "no-op")
  assert.deepEqual(withNoop.noop, ["agent"])

  const minimal = summarizePass({
    pass: "p43",
    session: "ses_y",
    result: "no-update",
    idleTurns: 3,
    cooldownTurns: 3,
    durationMs: 5,
  })
  assert.equal("verdict" in minimal, false)
  assert.equal("updated" in minimal, false)
  assert.equal("fallback" in minimal, false)
  assert.equal("fallbackReason" in minimal, false)
})

test("summarizePass covers the fail-open and skip results", () => {
  const results = [
    "prefilter-skip",
    "no-transcript",
    "decision-fallback",
    "decision-abstain",
    "update-failed",
    "no-op",
  ] as const
  for (const result of results) {
    const line = summarizePass({ pass: "p1", session: "s", result, idleTurns: 3, cooldownTurns: 3, durationMs: 0 })
    assert.equal(line.result, result)
    assert.equal(line.event, "profile-pass")
  }
})

test("extractNote requires the exact markers", () => {
  const reply = "noise\n<<<PROFILE_NOTE\n---\ntitle: X\n---\nbody\n>>>\ntrailing"
  assert.equal(extractNote(reply), "---\ntitle: X\n---\nbody\n")
  assert.equal(extractNote("just a note without markers"), null)
})

test("validateNote enforces frontmatter, size, marker, and link well-formedness", () => {
  const current = "---\ntitle: X\n---\nSee [[A]] and [[B]].\n"
  assert.equal(validateNote(current, current + "more\n", 10000), true)
  assert.equal(validateNote(current, "no frontmatter\n[[A]] [[B]]\n", 10000), false)
  assert.equal(validateNote(current, current.replace("[[B]]", "B"), 10000), true)
  assert.equal(validateNote(current, current, 5), false)
  assert.equal(validateNote(current, "<<<PROFILE_NOTE\n", 10000), false)
  assert.equal(validateNote(current, "---\ntitle: X\n---\nbroken [[link\n", 10000), false)
  assert.equal(validateNote(current, "---\ntitle: X\n---\nempty [[]] link\n", 10000), false)
})

test("setFrontmatterDate replaces or inserts updated", () => {
  const withDate = "---\ntitle: X\nupdated: 2020-01-01\n---\nbody\n"
  assert.equal(
    setFrontmatterDate(withDate, "2026-09-24"),
    "---\ntitle: X\nupdated: 2026-09-24\n---\nbody\n",
  )
  const withoutDate = "---\ntitle: X\n---\nbody\n"
  assert.equal(
    setFrontmatterDate(withoutDate, "2026-09-24"),
    "---\ntitle: X\nupdated: 2026-09-24\n---\nbody\n",
  )
  assert.equal(setFrontmatterDate("no frontmatter\n", "2026-09-24"), "no frontmatter\n")
})

test("splitWriterModel parses provider/model and rejects malformed specs", () => {
  assert.deepEqual(splitWriterModel("example/model"), {
    providerID: "example",
    modelID: "model",
  })
  assert.equal(splitWriterModel(""), null)
  assert.equal(splitWriterModel("nope"), null)
  assert.equal(splitWriterModel("/x"), null)
  assert.equal(splitWriterModel("x/"), null)
})

test("buildWriterPrompt embeds the note and excerpt between markers", () => {
  const prompt = buildWriterPrompt("Agent.md", "CURRENT", "EXCERPT", "2026-09-24")
  assert.ok(prompt.includes("=== FILE: Agent.md ==="))
  assert.ok(prompt.includes("CURRENT"))
  assert.ok(prompt.includes("EXCERPT"))
  assert.ok(prompt.includes("<<<PROFILE_NOTE"))
})

test("buildWriterPrompt tells the writer to mirror the note's structure and register", () => {
  const prompt = buildWriterPrompt("Agent.md", "CURRENT", "EXCERPT", "2026-09-24")
  assert.ok(prompt.includes("read the current note"))
  assert.ok(prompt.includes("register"))
  assert.ok(prompt.includes("authoritative"))
  assert.ok(prompt.includes("descriptive"))
})

test("buildWriterPrompt carries the evolution mandate and hard budget", () => {
  const prompt = buildWriterPrompt("User.md", "CURRENT", "EXCERPT", "2026-09-24", 6000)
  assert.ok(prompt.includes("OWN this note"))
  assert.ok(prompt.includes("compact"))
  assert.ok(prompt.includes("prune"))
  assert.ok(prompt.includes("HARD BUDGET"))
  assert.ok(prompt.includes("6000 bytes"))
  assert.ok(prompt.includes("Never silently lose a durable fact"))
  assert.ok(prompt.includes("Out of scope"))
  assert.ok(!prompt.includes("Preserve ALL existing content"))
})

test("buildWriterPrompt defaults the budget to 6000 bytes", () => {
  const prompt = buildWriterPrompt("Agent.md", "CURRENT", "EXCERPT", "2026-09-24")
  assert.ok(prompt.includes("6000 bytes"))
})

test("atomicWriteFile replaces the target atomically", async () => {
  const dir = await tmpDir()
  const file = join(dir, "note.md")
  await atomicWriteFile(file, "one")
  await atomicWriteFile(file, "two")
  assert.equal(await readFile(file, "utf8"), "two")
})
