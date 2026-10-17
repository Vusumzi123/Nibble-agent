import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  DEFAULT_MISSION,
  MISSIONS_DIR,
  applyMissionOverlay,
  expandMenus,
  loadMissions,
  parseMissionFile,
  type Mission,
} from "./missions.ts"
import { clearRejectWarnCache } from "./autonomy.ts"

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "missions-"))
}

async function missionsDir(files: Record<string, string>): Promise<string> {
  const dir = await tmpDir()
  const mdir = join(dir, MISSIONS_DIR)
  await mkdir(mdir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(mdir, name), content, "utf8")
  }
  return dir
}

const FULL_FM = [
  "---",
  "id: staleness",
  "title: Refresh stale notes",
  "frequency: mid",
  "menus: [day]",
  "min_level: 3",
  "approval: per-item",
  "candidacy: min-gap:last_refresh",
  'agent: "profile-writer"',
  "enabled: false",
  "---",
  "",
  "Do the thing.",
  "",
].join("\n")

// ---------------------------------------------------------------------------
// Parser

test("parseMissionFile parses a full frontmatter mission", () => {
  const { mission, issues } = parseMissionFile(FULL_FM, "fallback")
  assert.deepEqual(issues, [])
  assert.deepEqual(mission, {
    id: "staleness",
    title: "Refresh stale notes",
    frequency: "mid",
    menus: ["day"],
    min_level: 3,
    approval: "per-item",
    candidacy: "min-gap:last_refresh",
    agent: "profile-writer",
    runner: "",
    enabled: false,
    body: "Do the thing.",
  })
})

test("parseMissionFile reads the runner key", () => {
  const { mission, issues } = parseMissionFile(
    "---\nid: drain\nrunner: drain-pipe\n---\nBody.\n",
    "fallback",
  )
  assert.deepEqual(issues, [])
  assert.equal(mission.runner, "drain-pipe")
})

test("parseMissionFile falls back to safe defaults for missing keys", () => {
  const { mission, issues } = parseMissionFile("---\nid: drain\n---\nBody here.\n", "fallback")
  assert.deepEqual(issues, [])
  assert.equal(mission.id, "drain")
  assert.equal(mission.title, "drain") // title falls back to id
  assert.equal(mission.frequency, DEFAULT_MISSION.frequency)
  assert.deepEqual(mission.menus, DEFAULT_MISSION.menus)
  assert.equal(mission.min_level, DEFAULT_MISSION.min_level)
  assert.equal(mission.approval, DEFAULT_MISSION.approval)
  assert.equal(mission.candidacy, DEFAULT_MISSION.candidacy)
  assert.equal(mission.agent, DEFAULT_MISSION.agent)
  assert.equal(mission.runner, DEFAULT_MISSION.runner)
  assert.equal(mission.enabled, true)
  assert.equal(mission.body, "Body here.")
})

test("parseMissionFile without frontmatter uses the filename id and keeps the body", () => {
  const { mission, issues } = parseMissionFile("Just prose, no frontmatter.\n", "my-mission")
  assert.deepEqual(issues, [])
  assert.equal(mission.id, "my-mission")
  assert.equal(mission.title, "my-mission")
  assert.equal(mission.enabled, true)
  assert.equal(mission.body, "Just prose, no frontmatter.")
})

test("parseMissionFile accepts `agent: \"\"` (the spec default) without an issue", () => {
  const { mission, issues } = parseMissionFile("---\nid: x\nagent: \"\"\n---\nb\n", "x")
  assert.deepEqual(issues, [])
  assert.equal(mission.agent, "")
})

test("parseMissionFile reports unknown keys once and keeps valid fields", () => {
  const content = ["---", "id: x", "tools: [rag-brain]", "frequency: high", "---", "b"].join("\n")
  const { mission, issues } = parseMissionFile(content, "x")
  assert.deepEqual(issues, [{ key: "tools", reason: "unknown key" }])
  assert.equal(mission.frequency, "high") // valid key still parsed
  assert.equal(mission.id, "x")
})

test("parseMissionFile falls back on invalid values and reports each", () => {
  const content = [
    "---",
    "id: x",
    "frequency: sometimes",
    "min_level: 9",
    "menus: [weekend]",
    "approval: yolo",
    "candidacy: whenever",
    "enabled: maybe",
    "---",
    "b",
  ].join("\n")
  const { mission, issues } = parseMissionFile(content, "x")
  assert.deepEqual(
    issues.map((i) => i.key).sort(),
    ["approval", "candidacy", "enabled", "frequency", "menus", "min_level"],
  )
  assert.equal(mission.frequency, DEFAULT_MISSION.frequency)
  assert.equal(mission.min_level, DEFAULT_MISSION.min_level)
  assert.deepEqual(mission.menus, DEFAULT_MISSION.menus)
  assert.equal(mission.approval, DEFAULT_MISSION.approval)
  assert.equal(mission.candidacy, DEFAULT_MISSION.candidacy)
  assert.equal(mission.enabled, true)
})

test("parseMissionFile never throws on garbage input", () => {
  for (const junk of ["", "---", "---\n", "---\nbroken: [unclosed\n---\n", "\u0000\u0001", "---\n id: 42\n---"]) {
    const { mission } = parseMissionFile(junk, "junk")
    assert.equal(typeof mission.id, "string")
    assert.ok(mission.min_level >= 0 && mission.min_level <= 4)
  }
})

test("expandMenus expands `both` and passes windows through", () => {
  assert.deepEqual(expandMenus(["both"]), ["day", "night"])
  assert.deepEqual(expandMenus(["night"]), ["night"])
  assert.deepEqual(expandMenus(["night", "day"]), ["night", "day"])
  assert.deepEqual(expandMenus(["both", "day"]), ["day", "night"])
  assert.deepEqual(expandMenus([]), [])
})

// ---------------------------------------------------------------------------
// Overlay — restrict-only matrix (missions-plan §6 / D-M5)

function base(): Mission {
  const { mission } = parseMissionFile(FULL_FM, "fallback")
  return mission // enabled: false, min_level: 3, frequency: mid, menus: [day]
}

function applied(overlay: Parameters<typeof applyMissionOverlay>[1]): { m: Mission; rejects: string[] } {
  const rejects: Array<{ path: string; raw: string; reason: string }> = []
  const m = applyMissionOverlay(base(), overlay, rejects)
  return { m, rejects: rejects.map((r) => `${r.path}: ${r.reason}`) }
}

test("overlay: disable is always honoured", () => {
  const { m, rejects } = applied({ enabled: false })
  assert.equal(m.enabled, false)
  assert.deepEqual(rejects, [])
})

test("overlay: enabled true cannot re-enable a file-disabled mission", () => {
  const { m, rejects } = applied({ enabled: true })
  assert.equal(m.enabled, false) // file stands
  assert.equal(rejects.length, 1)
  assert.match(rejects[0], /missions\.staleness\.enabled/)
})

test("overlay: min_level raise is honoured; lower is rejected, file stands", () => {
  const raise = applied({ min_level: 4 })
  assert.equal(raise.m.min_level, 4)
  assert.deepEqual(raise.rejects, [])

  const lower = applied({ min_level: 1 })
  assert.equal(lower.m.min_level, 3) // file stands
  assert.equal(lower.rejects.length, 1)
  assert.match(lower.rejects[0], /min_level may only be raised/)
})

test("overlay: frequency toward low is honoured; higher is rejected", () => {
  const rarer = applied({ frequency: "low" })
  assert.equal(rarer.m.frequency, "low")
  assert.deepEqual(rarer.rejects, [])

  const commoner = applied({ frequency: "high" })
  assert.equal(commoner.m.frequency, "mid") // file stands
  assert.equal(commoner.rejects.length, 1)
  assert.match(commoner.rejects[0], /frequency may only move toward low/)
})

test("overlay: menus narrowing is honoured; widening is rejected", () => {
  const wideFile = applyMissionOverlay(
    { ...base(), menus: ["day", "night"] },
    { menus: ["night"] },
    [],
  )
  assert.deepEqual(wideFile.menus, ["night"])

  const widen = applied({ menus: ["night"] }) // file is [day] only
  assert.deepEqual(widen.m.menus, ["day"]) // file stands
  assert.equal(widen.rejects.length, 1)
  assert.match(widen.rejects[0], /menus may only be narrowed/)

  const both = applied({ menus: ["both"] }) // both = day+night > file [day]
  assert.deepEqual(both.m.menus, ["day"])
  assert.equal(both.rejects.length, 1)
})

test("overlay: no overlay entry leaves the mission untouched", () => {
  const { m, rejects } = applied(undefined)
  assert.deepEqual(m, base())
  assert.deepEqual(rejects, [])
})

// ---------------------------------------------------------------------------
// Loader

test("loadMissions reads a missions dir, sorted by filename", async () => {
  const dir = await missionsDir({
    "zebra.md": "---\nid: zebra\n---\nz",
    "alpha.md": "---\nid: alpha\n---\na",
    "notes.txt": "not a mission",
  })
  const missions = await loadMissions(dir, { onReject: () => assert.fail("unexpected reject") })
  assert.deepEqual(
    missions.map((m) => m.id),
    ["alpha", "zebra"],
  )
})

test("loadMissions yields [] for a missing directory (never throws)", async () => {
  const dir = join(await tmpDir(), "nope")
  assert.deepEqual(await loadMissions(dir), [])
})

test("loadMissions applies the config overlay restrict-only", async () => {
  const dir = await missionsDir({
    "staleness.md": FULL_FM, // enabled: false, min_level: 3, frequency: mid, menus: [day]
  })
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(
    join(dir, ".opencode", "sysop-config.yaml"),
    [
      "autonomy:",
      "  missions:",
      "    staleness:",
      "      enabled: false",
      "      min_level: 4",
      "      frequency: low",
      "      menus: [day, night]", // widen attempt — must be rejected
      "",
    ].join("\n"),
    "utf8",
  )
  const rejects: string[] = []
  const missions = await loadMissions(dir, { onReject: (e) => rejects.push(`${e.section} ${e.path}`) })
  assert.equal(missions.length, 1)
  const m = missions[0]
  assert.equal(m.enabled, false)
  assert.equal(m.min_level, 4) // raise honoured
  assert.equal(m.frequency, "low") // rarer honoured
  assert.deepEqual(m.menus, ["day"]) // widen rejected, file stands
  assert.ok(rejects.some((r) => r.includes("missions.staleness.menus")), `menu widen reject in ${rejects}`)
})

test("loadMissions reports duplicate ids and skips the later file", async () => {
  const dir = await missionsDir({
    "a.md": "---\nid: same\n---\nfirst",
    "b.md": "---\nid: same\n---\nsecond",
  })
  const issues: string[] = []
  const missions = await loadMissions(dir, { onReject: (e) => issues.push(`${e.path}: ${e.reason}`) })
  assert.equal(missions.length, 1)
  assert.equal(missions[0].body, "first")
  assert.ok(issues.some((i) => i.includes("duplicate")), `duplicate issue in ${issues}`)
})

test("loadMissions with no config overlay leaves missions untouched", async () => {
  const dir = await missionsDir({ "drain.md": "---\nid: drain\n---\nb" })
  const missions = await loadMissions(dir, { onReject: () => assert.fail("unexpected reject") })
  assert.equal(missions[0].enabled, true)
})

// ---------------------------------------------------------------------------
// Shipped built-ins (the real .opencode/missions/ in this repo)

test("shipped built-ins parse clean: drain/dream/staleness/research/notify/idea-generate/express", async () => {
  const missions = await loadMissions(PROJECT_ROOT, {
    onReject: (e) => assert.fail(`unexpected reject: ${e.path} ${e.reason}`),
  })
  const byId = new Map(missions.map((m) => [m.id, m]))
  assert.deepEqual(
    [...byId.keys()].sort(),
    ["drain", "dream", "express", "idea-generate", "notify", "research", "staleness"],
  )

  const drain = byId.get("drain")!
  assert.equal(drain.enabled, true)
  assert.deepEqual(drain.menus, ["day", "night"]) // §5: drain is a night-capable built-in
  assert.equal(drain.frequency, "high")
  // §17.3 night pre-gate: drain is offered iff unconsumed turns exist.
  assert.equal(drain.candidacy, "turns-pending")

  // Card G: dream is night-menu only, roll/cap-gated, runs tool-free.
  const dream = byId.get("dream")!
  assert.equal(dream.enabled, true)
  assert.deepEqual(dream.menus, ["night"])
  assert.equal(dream.candidacy, "dream-gate")
  assert.equal(dream.agent, "dreamer")
  assert.equal(dream.min_level, 1) // §6.3: dream is L1, night menu only
  assert.ok(dream.body.length > 0)

  const notify = byId.get("notify")!
  assert.equal(notify.enabled, false) // comms = card 10

  // Card 7a: the §17.10 idea pair.
  const gen = byId.get("idea-generate")!
  assert.equal(gen.enabled, true)
  assert.deepEqual(gen.menus, ["day"]) // day-only — never in the night menu
  assert.equal(gen.candidacy, "idea-roll") // day-rollover budget gate
  assert.equal(gen.agent, "idea-generator")
  assert.equal(gen.min_level, 1) // §6.3: L1
  assert.ok(gen.body.length > 0)

  const express = byId.get("express")!
  assert.equal(express.enabled, false) // comms = card 10 (the notify precedent)
  assert.deepEqual(express.menus, ["day"])
  assert.equal(express.candidacy, "min-gap:express") // §17.10 deterministic gate
  assert.equal(express.min_level, 1)
  assert.ok(express.body.length > 0)

  for (const id of ["staleness", "research"]) {
    const m = byId.get(id)!
    assert.equal(m.enabled, true)
    assert.deepEqual(m.menus, ["day"], `${id} day-only`)
    assert.ok(m.body.length > 0, `${id} has a body`)
  }

  // Security prereq: built-ins must NOT be reachable without approval — the
  // gate treats their paths as self-improve (checked in autonomy-gate.test.ts).
  clearRejectWarnCache()
})
