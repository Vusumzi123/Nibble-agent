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
import { mkdir, open, stat, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { parseFlatBlock, readSection, sectionCoercer } from "./config.ts"
import { readAutonomyConfig, readMoodConfig, type MissionFrequency } from "./autonomy.ts"
import { pendingCount, readBacklogConfig, resolveBacklogFile } from "./backlog.ts"
import type { DecisionRequest, DecisionResult } from "./decisions.ts"
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
  /** Unconsumed turns in the temporal buffer (`turns-pending`; §17.3 drain gate). */
  unconsumedTurns?: number
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
  if (c === "digest" || c === "always") return true
  if (c === "backlog-pending") return ctx.backlogPending > 0
  if (c === "turns-pending") return (ctx.unconsumedTurns ?? 0) > 0
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
    // Side-lane missions never reach the JEV digest (docs/heartbeat-lanes.md):
    // they ride the status-fed side queue instead.
    if (m.lane === "side") continue
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
  /** Missions excluded from the candidate list (declined rerolls). */
  excludeMissions?: string[]
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
  const excluded = new Set(opts.excludeMissions ?? [])
  if (excluded.size > 0) missions = missions.filter((m) => !excluded.has(m.id))

  const candidates = buildCandidates(missions, {
    level: autonomy.level,
    quiet,
    mood,
    dispatchInfluence: moodCfg.dispatch_influence,
    candidacy: {
      backlogPending: backlog_pending,
      unconsumedTurns: unconsumed_turns,
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
// JEV digest decision (kanban card C, missions-plan §3, §9 phase C): the
// typed `no_reply | mission:<id>` choice over the already-filtered candidate
// list, plus the brief assembly (D-M1, D-M7). Deterministic and fail-OPEN to
// no_reply: an error, abstain, non-string, or unknown mission id all resolve
// to silence — a broken digest never invents work.

/** Built-in digest assertion (mirrored in .opencode/decision-prompts.yaml's
 *  `digest:` section — the file is the single source of truth for the live
 *  text; this is the missing-file fallback). */
export const DEFAULT_DIGEST_ASSERTION =
  "Decide whether this heartbeat tick should run one of the listed maintenance missions or stay silent. " +
  "Each candidate carries a `warrant` naming why it is eligible: a pending-work warrant " +
  "(`unconsumed_turns=N` / `backlog_pending=N`), a due gate (`min-gap ... due`, `dream gate passed`, " +
  "`idea quota open`), or `judgment` when only the reported signals can decide. Answer mission:<id> when " +
  "a candidate's warrant shows pending work or a gate that has come due — pending work is warranted even " +
  "during quiet hours; for `judgment` candidates decide from the signals. Use the frequency × mood weight " +
  "only to break ties among warranted candidates. If a candidate has no `warrant` field, judge it from " +
  "the reported signals. Answer no_reply only when no candidate is warranted; never invent work."

/** The typed digest verdict: run exactly one mission, or stay silent. */
export type DigestVerdict = { kind: "no_reply" } | { kind: "mission"; id: string }

/** Map a raw JEV choice value to a typed verdict. Anything unrecognised —
 *  non-strings, bare `mission:` with no id, ids not in the candidate list —
 *  fails closed to no_reply (mirrors taskKindFromVerdict). Ids are matched
 *  after lowercasing, per the lowercase-by-convention mission filenames. */
export function digestVerdictFromValue(value: unknown, candidateIds: readonly string[]): DigestVerdict {
  if (typeof value !== "string") return { kind: "no_reply" }
  const v = value.trim().toLowerCase()
  if (v === "no_reply") return { kind: "no_reply" }
  if (v.startsWith("mission:")) {
    const id = v.slice("mission:".length)
    if (candidateIds.includes(id)) return { kind: "mission", id }
  }
  return { kind: "no_reply" }
}

/** Fail-open verdict reading from a full DecisionResult (mirrors jevAllows):
 *  a null result, an error, or an abstain all mean no_reply. */
export function digestVerdictFromResult(
  result: DecisionResult | null,
  candidateIds: readonly string[],
): DigestVerdict {
  if (!result || result.error || result.abstained) return { kind: "no_reply" }
  return digestVerdictFromValue(result.value, candidateIds)
}

/** §17.10 express short-circuit (D-M8): exactly ONE candidate whose
 *  candidacy is a deterministic `min-gap:` gate dispatches without a JEV
 *  call — a time gate offers it, the sole-candidate case needs no tie-break.
 *  Anything else returns null and the normal digest decision runs. */
export function soleDeterministicVerdict(candidates: readonly DigestCandidate[]): DigestVerdict | null {
  if (candidates.length !== 1) return null
  const only = candidates[0]
  if (only.candidacy.startsWith("min-gap:")) return { kind: "mission", id: only.id }
  return null
}

/** Pending-work fallback for a failed/abstained JEV digest: pending work is
 *  warranted regardless of the model's confidence, so dispatch the
 *  highest-weight candidate whose candidacy is `turns-pending` or
 *  `backlog-pending`. Tie-break by weight descending, then id ascending.
 *  Anything else (judgment, min-gap, roll, dream/idea gates) returns null so
 *  the caller keeps its `no_reply`. */
export function deterministicDigestFallback(digest: HeartbeatDigest): DigestVerdict | null {
  let best: DigestCandidate | null = null
  for (const c of digest.candidates) {
    if (c.candidacy !== "turns-pending" && c.candidacy !== "backlog-pending") continue
    if (
      !best ||
      c.weight > best.weight ||
      (c.weight === best.weight && c.id < best.id)
    ) {
      best = c
    }
  }
  return best ? { kind: "mission", id: best.id } : null
}

/** Core plugin files whose on-disk mtime must not postdate the running
 *  process: when they do, this instance loaded stale code and must not run
 *  the heartbeat scheduler (a pre-warrant instance silently answered
 *  `no_reply` despite pending turns). */
export const HEARTBEAT_CODE_FILES = [
  ".opencode/plugin/heartbeat-hook.ts",
  ".opencode/plugin/lib/heartbeat.ts",
  ".opencode/plugin/lib/missions.ts",
  ".opencode/plugin/lib/mission-result.ts",
  ".opencode/plugin/lib/vault-stale.ts",
  ".opencode/plugin/lib/lanes/queue.ts",
  ".opencode/plugin/lib/lanes/producers.ts",
  ".opencode/plugin/lib/drain/status.ts",
  ".opencode/plugin/lib/drain/tool.ts",
  ".opencode/plugin/lib/drain/consumer.ts",
  ".opencode/plugin/lib/drain/lock.ts",
  ".opencode/plugin/lib/drain/pipe.ts",
]

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

/** Why a candidate reached the JEV — the signal half of the decision. The
 *  weight is cadence × mood, not urgency, so the model needs this field to
 *  tell "always eligible" apart from "930 turns are waiting".
 *  Compact by design: the whole state is capped at 1500 chars. */
export function candidateWarrant(candidate: DigestCandidate, signals: HeartbeatSignals): string {
  const c = candidate.candidacy
  if (c === "turns-pending") return `unconsumed_turns=${signals.unconsumed_turns}`
  if (c === "backlog-pending") return `backlog_pending=${signals.backlog_pending}`
  if (c === "brain-stale" || c.startsWith("brain-stale:")) {
    const note = signals.brain_oldest
    if (!note) return "brain_stale=no-reference-notes"
    return `brain_stale=${Math.round(note.ageHours / 24)}d path=${note.path}`
  }
  if (c === "dream-gate") return "dream gate passed"
  if (c === "idea-roll") return "idea quota open"
  if (c.startsWith("min-gap:")) return `min-gap ${c.slice("min-gap:".length)} due`
  if (c.startsWith("roll:")) return `roll ${c.slice("roll:".length)} passed`
  if (c === "digest" || c === "always") return "judgment"
  return "eligible"
}

/** Compact one-block digest state for the JEV `choice` (mirrors
 *  jevStateSummary's 1500-char cap): signals, bias, and the candidates with
 *  their effective weights and warrants — everything the verdict needs,
 *  nothing more. */
export function digestStateSummary(digest: HeartbeatDigest): string {
  const summary = {
    level: digest.level,
    quiet: digest.quiet,
    all_quiet: digest.all_quiet,
    signals: {
      backlog_pending: digest.signals.backlog_pending,
      unconsumed_turns: digest.signals.unconsumed_turns,
      audit_failures: digest.signals.audit_failures,
      staleness: Object.fromEntries(
        Object.entries(digest.signals.staleness).map(([k, h]) => [k, Math.round(h)]),
      ),
      brain_oldest: digest.signals.brain_oldest
        ? {
            path: digest.signals.brain_oldest.path,
            updated: digest.signals.brain_oldest.updated,
            age_hours: Math.round(digest.signals.brain_oldest.ageHours),
          }
        : null,
    },
    bias: digest.bias,
    candidates: digest.candidates.map((c) => ({
      id: c.id,
      title: c.title,
      weight: Number(c.weight.toFixed(2)),
      warrant: candidateWarrant(c, digest.signals),
    })),
    digest_hash: digest.digest_hash,
  }
  const s = JSON.stringify(summary)
  return s.length > 1500 ? s.slice(0, 1500) + "…" : s
}

/** The `choice` request for one heartbeat digest: candidates are `no_reply`
 *  plus `mission:<id>` for every candidate that passed the structural filter
 *  (a mission JEV cannot see cannot be prompted into existence — §3). */
export function buildDigestChoiceRequest(digest: HeartbeatDigest, criteria: string): DecisionRequest {
  return {
    kind: "choice",
    state: digestStateSummary(digest),
    candidates: ["no_reply", ...digest.candidates.map((c) => `mission:${c.id}`)],
    criteria,
    // `no_reply` is already an explicit candidate, so a low-confidence top
    // choice must not be turned into an abstain: with N candidates the top
    // probability sits near 1/N and the 0.45 threshold would silence every
    // judgment tick. Let the model choose no_reply when it means it.
    allow_abstain: false,
    // Ledger-only: the exact state the JEV saw, so a no_reply is diagnosable.
    trace: { digest_state: digestStateSummary(digest) },
  }
}

// ---------------------------------------------------------------------------
// Brief assembly (D-M1, D-M7): the heartbeat prompt is fixed — the plugin
// injects the JEV verdict and the mission body (no prompt-per-mission
// sprawl). `agent` carries the mission's `agent:` field: "" means the default
// heartbeat agent, a name pins the child session to that opencode agent.

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

/** Assemble the child-session brief: context + fixed prompt + verdict + body.
 *  Returns null on a no_reply verdict or a verdict/mission mismatch — the
 *  caller treats null as "end the tick without a session" (§12.1 step 6). */
export function assembleMissionBrief(
  verdict: DigestVerdict,
  mission: Mission | undefined,
  fixedPrompt: string = HEARTBEAT_FIXED_PROMPT,
  context?: string,
): MissionBrief | null {
  if (verdict.kind === "no_reply") return null
  if (!mission || mission.id !== verdict.id) return null
  const prompt = [
    context?.trim() ?? "",
    fixedPrompt.trim(),
    `Verdict: mission:${mission.id} — ${mission.title}`,
    mission.body,
  ]
    .filter((p) => p.trim() !== "")
    .join("\n\n")
  return { prompt, agent: mission.agent, mission_id: mission.id }
}

// ---------------------------------------------------------------------------
// Scheduler primitives (kanban card D, plan §12.1). The self-rescheduling
// `setTimeout` loop lives in heartbeat-hook.ts; the due math and the file
// lock are pure/here so the hook stays a thin runtime shell.

/** The self-rescheduling wake is always capped here, so a hot config flip
 *  (level → L0, frequency → off, or a shorter frequency) applies within a
 *  minute — no restart, no `daemon-reload`. */
export const HEARTBEAT_WAKE_CAP_MS = 60_000

/** A tick holding the lock longer than this is presumed dead (crashed child,
 *  wedged session) and the next acquire steals the lock — the overrun
 *  watchdog from the D-M9 survey. */
export const HEARTBEAT_LOCK_STALE_MS = 30 * 60_000

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
// In-progress lock (plan §12.1 step 4): `.opencode/state/heartbeat.lock`, an
// exclusive-create file holding { pid, acquired_ms }. A TUI-embedded server
// and a separate `opencode serve` can each load this plugin, so the
// in-process single-flight flag alone is not enough — the file lock is the
// cross-instance gate. Overrun semantics: a held lock skips the tick.

export type HeartbeatLock = { pid: number; acquired_ms: number; acquired_at: string }

/** Unreadable/malformed is stale (steal); an old acquired_ms is stale. */
export function isHeartbeatLockStale(
  lock: HeartbeatLock | null,
  nowMs: number,
  staleMs: number = HEARTBEAT_LOCK_STALE_MS,
): boolean {
  if (!lock) return true
  if (!Number.isFinite(lock.acquired_ms)) return true
  return nowMs - lock.acquired_ms >= staleMs
}

async function readHeartbeatLock(file: string): Promise<HeartbeatLock | null> {
  try {
    const text = await atomicRead(file)
    const parsed = JSON.parse(text) as HeartbeatLock
    if (!parsed || typeof parsed.acquired_ms !== "number") return null
    return { pid: Number(parsed.pid) || 0, acquired_ms: parsed.acquired_ms, acquired_at: String(parsed.acquired_at ?? "") }
  } catch {
    return null
  }
}

/**
 * Try to acquire the heartbeat lock. Returns the lock on success, null when a
 * fresh lock is held by someone else (skip tick) or on an unexpected IO error.
 * A stale lock is stolen once; if the steal races another stealer, the loser
 * returns null (their next wake retries).
 */
export async function acquireHeartbeatLock(
  file: string,
  nowMs: number = Date.now(),
  staleMs: number = HEARTBEAT_LOCK_STALE_MS,
): Promise<HeartbeatLock | null> {
  const lock: HeartbeatLock = {
    pid: process.pid,
    acquired_ms: nowMs,
    acquired_at: new Date(nowMs).toISOString(),
  }
  // The state dir may not exist yet (first run on a fresh project).
  await mkdir(dirname(file), { recursive: true }).catch(() => {})
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(file, "wx")
      try {
        await fh.writeFile(JSON.stringify(lock))
      } finally {
        await fh.close()
      }
      return lock
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") return null
      const held = await readHeartbeatLock(file)
      if (!isHeartbeatLockStale(held, nowMs, staleMs)) return null // fresh → overrun skip
      await unlink(file).catch(() => {})
    }
  }
  return null
}

/** Release the lock; a missing file is already released (never throws). */
export async function releaseHeartbeatLock(file: string): Promise<void> {
  await unlink(file).catch(() => {})
}

// ---------------------------------------------------------------------------
// Live status marker (kanban card 16, plan §12 / §9): `.opencode/state/
// heartbeat.current.json`. The heartbeat-hook writes it on every phase
// transition so the dashboard can render idle | in-flight and the in-flight
// mission without reading in-process state. Single writer = heartbeat-hook;
// the dashboard is a read-only consumer. Best-effort: a marker write failure
// must never fail a tick (mirrors the lock's `.catch(() => {})` discipline).

export const HEARTBEAT_CURRENT_FILE = "heartbeat.current.json"

/** Scheduler state (last tick + B7 noop backoff), shared with the dashboard
 *  so its next-tick projection uses exactly the hook's cadence math. */
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

export const HEARTBEAT_PHASES = ["pre-gate", "queues", "digest", "dispatch", "mission", "post"] as const
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
