// Mission loader (docs/heartbeat-missions-plan.md §2, §3, §6 — kanban card A).
// One mission = one markdown file in `.opencode/missions/<id>.md`: YAML
// frontmatter carries the gating metadata, the body is the workflow prose the
// heartbeat brief injects (D-M1). Built-ins ship as ordinary files beside user
// missions — zero hardcoded missions, zero npm dependencies (D-M2).
//
// Contract:
//   - Never throws: a missing directory yields [], an unreadable file is
//     skipped, a missing/invalid frontmatter key falls back to a safe default
//     and warns once (same reject pipeline as lib/autonomy.ts —
//     <log>/autonomy-config.log, once per process per path).
//   - Frontmatter parsing reuses parseFlatBlock/extractBlock from lib/config.ts
//     (the frontmatter body is wrapped under a synthetic `fm:` section).
//   - The config overlay `autonomy.missions.<id>.*` (parsed by
//     lib/autonomy.ts readMissionOverlay) is RESTRICT-ONLY (D-M5): config may
//     disable a mission, raise min_level, move frequency toward low, or narrow
//     menus — never widen any of them. Widen attempts are rejected, logged
//     once, and the file value stands.
//   - `.opencode/missions/**` writes classify as `self-improve` at the
//     autonomy gate (isSelfImprovePath) — the agent cannot install its own
//     autonomous missions without approval (missions-plan §8).
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.
import { readFile, readdir } from "node:fs/promises"
import { basename, join } from "node:path"
import { parseFlatBlock, parseInlineList, stripPairQuotes } from "./config.ts"
import {
  MISSION_FREQUENCIES,
  MISSION_MENU_WINDOWS,
  readMissionOverlay,
  reportRejects,
  type MissionFrequency,
  type MissionOverlay,
  type RejectEvent,
} from "./autonomy.ts"

/** Where mission files live, relative to the project root. */
export const MISSIONS_DIR = ".opencode/missions"

export type MissionApproval = "n/a" | "per-item" | "writes-follow-dial" | "always"
export const MISSION_APPROVALS = ["n/a", "per-item", "writes-follow-dial", "always"] as const

/** What the orchestrator does after a mission reports `declined`. */
export type MissionDeclinePolicy = "reroll" | "stop"
export const MISSION_DECLINE_POLICIES = ["reroll", "stop"] as const

/** Dispatch lane (docs/heartbeat-lanes.md): `primary` missions are chosen by
 *  the JEV digest one per tick; `side` missions ride the status-fed lane
 *  queue (strict FIFO, one per tick, never JEV-picked). */
export type MissionLane = "primary" | "side"
export const MISSION_LANES = ["primary", "side"] as const

/** D-M8 named candidacy predicates (cards 6/G added `turns-pending` and
 *  `dream-gate` for the night pre-gate, plan §17.3; card 7a added `idea-roll`
 *  for the day-rollover draw, §17.10). */
export type MissionCandidacy =
  | "digest"
  | "always"
  | "backlog-pending"
  | "turns-pending"
  | "brain-stale"
  | `brain-stale:${string}`
  | "dream-gate"
  | "idea-roll"
  | `min-gap:${string}`
  | `roll:${string}`
const CANDIDACY_BASE = new Set(["digest", "always", "backlog-pending", "turns-pending", "brain-stale", "dream-gate", "idea-roll"])

export type Mission = {
  id: string
  title: string
  /** Digest WEIGHT, not a gate (D-M3). */
  frequency: MissionFrequency
  /** Effective windows after expanding `both`; subset of ["day", "night"]. */
  menus: string[]
  /** Lowest autonomy.level that may run this mission. */
  min_level: number
  approval: MissionApproval
  candidacy: MissionCandidacy
  /** opencode agent name; "" = the heartbeat agent (D-M7). */
  agent: string
  /** Tool binding name (metadata); the body names the tool to call. */
  runner: string
  /** Same-tick reroll policy after mission_result says declined. */
  onDecline: MissionDeclinePolicy
  enabled: boolean
  /** Dispatch lane: `primary` (JEV-picked) or `side` (status queue). */
  lane: MissionLane
  /** Workflow prose after the frontmatter — the mission brief body. */
  body: string
}

// Safe defaults for missing/invalid keys (missions-plan §2). `enabled` flips
// to false only via an explicit `enabled: false` or a config overlay disable;
// `menus` defaults to the day window so a half-written mission never slips
// into the quiet hours.
export const DEFAULT_MISSION: Omit<Mission, "id" | "title" | "body"> = {
  frequency: "mid",
  menus: ["day"],
  min_level: 2,
  approval: "writes-follow-dial",
  candidacy: "digest",
  agent: "",
  runner: "",
  onDecline: "stop",
  enabled: true,
  lane: "primary",
}

const FREQUENCY_RANK: Record<string, number> = { high: 2, mid: 1, low: 0 }

// ---------------------------------------------------------------------------
// Frontmatter parsing (pure, never throws)

export type MissionParseIssue = { key: string; reason: string }

/** Expand menu window tokens: `both` -> [day, night]; anything else passes
 *  through. Result is deduped, order: day then night. */
export function expandMenus(menus: string[]): string[] {
  const out: string[] = []
  for (const m of menus) {
    if (m === "both") {
      if (!out.includes("day")) out.push("day")
      if (!out.includes("night")) out.push("night")
    } else if ((MISSION_MENU_WINDOWS as readonly string[]).includes(m) && !out.includes(m)) {
      out.push(m)
    }
  }
  return out
}

function coerceMissionField(key: string, raw: string): unknown | undefined {
  switch (key) {
    case "id":
    case "title": {
      const v = stripPairQuotes(raw)
      return v === "" ? undefined : v
    }
    case "agent":
      // `agent: ""` is the spec's explicit default (empty = heartbeat agent).
      return stripPairQuotes(raw)
    case "runner":
      // `runner: ""` is the explicit default (no tool binding).
      return stripPairQuotes(raw)
    case "on_decline": {
      const v = stripPairQuotes(raw)
      return (MISSION_DECLINE_POLICIES as readonly string[]).includes(v) ? v : undefined
    }
    case "frequency": {
      const v = stripPairQuotes(raw)
      return (MISSION_FREQUENCIES as readonly string[]).includes(v) ? v : undefined
    }
    case "menus": {
      const list = parseInlineList(raw)
      if (list === undefined) return undefined
      // Every member must be a known window; a mixed-valid list is a typo,
      // not a narrowing — reject the whole value, default stands.
      if (!list.every((m) => (MISSION_MENU_WINDOWS as readonly string[]).includes(m))) return undefined
      return expandMenus(list)
    }
    case "min_level": {
      const v = stripPairQuotes(raw)
      if (!/^\d+$/.test(v)) return undefined
      const n = parseInt(v, 10)
      return n >= 0 && n <= 4 ? n : undefined
    }
    case "approval": {
      const v = stripPairQuotes(raw)
      return (MISSION_APPROVALS as readonly string[]).includes(v) ? v : undefined
    }
    case "candidacy": {
      const v = stripPairQuotes(raw)
      if (CANDIDACY_BASE.has(v)) return v
      if (/^brain-stale:\d+(?:\.\d+)?$/.test(v)) return v
      if (/^min-gap:\S+$/.test(v)) return v
      if (/^roll:\d+(?:\.\d+)?$/.test(v)) return v
      return undefined
    }
    case "enabled": {
      const v = stripPairQuotes(raw)
      if (v === "true") return true
      if (v === "false") return false
      return undefined
    }
    case "lane": {
      const v = stripPairQuotes(raw)
      return (MISSION_LANES as readonly string[]).includes(v) ? v : undefined
    }
    default:
      return undefined
  }
}

const MISSION_KEYS = new Set([
  "id",
  "title",
  "frequency",
  "menus",
  "min_level",
  "approval",
  "candidacy",
  "agent",
  "runner",
  "on_decline",
  "enabled",
  "lane",
])

/**
 * Parse one mission file's frontmatter + body. Pure + total: any input
 * (garbage, missing frontmatter, invalid values) yields a Mission with safe
 * defaults plus an issue list for warn-once reporting; never throws.
 *
 * `fallbackId` is the filename stem, used when frontmatter omits/invalidates
 * `id`.
 */
export function parseMissionFile(
  content: string,
  fallbackId: string,
): { mission: Mission; issues: MissionParseIssue[] } {
  const issues: MissionParseIssue[] = []
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/)
  const fmBody = fm?.[1] ?? ""
  const body = fm ? content.slice(fm[0].length) : content

  // parseFlatBlock expects a `section:` header with an indented body — wrap
  // the flat frontmatter under a synthetic `fm:` section to reuse it. Every
  // line gets indented (blank ones too) so extractBlock's body regex doesn't
  // stop early on a blank line inside the frontmatter.
  const wrapped = "fm:\n" + fmBody.split("\n").map((l) => "  " + l).join("\n") + "\n"
  const parsed = parseFlatBlock(wrapped, "fm", {
    knownKeys: MISSION_KEYS,
    coerce: (key, raw) => {
      const value = coerceMissionField(key, raw)
      if (value === undefined) issues.push({ key, reason: "invalid value" })
      return value
    },
  })

  // Unknown keys: scan the frontmatter lines for keys outside MISSION_KEYS
  // (parseFlatBlock drops them silently; the plan wants warn-once).
  for (const line of fmBody.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:/)
    if (m && !MISSION_KEYS.has(m[1]) && !issues.some((i) => i.key === m[1])) {
      issues.push({ key: m[1], reason: "unknown key" })
    }
  }

  const id = typeof parsed.id === "string" && parsed.id ? parsed.id : fallbackId
  const mission: Mission = {
    id,
    title: typeof parsed.title === "string" && parsed.title ? parsed.title : id,
    frequency: (parsed.frequency as MissionFrequency) ?? DEFAULT_MISSION.frequency,
    menus: (parsed.menus as string[]) ?? DEFAULT_MISSION.menus,
    min_level: typeof parsed.min_level === "number" ? parsed.min_level : DEFAULT_MISSION.min_level,
    approval: (parsed.approval as MissionApproval) ?? DEFAULT_MISSION.approval,
    candidacy: (parsed.candidacy as MissionCandidacy) ?? DEFAULT_MISSION.candidacy,
    agent: typeof parsed.agent === "string" ? parsed.agent : DEFAULT_MISSION.agent,
    runner: typeof parsed.runner === "string" ? parsed.runner : DEFAULT_MISSION.runner,
    onDecline: (parsed.on_decline as MissionDeclinePolicy) ?? DEFAULT_MISSION.onDecline,
    enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_MISSION.enabled,
    lane: (parsed.lane as MissionLane) ?? DEFAULT_MISSION.lane,
    body: body.trim(),
  }
  return { mission, issues }
}

// ---------------------------------------------------------------------------
// Overlay application (restrict-only, D-M5 / missions-plan §6)

/**
 * Apply the config overlay to a file-parsed mission, restrict-only. Returns
 * the effective mission; widen attempts are pushed to `rejects` (reported once
 * per process to autonomy-config.log) and the FILE value stands.
 */
export function applyMissionOverlay(
  mission: Mission,
  overlay: MissionOverlay | undefined,
  rejects: Array<{ path: string; raw: string; reason: string }>,
): Mission {
  if (!overlay) return mission
  const path = (key: string) => `missions.${mission.id}.${key}`
  const out = { ...mission }

  // 1. enabled: false is always honoured; true can never re-enable a
  //    file-disabled mission (no-op when already enabled, reject when not).
  if (overlay.enabled === false) {
    out.enabled = false
  } else if (overlay.enabled === true && !mission.enabled) {
    rejects.push({
      path: path("enabled"),
      raw: "true",
      reason: "overlay cannot enable a mission the file disables",
    })
  }

  // 2. min_level may only be raised; equal is a harmless no-op.
  if (overlay.min_level !== undefined) {
    if (overlay.min_level > mission.min_level) {
      out.min_level = overlay.min_level
    } else if (overlay.min_level < mission.min_level) {
      rejects.push({
        path: path("min_level"),
        raw: String(overlay.min_level),
        reason: `min_level may only be raised (file: ${mission.min_level})`,
      })
    }
  }

  // 3. frequency may only move toward low (rarer).
  if (overlay.frequency !== undefined && overlay.frequency !== mission.frequency) {
    const o = FREQUENCY_RANK[overlay.frequency]
    const f = FREQUENCY_RANK[mission.frequency]
    if (Number.isFinite(o) && o < f) {
      out.frequency = overlay.frequency as MissionFrequency
    } else if (Number.isFinite(o) && o > f) {
      rejects.push({
        path: path("frequency"),
        raw: overlay.frequency,
        reason: `frequency may only move toward low (file: ${mission.frequency})`,
      })
    }
  }

  // 4. menus may only be narrowed — every overlay window must already be in
  //    the file's windows. Empty overlay menus = no window = disable-ish; we
  //    accept it as the maximal narrowing (mission never qualifies).
  if (overlay.menus !== undefined) {
    const ov = expandMenus(overlay.menus)
    const fileWin = new Set(mission.menus)
    const widen = ov.filter((w) => !fileWin.has(w))
    if (widen.length > 0) {
      rejects.push({
        path: path("menus"),
        raw: overlay.menus.join(", "),
        reason: `menus may only be narrowed (file: ${mission.menus.join(", ")})`,
      })
    } else {
      out.menus = ov
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// Loader (never throws)

export type LoadMissionsOpts = {
  /** Override the warn-once log behaviour (tests inject a collector). */
  onReject?: (event: RejectEvent) => void
  /** Mission directory override (tests); default MISSIONS_DIR under `directory`. */
  missionsDir?: string
}

/** A loaded mission plus whether its *own file* enabled it, before the
 *  restrict-only overlay is applied. A missions UI needs the
 *  distinction: an overlay may disable a mission but never re-enable one the
 *  file disables (D-M5), so a toggle-on must know the file value. */
export type MissionState = Mission & { file_enabled: boolean }

/** Shared loader core: parse every mission file, record its file-level
 *  `enabled`, then apply the restrict-only overlay. */
async function loadMissionEntries(
  directory: string,
  opts: LoadMissionsOpts = {},
): Promise<Array<{ mission: Mission; fileEnabled: boolean }>> {
  const dir = opts.missionsDir ?? join(directory, MISSIONS_DIR)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  let overlay: Record<string, MissionOverlay> = {}
  try {
    overlay = await readMissionOverlay(directory, { onReject: opts.onReject })
  } catch {
    overlay = {}
  }

  const out: Array<{ mission: Mission; fileEnabled: boolean }> = []
  const seen = new Set<string>()
  const rejects: Array<{ path: string; raw: string; reason: string }> = []
  const parseIssues: Array<{ path: string; reason: string }> = []

  for (const name of entries.filter((f) => f.endsWith(".md")).sort()) {
    const fallbackId = basename(name, ".md")
    let content: string
    try {
      content = await readFile(join(dir, name), "utf8")
    } catch {
      continue // unreadable file never disables the loader
    }
    const { mission, issues } = parseMissionFile(content, fallbackId)
    for (const issue of issues) {
      parseIssues.push({ path: `missions.${mission.id}.${issue.key}`, reason: issue.reason })
    }
    if (seen.has(mission.id)) {
      parseIssues.push({ path: `missions.${mission.id}`, reason: "duplicate mission id" })
      continue
    }
    seen.add(mission.id)
    out.push({ mission: applyMissionOverlay(mission, overlay[mission.id], rejects), fileEnabled: mission.enabled })
  }

  // Report overlay rejects (section "autonomy" — same ledger as the config
  // reader) and file-parse issues (section "missions") once per process each.
  await reportRejects(directory, "autonomy", rejects, opts.onReject)
  await reportRejects(
    directory,
    "missions",
    parseIssues.map((i) => ({ path: i.path, raw: "", reason: i.reason })),
    opts.onReject,
  )

  return out
}

/**
 * Load every mission under `.opencode/missions/` (sorted by filename for
 * determinism), apply the restrict-only config overlay, and return the
 * effective mission list. A missing directory yields []; a missing config
 * file leaves the overlay empty.
 */
export async function loadMissions(
  directory: string,
  opts: LoadMissionsOpts = {},
): Promise<Mission[]> {
  return (await loadMissionEntries(directory, opts)).map((e) => e.mission)
}

/** As `loadMissions`, but keeps each mission's file-level `enabled` flag
 *  alongside the effective value — for a missions UI. */
export async function loadMissionStates(
  directory: string,
  opts: LoadMissionsOpts = {},
): Promise<MissionState[]> {
  return (await loadMissionEntries(directory, opts)).map((e) => ({
    ...e.mission,
    file_enabled: e.fileEnabled,
  }))
}
