// Deterministic signal digest for the heartbeat pre-gate (kanban card B,
// docs/heartbeat-missions-plan.md §3, §4, §9 phase B).
//
// Everything here is zero-LLM and fail-open: counts and ages read from files
// the other libs already own (backlog.ndjson, memory.json, audit.log,
// profile-note mtimes, reference-note `updated:` dates), the quiet-window
// predicate, the candidate-list build
// (enabled ∧ menus.contains(now) ∧ level ≥ min_level ∧ D-M8 candidacy), the
// bounded frequency × mood bias, and a stable `digest_hash` over the signal
// set (B7 groundwork — repeated identical digests drive adaptive backoff).
//
// The pre-gate contract (plan §6.2, §12.1 step 5): an all-quiet tick at
// level ≤ L2 ends as NO_REPLY with zero LLM calls. `computeDigest` is the
// pure data the JEV digest decision (card C, below) reads; the scheduler
// that drives it lives in heartbeat-hook.ts (card D).
//
// Mood is advisory only (§15.5): the dispatch bias here is a bounded
// multiplier journaled for calibration; it NEVER touches the autonomy gate,
// locks, approvals, or the irreversibility floor.
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.
import { createHash } from "node:crypto"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import { parseFlatBlock, readSection, sectionCoercer } from "./config.ts"
import { HEARTBEAT_CODE_FILES } from "./code-files.ts"
import { readAutonomyConfig, readMoodConfig, type MissionFrequency } from "./autonomy.ts"
import { pendingCount, readBacklogConfig, resolveBacklogFile } from "./backlog.ts"
import { atomicRead, atomicWrite } from "./fsx.ts"
import { readAuditConfig } from "./audit.ts"
import { readDrainConfig } from "./drain/config.ts"
import { readDrainStatus } from "./drain/status.ts"
import { readMemoryConfig } from "./memory/config.ts"
import { resolveProvider } from "./memory/registry.ts"
import { loadMissions, type Mission, type MissionCandidacy } from "./missions.ts"
import { DEFAULT_BASELINE, readMoodState, type MoodState } from "./mood.ts"
import { readResolvedPaths } from "./paths.ts"
import { readProfileConfig, resolveProfileFile } from "./profile.ts"
import { backoffMultiplier, readSleepState, type SleepStatus } from "./sleep.ts"
import { errText, nowIso } from "./util.ts"
import { DEFAULT_BRAIN_STALE_HOURS, oldestReferenceNote, type BrainNoteAge } from "./vault-stale.ts"
import { parseReadonlyDirs, readVaultPolicy } from "./vault-policy.ts"

// ---------------------------------------------------------------------------
// Quiet-window predicate (plan §17.1 — "one window concept, three consumers";
// this is the heartbeat pre-gate's consumer; the dream timer and idea-express
// are the other two, cards G/6).

const WINDOW_RE = /^([01]?\d|2[0-3]):([0-5]\d)-([01]?\d|2[0-3]):([0-5]\d)$/

/** Parse "HH:MM-HH:MM" into minutes-of-day. Malformed → null. */
export function parseWindow(window: string): { startMin: number; endMin: number } | null {
  const m = WINDOW_RE.exec(window.trim())
  if (!m) return null
  return {
    startMin: parseInt(m[1], 10) * 60 + parseInt(m[2], 10),
    endMin: parseInt(m[3], 10) * 60 + parseInt(m[4], 10),
  }
}

/**
 * True when `now` falls inside the quiet window. Windows may wrap midnight
 * (23:00-08:00). A malformed window or a zero-length window is never quiet
 * (fail-open to the day menu — the config reader already validated the dial).
 */
export function isQuietNow(window: string, now: Date = new Date()): boolean {
  const w = parseWindow(window)
  if (!w) return false
  if (w.startMin === w.endMin) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  if (w.startMin < w.endMin) return cur >= w.startMin && cur < w.endMin
  return cur >= w.startMin || cur < w.endMin
}

// ---------------------------------------------------------------------------
// Frequency weights (plan §4, D-M3): a digest WEIGHT, never a gate.

export const FREQUENCY_WEIGHTS: Record<MissionFrequency, number> = {
  high: 1.0,
  mid: 0.5,
  low: 0.2,
}

// ---------------------------------------------------------------------------
// Signals + all-quiet

export type HeartbeatSignals = {
  /** Open `pending` backlog entries at or below the current level. */
  backlog_pending: number
  /** Unconsumed turns in the temporal buffer (memory.json). */
  unconsumed_turns: number
  /** Non-zero exit codes in the active audit.log. */
  audit_failures: number
  /** Hours since mtime per tracked reference file (missing files omitted). */
  staleness: Record<string, number>
  /** Oldest `type: reference` vault note by its `updated:` frontmatter. */
  brain_oldest?: BrainNoteAge | null
  /** isQuietNow() over autonomy.quiet.window. */
  quiet: boolean
}

/** A reference file this old (hours) counts as a staleness signal. */
export const STALE_AFTER_HOURS = 72

/** All signals silent: no pending work, no failures, nothing stale. */
export function isAllQuiet(
  signals: HeartbeatSignals,
  staleAfterHours: number = STALE_AFTER_HOURS,
): boolean {
  if (signals.backlog_pending > 0) return false
  if (signals.unconsumed_turns > 0) return false
  if (signals.audit_failures > 0) return false
  if ((signals.brain_oldest?.ageHours ?? 0) >= DEFAULT_BRAIN_STALE_HOURS) return false
  return Object.values(signals.staleness).every((h) => h < staleAfterHours)
}

// ---------------------------------------------------------------------------
// digest_hash (B7 groundwork): stable over an identical signal set. Staleness
// ages are bucketed to whole hours so the hash holds within an hour — ms
// jitter would defeat "repeated identical digest" backoff.

export function digestHash(signals: HeartbeatSignals): string {
  const canonical = JSON.stringify({
    backlog_pending: signals.backlog_pending,
    unconsumed_turns: signals.unconsumed_turns,
    audit_failures: signals.audit_failures,
    staleness: Object.fromEntries(
      Object.entries(signals.staleness)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, h]) => [k, Math.floor(h)]),
    ),
    brain_oldest: signals.brain_oldest
      ? {
          path: signals.brain_oldest.path,
          updated: signals.brain_oldest.updated,
          age_hours: Math.floor(signals.brain_oldest.ageHours),
        }
      : null,
    quiet: signals.quiet,
  })
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16)
}

// ---------------------------------------------------------------------------
// Mood dispatch bias (plan §4, §15.4): effective bias =
// frequency_weight × mood_dispatch_bias. With `dispatch_influence: false`
// (hot dial) the mood term is exactly 1.0 and only the frequency weight
// applies. Bounded to [0.5, 1.5]; at rest (neutral valence, baseline
// arousal) the term is 1.0.

export const MOOD_BIAS_MIN = 0.5
export const MOOD_BIAS_MAX = 1.5

export function moodDispatchBias(mood: MoodState, dispatchInfluence: boolean): number {
  if (!dispatchInfluence) return 1
  const raw =
    1 + 0.25 * mood.valence + 0.25 * (mood.arousal - DEFAULT_BASELINE.arousal)
  return Math.max(MOOD_BIAS_MIN, Math.min(MOOD_BIAS_MAX, raw))
}

// ---------------------------------------------------------------------------
// Candidacy predicates (D-M8): named, deterministic, evaluated before JEV.

/** The dream-timer gates for `dream-gate` (plan §17.3): the roll and the
 *  nightly cap ride the predicate so no path can dispatch a dream without
 *  them (heartbeat woken-ticks see the sleep status and are gated out). */
export type SleepGateCtx = {
  status: SleepStatus
  /** quiet.dream_chance (hot config). */
  chance: number
  /** sleep.json dreams_tonight. */
  dreamsTonight: number
  /** quiet.nightly_dream_cap. */
  nightlyCap: number
}

export type CandidacyContext = {
  backlogPending: number
  nowMs: number
  /** Oldest refreshable reference note (`brain-stale`; absent = fail closed). */
  brainOldest?: BrainNoteAge | null
  /** Sleep state + dream dials (`dream-gate`); absent = fail closed. */
  sleep?: SleepGateCtx
  /** state-key → last-run epoch ms (`min-gap:` predicates; cards 6/7a own the store). */
  gaps?: Record<string, number>
  /** state-key → required gap ms; a missing key means 0 (any elapsed time passes). */
  minGapMs?: Record<string, number>
  /** Day-rollover draw for `idea-roll` (§17.10 card 7a); absent = fail closed. */
  ideaDay?: { target: number; generated: number }
  /** Injectable for tests; default Math.random (`roll:` predicates). */
  random?: () => number
  /** Fires for the stochastic `dream-gate` evaluation only — the roll must be
   *  journaled with its outcome (§17.3). Dream-hook collects; heartbeat
   *  passes none. */
  onDreamGate?: (info: { id: string; chance: number; passed: boolean; reason: "roll" | "status" | "nightly-cap" }) => void
}

export function candidacyPasses(mission: Mission, ctx: CandidacyContext): boolean {
  const c: MissionCandidacy = mission.candidacy
  if (c === "always") return true
  if (c === "backlog-pending") return ctx.backlogPending > 0
  if (c === "brain-stale" || c.startsWith("brain-stale:")) {
    const note = ctx.brainOldest
    if (!note) return false
    const hours =
      c === "brain-stale"
        ? DEFAULT_BRAIN_STALE_HOURS
        : parseFloat(c.slice("brain-stale:".length))
    if (!Number.isFinite(hours)) return false
    return note.ageHours >= hours
  }
  if (c === "idea-roll") {
    const d = ctx.ideaDay
    if (!d) return false // idea pipeline off (or state unreadable) — fail closed
    return d.generated < d.target
  }
  if (c === "dream-gate") {
    const s = ctx.sleep
    const report = (passed: boolean, reason: "roll" | "status" | "nightly-cap"): void =>
      ctx.onDreamGate?.({ id: mission.id, chance: s?.chance ?? 0, passed, reason })
    if (!s || s.status !== "dreaming") {
      report(false, "status")
      return false
    }
    if (s.dreamsTonight >= s.nightlyCap) {
      report(false, "nightly-cap")
      return false
    }
    const passed = (ctx.random ?? Math.random)() < s.chance
    report(passed, "roll")
    return passed
  }
  if (c.startsWith("min-gap:")) {
    const key = c.slice("min-gap:".length)
    const last = ctx.gaps?.[key]
    if (last === undefined) return true // never ran → eligible
    const need = ctx.minGapMs?.[key] ?? 0
    return ctx.nowMs - last >= need
  }
  if (c.startsWith("roll:")) {
    const chance = parseFloat(c.slice("roll:".length))
    if (!Number.isFinite(chance)) return false
    return (ctx.random ?? Math.random)() < chance
  }
  return false // unknown predicate — fail closed (parser guarantees shape)
}

// ---------------------------------------------------------------------------
// Candidate list (plan §3): the filtered set handed to the JEV digest. A
// mission that fails any filter is invisible to the model, so it cannot be
// prompted into existence.

export type DigestCandidate = {
  id: string
  title: string
  frequency: MissionFrequency
  min_level: number
  menus: string[]
  candidacy: MissionCandidacy
  frequency_weight: number
  mood_bias: number
  /** frequency_weight × mood_bias — the journaled dispatch weight (§4). */
  weight: number
}

export type CandidateCtx = {
  level: number
  quiet: boolean
  mood: MoodState
  dispatchInfluence: boolean
  candidacy: CandidacyContext
}

export function buildCandidates(missions: Mission[], ctx: CandidateCtx): DigestCandidate[] {
  const window = ctx.quiet ? "night" : "day"
  const moodBias = moodDispatchBias(ctx.mood, ctx.dispatchInfluence)
  const out: DigestCandidate[] = []
  for (const m of missions) {
    if (!m.enabled) continue
    if (!m.menus.includes(window)) continue
    if (ctx.level < m.min_level) continue
    if (!candidacyPasses(m, ctx.candidacy)) continue
    const frequencyWeight = FREQUENCY_WEIGHTS[m.frequency]
    out.push({
      id: m.id,
      title: m.title,
      frequency: m.frequency,
      min_level: m.min_level,
      menus: m.menus,
      candidacy: m.candidacy,
      frequency_weight: frequencyWeight,
      mood_bias: moodBias,
      weight: frequencyWeight * moodBias,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Digest assembly (never throws; every gatherer degrades to a silent signal)

export type HeartbeatDigest = {
  ts: string
  level: number
  quiet: boolean
  all_quiet: boolean
  /** sleep.json status (§17.1) — the dreaming NO_REPLY gate reads it (§17.2). */
  sleep_status: SleepStatus
  signals: HeartbeatSignals
  candidates: DigestCandidate[]
  bias: { mood: number; dispatch_influence: boolean }
  digest_hash: string
}

async function countAuditFailures(file: string): Promise<number> {
  const text = await atomicRead(file)
  let failures = 0
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as { exit?: unknown }
      if (typeof e.exit === "number" && e.exit !== 0) failures++
    } catch {
      // malformed line — skip, never fatal
    }
  }
  return failures
}

async function stalenessHours(
  targets: Array<{ key: string; file: string }>,
  nowMs: number,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const t of targets) {
    try {
      const s = await stat(t.file)
      out[t.key] = (nowMs - s.mtimeMs) / 3_600_000
    } catch {
      // missing file — no staleness signal
    }
  }
  return out
}

export type ComputeDigestOpts = {
  now?: Date
  /** Injectable randomness for `roll:`/`dream-gate` candidacy (tests). */
  random?: () => number
  /** min-gap store for `min-gap:` candidacy (cards 6/7a pass theirs). */
  gaps?: Record<string, number>
  minGapMs?: Record<string, number>
  /** Day-rollover draw for `idea-roll` candidacy (card 7a). */
  ideaDay?: { target: number; generated: number }
  /** Dream-hook's roll journal seam (§17.3); heartbeat passes none. */
  onDreamGate?: CandidacyContext["onDreamGate"]
  /** Explicit opencode DB path (tests/E2E); defaults to the data dir. */
  dbFile?: string
}

/**
 * Missions that must not be offered on two consecutive ticks. Staleness can
 * leave the same note looking stale after a refresh attempt (unverifiable
 * facts, or a new oldest note), so re-offering it every tick loops. The lane
 * producers apply the same suppression to side-lane collection.
 */
export const NO_REPEAT_MISSION_IDS = new Set(["staleness"])

/** Last mission dispatched by the heartbeat hook (`heartbeat.json`). */
async function readLastMission(stateDir: string): Promise<string | null> {
  const text = await atomicRead(join(stateDir, HEARTBEAT_STATE_FILE))
  if (!text) return null
  try {
    const state = JSON.parse(text) as { last_mission?: unknown }
    return typeof state.last_mission === "string" ? state.last_mission : null
  } catch {
    return null
  }
}

/**
 * Compute the full deterministic digest for a project. Hot-reads every config
 * and state file; a missing/broken input degrades to a silent signal, never a
 * throw. Zero LLM calls anywhere in this path.
 */
export async function computeDigest(
  directory: string,
  opts: ComputeDigestOpts = {},
): Promise<HeartbeatDigest> {
  const now = opts.now ?? new Date()
  const nowMs = now.getTime()

  const autonomy = await readAutonomyConfig(directory)
  const moodCfg = await readMoodConfig(directory)
  const { stateDir, logDir, vaultDir } = await readResolvedPaths(directory)

  const backlogCfg = await readBacklogConfig(directory)
  const auditCfg = await readAuditConfig(directory)
  const profileCfg = await readProfileConfig(directory)
  const drainCfg = await readDrainConfig(directory)

  const mood = await readMoodState(join(stateDir, "mood.json"))
  const sleep = await readSleepState(join(stateDir, "sleep.json"))

  let backlog_pending = 0
  let unconsumed_turns = 0
  let audit_failures = 0
  try {
    backlog_pending = await pendingCount(resolveBacklogFile(stateDir, backlogCfg), autonomy.level)
  } catch {
    /* silent */
  }
  if (drainCfg.enabled) {
    try {
      // Same eligibility snapshot the tool uses: pending work only counts when
      // the active provider can actually consume it (writer present, lane
      // enabled). A paused/read-only provider is not "out of sync".
      const memoryCfg = await readMemoryConfig(directory)
      const provider = resolveProvider(memoryCfg.provider, {
        directory,
        stateDir,
        vaultDir,
        drain: drainCfg,
        dbFile: opts.dbFile,
      })
      const status = await readDrainStatus({
        directory,
        stateDir,
        config: drainCfg,
        provider,
        dbFile: opts.dbFile,
        now: nowMs,
      })
      unconsumed_turns = status.pending ?? 0
    } catch {
      /* silent */
    }
  }
  try {
    audit_failures = await countAuditFailures(join(logDir, auditCfg.log))
  } catch {
    /* silent */
  }

  const staleness = await stalenessHours(
    [
      { key: profileCfg.agent_file, file: resolveProfileFile(vaultDir, profileCfg.agent_file) },
      { key: profileCfg.user_file, file: resolveProfileFile(vaultDir, profileCfg.user_file) },
      { key: "SETUP.md", file: join(directory, "SETUP.md") },
    ],
    nowMs,
  )

  const vaultPolicy = await readVaultPolicy(directory)
  const brainOldest = await oldestReferenceNote(vaultDir, {
    nowMs,
    excludeDirs: parseReadonlyDirs(vaultPolicy.readonly),
  })

  const quiet = isQuietNow(autonomy.quiet.window, now)
  const signals: HeartbeatSignals = {
    backlog_pending,
    unconsumed_turns,
    audit_failures,
    staleness,
    brain_oldest: brainOldest,
    quiet,
  }

  let missions: Mission[] = []
  try {
    missions = await loadMissions(directory)
  } catch {
    missions = []
  }
  const lastMission = await readLastMission(stateDir)
  if (lastMission && NO_REPEAT_MISSION_IDS.has(lastMission)) {
    missions = missions.filter((m) => m.id !== lastMission)
  }

  const candidates = buildCandidates(missions, {
    level: autonomy.level,
    quiet,
    mood,
    dispatchInfluence: moodCfg.dispatch_influence,
    candidacy: {
      backlogPending: backlog_pending,
      brainOldest,
      sleep: {
        status: sleep.status,
        chance: autonomy.quiet.dream_chance,
        dreamsTonight: sleep.dreams_tonight,
        nightlyCap: autonomy.quiet.nightly_dream_cap,
      },
      nowMs,
      gaps: opts.gaps,
      minGapMs: opts.minGapMs,
      ideaDay: opts.ideaDay,
      random: opts.random,
      onDreamGate: opts.onDreamGate,
    },
  })

  return {
    ts: nowIso(),
    level: autonomy.level,
    quiet,
    all_quiet: isAllQuiet(signals),
    sleep_status: sleep.status,
    signals,
    candidates,
    bias: { mood: moodDispatchBias(mood, moodCfg.dispatch_influence), dispatch_influence: moodCfg.dispatch_influence },
    digest_hash: digestHash(signals),
  }
}

// ---------------------------------------------------------------------------
/** Core plugin files whose on-disk mtime must not postdate the running
 *  process: when they do, this instance loaded stale code and must not run
 *  the heartbeat scheduler (a pre-warrant instance silently answered
 *  `no_reply` despite pending turns). The list lives in `code-files.ts` so
 *  adding a work kind never edits this module. */
export { HEARTBEAT_CODE_FILES }

/** Relative plugin files modified after the process started (mtime newer
 *  than `startedAtMs`, with a small clock tolerance). Missing files are not
 *  stale; the check is a guard, never a load-time failure. */
export async function staleCodeFiles(
  directory: string,
  startedAtMs: number,
  files: readonly string[] = HEARTBEAT_CODE_FILES,
  toleranceMs = 2_000,
): Promise<string[]> {
  const stale: string[] = []
  for (const rel of files) {
    try {
      const s = await stat(join(directory, rel))
      if (s.mtimeMs > startedAtMs + toleranceMs) stale.push(rel)
    } catch {
      /* missing file — nothing to compare */
    }
  }
  return stale
}

// ---------------------------------------------------------------------------
// Brief assembly (D-M1, D-M7): the heartbeat prompt is fixed — the plugin
// injects the mission body (no prompt-per-mission sprawl).

/** The fixed heartbeat prompt every mission turn starts from. */
export const HEARTBEAT_FIXED_PROMPT =
  "You are the heartbeat agent for this project — an autonomous maintenance tick, not a user " +
  "conversation. Perform exactly one mission: the brief below. Do not invent additional work, do " +
  "not ask the user questions, and stop as soon as the mission's final step is done. Record one " +
  "line describing what changed (or that there was nothing to do)."

export type MissionBrief = {
  prompt: string
  /** opencode agent name for the child session; "" = the default heartbeat agent (D-M7). */
  agent: string
  mission_id: string
}

/** The small, mission-agnostic preamble injected before every mission body.
 *  Dynamic values live here; the mission body stays the authoritative task
 *  prompt and owns the tool-usage instructions. */
export type MissionContext = {
  tick: number
  nowMs: number
  level: number
  quiet: boolean
  signals: HeartbeatSignals
  digestHash: string
}

export function missionContextHeader(
  ctx: MissionContext,
  opts: { resultContract?: boolean; tokenBudget?: number | "unlimited" } = {},
): string {
  const stale = Object.entries(ctx.signals.staleness)
    .map(([key, hours]) => `${key}=${Math.round(hours)}h`)
    .join(",")
  const brain = ctx.signals.brain_oldest
    ? `, brain_oldest=${ctx.signals.brain_oldest.path} (updated ${ctx.signals.brain_oldest.updated}, ${Math.round(ctx.signals.brain_oldest.ageHours / 24)}d old)`
    : ""
  const lines = [
    `Mission context — tick ${ctx.tick}, level ${ctx.level}, ${new Date(ctx.nowMs).toISOString()}, quiet=${ctx.signals.quiet}, digest=${ctx.digestHash}.`,
    `Signals: backlog_pending=${ctx.signals.backlog_pending}, unconsumed_turns=${ctx.signals.unconsumed_turns}, audit_failures=${ctx.signals.audit_failures}${stale ? `, staleness=${stale}` : ""}${brain}.`,
  ]
  if (typeof opts.tokenBudget === "number" && Number.isFinite(opts.tokenBudget)) {
    const contract =
      opts.resultContract === false
        ? ""
        : " Never skip the result contract to save tokens."
    lines.push(
      `Token budget: ~${opts.tokenBudget} tokens for this turn (soft; measured after the turn — no mid-turn stop). ` +
        `Scope the work and stop when the objective is met.${contract}`,
    )
  }
  if (opts.resultContract !== false) {
    lines.push(
      "Result contract: end by calling the `mission_result` tool exactly once with " +
        '`{status: "completed" | "declined" | "error", summary, reason?}`. ' +
        "If the mission cannot proceed, call it with status \"declined\", give a reason, and stop without side effects.",
    )
  }
  return lines.join("\n")
}

/** Assemble the child-session brief: context + fixed prompt + mission body.
 *  The producer already made the selection, so there is no verdict here. */
export function assembleMissionBrief(
  mission: Mission | undefined,
  fixedPrompt: string = HEARTBEAT_FIXED_PROMPT,
  context?: string,
  resumeContext?: string,
): MissionBrief | null {
  if (!mission) return null
  const prompt = [
    context?.trim() ?? "",
    resumeContext?.trim() ?? "",
    fixedPrompt.trim(),
    `Mission: ${mission.id} — ${mission.title}`,
    mission.body,
  ]
    .filter((p) => p.trim() !== "")
    .join("\n\n")
  return { prompt, agent: mission.agent, mission_id: mission.id }
}

// ---------------------------------------------------------------------------
// Scheduler primitives (kanban card D, plan §12.1). The self-rescheduling
// `setTimeout` loop lives in heartbeat-hook.ts; the due math is pure/here so
// the hook stays a thin runtime shell. Cross-instance exclusion lives in
// `ownership.ts` (one short lease — deconcurrency plan, Phase 1).

/** The self-rescheduling wake is always capped here, so a hot config flip
 *  (level → L0, frequency → off, or a shorter frequency) applies within a
 *  minute — no restart, no `daemon-reload`. */
export const HEARTBEAT_WAKE_CAP_MS = 60_000

/** `off` → null (sleep); `12h`/`30m` → ms. Malformed → null (never ticks —
 *  a garbage dial must not fire the heartbeat). */
export function frequencyToMs(frequency: string): number | null {
  if (frequency === "off") return null
  const m = /^(\d+)([mh])$/.exec(frequency.trim())
  if (!m) return null
  const n = parseInt(m[1], 10)
  if (!Number.isFinite(n) || n <= 0) return null
  return n * (m[2] === "h" ? 3_600_000 : 60_000)
}

/**
 * Effective day cadence after B7 adaptive backoff (missions-plan §7, §11 —
 * the day twin of the §17.8 dream ladder): repeated identical-digest NO_REPLY
 * ticks stretch the frequency ×2 at streak 2 and ×4 at streak 3+; a mission
 * execution or a changed digest resets the streak (recorded in
 * `.opencode/state/heartbeat.json`). `null` (off) passes through.
 */
export function effectiveFrequencyMs(baseMs: number | null, noopStreak: number): number | null {
  if (baseMs === null) return null
  return baseMs * backoffMultiplier(noopStreak)
}

export type WakeInput = {
  /** autonomy.level hot-read; L0 disables the loop entirely (frequency ignored). */
  level: number
  /** frequencyToMs() hot-read; null = off. */
  frequencyMs: number | null
  /** last tick epoch ms; null/0 = never ticked → overdue → fires once soon after boot. */
  lastTickMs: number | null
  nowMs: number
}

/**
 * Pure due math for one wake (plan §12.1 steps 2-3):
 *
 *   L0 or frequency off → HEARTBEAT_WAKE_CAP_MS (sleep on, re-check in ≤60s)
 *   not yet due         → min(remaining, cap)  (coalesces missed ticks — the
 *                        remaining window is recomputed from last_tick, so a
 *                        long outage fires once, never a replayed backlog)
 *   due (or overdue)    → 0
 */
export function computeWakeDelayMs(input: WakeInput): number {
  if (input.level <= 0 || input.frequencyMs === null) return HEARTBEAT_WAKE_CAP_MS
  if (input.lastTickMs === null || input.lastTickMs <= 0) return 0
  const remaining = input.lastTickMs + input.frequencyMs - input.nowMs
  if (remaining <= 0) return 0
  return Math.min(remaining, HEARTBEAT_WAKE_CAP_MS)
}

// ---------------------------------------------------------------------------
// Live status marker (kanban card 16, plan §12 / §9): `.opencode/state/
// heartbeat.current.json`. The heartbeat-hook writes it on every phase
// transition so a UI can render idle | in-flight and the in-flight mission
// without reading in-process state. Single writer = heartbeat-hook; any UI is
// a read-only consumer. Best-effort: a marker write failure
// must never fail a tick (mirrors the lock's `.catch(() => {})` discipline).

export const HEARTBEAT_CURRENT_FILE = "heartbeat.current.json"

/** Scheduler state (last tick + B7 noop backoff), shared with any UI so its
 *  next-tick projection uses exactly the hook's cadence math. */
export const HEARTBEAT_STATE_FILE = "heartbeat.json"

export type HeartbeatCurrent = {
  /** "in-flight" between tick start and tick end; "idle" once the tick closes. */
  state: "idle" | "in-flight"
  /** Tick counter (1-based); null before the first tick. */
  tick: number | null
  phase: HeartbeatPhase | null
  /** Mission id running this tick, or null. */
  mission: string | null
  mission_title: string | null
  /** Child session id the mission runs in, or null. */
  session: string | null
  /** Side-lane mission running concurrently (docs/heartbeat-lanes.md), or null. */
  side_mission?: string | null
  side_mission_title?: string | null
  side_session?: string | null
  /** ISO timestamp the tick transitioned to in-flight; null when idle. */
  started_at: string | null
  /** ISO timestamp of the last marker write. */
  updated_at: string
  /** Effective autonomy.level for this tick. */
  level: number | null
}

export function idleHeartbeatCurrent(now: string = nowIso()): HeartbeatCurrent {
  return {
    state: "idle",
    tick: null,
    phase: null,
    mission: null,
    mission_title: null,
    session: null,
    side_mission: null,
    side_mission_title: null,
    side_session: null,
    started_at: null,
    updated_at: now,
    level: null,
  }
}

/** Persist the marker (atomic rename); never throws. */
export async function writeHeartbeatCurrent(file: string, current: HeartbeatCurrent): Promise<void> {
  try {
    await atomicWrite(file, JSON.stringify(current))
  } catch {
    // best-effort — a marker write must never fail a tick
  }
}

/** Read the marker; a missing/corrupt file yields null (the caller renders idle). */
export async function readHeartbeatCurrent(file: string): Promise<HeartbeatCurrent | null> {
  const text = await atomicRead(file)
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as HeartbeatCurrent
    if (!parsed || typeof parsed !== "object" || typeof parsed.state !== "string") return null
    return parsed
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// `heartbeat:` config block (kanban card E, missions-plan §7): the per-tick
// ledger's log keys live in their own top-level section — same shape as
// `knowledge:`, `retrieval:`, `profile:` — plus the scheduler's kill switch.
// This is NOT the nested `autonomy.heartbeat:` dial block: `extractBlock`
// anchors at column 0, so the indented autonomy block never matches here.

export type HeartbeatConfig = {
  /** Kill switch: false → the loop sleeps on the wake cap (hot, no restart). */
  enabled: boolean
  /** A tick whose gap since the previous tick is ≥ factor × frequency feeds the
   *  `long_silence` mood event (§7); 0 disables the feed. */
  long_silence_factor: number
  // Per-tick NDJSON ledger, one line per tick; leaf under <log>.
  log: string
  log_rotate_bytes: number
  log_keep_generations: number
  log_retention_days: number
  log_compress: boolean
  log_compress_after: number
  log_compress_level: number
  log_rotate_by: string
  /** Silence window for the mission child; 0 = never stall-abort. */
  mission_stall_minutes: number
  /** Optional hard wall-clock ceiling; 0 = off (not the primary trigger). */
  mission_timeout_minutes: number
  /** A lock held longer than this is presumed dead and stolen once. */
  mission_lock_stale_ms: number
  /** Refresh cadence so a live long mission never loses its own lock. */
  mission_lock_refresh_ms: number
  /** Bound for the LLM attempt summary spawned under the lock. */
  mission_summary_timeout_ms: number
  /** Resume ceiling; 0 resumes forever. */
  mission_max_resumes: number
  /** Days before a settled user-task file is pruned; 0 disables the prune. */
  user_task_retention_days: number
}

export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  enabled: true,
  long_silence_factor: 3,
  log: "heartbeat.log",
  log_rotate_bytes: 1048576,
  log_keep_generations: 5,
  log_retention_days: 90,
  log_compress: true,
  log_compress_after: 1,
  log_compress_level: 6,
  log_rotate_by: "size",
  mission_stall_minutes: 10,
  mission_timeout_minutes: 0,
  mission_lock_stale_ms: 1_800_000,
  mission_lock_refresh_ms: 60_000,
  mission_summary_timeout_ms: 90_000,
  mission_max_resumes: 3,
  user_task_retention_days: 30,
}

const HEARTBEAT_KEYS = new Set(Object.keys(DEFAULT_HEARTBEAT_CONFIG))

/** Stall window in ms; `mission_stall_minutes: 0` → 0 (never stall-abort). */
export function missionStallMs(cfg: Pick<HeartbeatConfig, "mission_stall_minutes">): number {
  const minutes = cfg.mission_stall_minutes
  return minutes > 0 ? minutes * 60_000 : 0
}

/** Optional ceiling in ms; `mission_timeout_minutes <= 0` → 0 (no ceiling). */
export function missionTimeoutMs(cfg: Pick<HeartbeatConfig, "mission_timeout_minutes">): number {
  const minutes = cfg.mission_timeout_minutes
  return minutes > 0 ? minutes * 60_000 : 0
}

/** Stale must be >= 3 × refresh so a live holder never risks its own lock. */
export function effectiveMissionLockStaleMs(
  cfg: Pick<HeartbeatConfig, "mission_lock_stale_ms" | "mission_lock_refresh_ms">,
): number {
  return Math.max(cfg.mission_lock_stale_ms, 3 * cfg.mission_lock_refresh_ms)
}

const HEARTBEAT_COERCE = sectionCoercer({ valueTyped: true, intPattern: /^-?\d+$/ })

/** Parse a top-level `heartbeat:` block out of sysop-config.yaml text. */
export function parseHeartbeatConfig(yamlText: string): Partial<HeartbeatConfig> {
  return parseFlatBlock(yamlText, "heartbeat", {
    knownKeys: HEARTBEAT_KEYS,
    coerce: HEARTBEAT_COERCE,
  }) as Partial<HeartbeatConfig>
}

/** Effective `heartbeat:` config (file overlay on the defaults). Never throws. */
export async function readHeartbeatConfig(directory: string): Promise<HeartbeatConfig> {
  const cfg = await readSection(directory, "heartbeat", DEFAULT_HEARTBEAT_CONFIG, {
    coerce: HEARTBEAT_COERCE,
  })
  return { ...cfg, mission_lock_stale_ms: effectiveMissionLockStaleMs(cfg) }
}

// ---------------------------------------------------------------------------
// Error fields for the per-tick ledger (shared error-logging pass 2026-10-14):
// a failing tick records WHERE it failed and the full error, so the ledger is
// a troubleshooting surface, not just an outcome counter.

export const HEARTBEAT_PHASES = [
  "pre-gate",
  "queues",
  "drain",
  "dispatch",
  "mission",
  "post",
  "quiet-hours",
  "profile-update",
  "soul-update",
] as const
export type HeartbeatPhase = (typeof HEARTBEAT_PHASES)[number]

export type HeartbeatError = {
  /** Which stage of the tick failed. */
  phase: HeartbeatPhase
  name: string
  message: string
  stack?: string
  code?: string | number
}

const STACK_MAX_CHARS = 2048

function truncate(text: string): string {
  return text.length > STACK_MAX_CHARS ? text.slice(0, STACK_MAX_CHARS) + "…[truncated]" : text
}

/** Build the persisted error record for a thrown value at a given phase. */
export function heartbeatErrorFields(phase: HeartbeatPhase, err: unknown): HeartbeatError {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code
    const fields: HeartbeatError = { phase, name: err.name, message: err.message }
    if (err.stack) fields.stack = truncate(err.stack)
    if (typeof code === "string" || typeof code === "number") fields.code = code
    return fields
  }
  return { phase, name: "NonError", message: errText(err) }
}
