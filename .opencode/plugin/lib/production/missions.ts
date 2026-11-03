// Generic mission producer (docs/CHRON-SCHEDULER-PLAN.md §6.1).
//
// Runs as a chron code job. Every scan reads the missions, compares each
// mission's `schedule` against its own `last_evaluated_ms`, applies the
// enabled/menu/level/candidacy gates once per occurrence, and writes one
// durable intent per selected mission. It never writes work-queue.json; the
// consumer merges the inbox under its lease.
//
// `last_evaluated_ms` is producer state (`state/missions.json`), separate from
// the heartbeat's dispatch history, so a slow queue cannot stack occurrences.
//
// Loaded via relative import only.
import { join } from "node:path"
import { atomicRead, atomicWrite } from "../fsx.ts"
import {
  HEARTBEAT_STATE_FILE,
  candidacyPasses,
  gatherHeartbeatContext,
  type CandidacyContext,
  type HeartbeatContext,
} from "../heartbeat.ts"
import { DEFAULT_IDEA_STATE, ideaDayContext, readIdeaConfig, type IdeaState } from "../idea.ts"
import { loadMissions, type Mission } from "../missions.ts"
import { readStorageConfig } from "../storage-config.ts"
import { createStateStore } from "../state.ts"
import { openWorkStore } from "../work-store/sqlite.ts"
import { readChronConfig } from "../chron/config.ts"
import { occurrence, parseSchedule } from "../chron/schedule.ts"
import type { ChronLog } from "../chron/types.ts"
import { missionExpiry, missionItemId } from "../work-kinds/shared.ts"
import { getMissionProducer } from "./registry.ts"

export const MISSIONS_STATE_FILE = "missions.json"
const MISSIONS_STATE_VERSION = 1

type MissionEvalState = {
  version: number
  missions: Record<string, { last_evaluated_ms: number }>
}

export type MissionScanDeps = {
  directory: string
  stateDir: string
  log: ChronLog
  now?: () => number
  random?: () => number
}

export type MissionScanReport = {
  evaluated: string[]
  emitted: string[]
  overflow: string[]
  skipped: Array<{ id: string; reason: string }>
}

function emptyState(): MissionEvalState {
  return { version: MISSIONS_STATE_VERSION, missions: {} }
}

async function readEvalState(file: string): Promise<MissionEvalState> {
  try {
    const parsed = JSON.parse(await atomicRead(file)) as Partial<MissionEvalState>
    if (!parsed || parsed.version !== MISSIONS_STATE_VERSION || typeof parsed.missions !== "object") {
      return emptyState()
    }
    const missions: MissionEvalState["missions"] = {}
    for (const [id, raw] of Object.entries(parsed.missions ?? {})) {
      const value = raw as { last_evaluated_ms?: unknown } | null
      if (!value || typeof value.last_evaluated_ms !== "number") continue
      missions[id] = { last_evaluated_ms: value.last_evaluated_ms }
    }
    return { version: MISSIONS_STATE_VERSION, missions }
  } catch {
    return emptyState()
  }
}

async function readLastRuns(stateDir: string): Promise<Record<string, number>> {
  try {
    const parsed = JSON.parse(await atomicRead(join(stateDir, HEARTBEAT_STATE_FILE))) as {
      last_runs?: unknown
    }
    if (!parsed || typeof parsed.last_runs !== "object" || parsed.last_runs === null) return {}
    const out: Record<string, number> = {}
    for (const [id, value] of Object.entries(parsed.last_runs as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) out[id] = value
    }
    return out
  } catch {
    return {}
  }
}

function isStatusMission(mission: Mission): boolean {
  return mission.candidacy === "brain-stale" || mission.candidacy.startsWith("brain-stale:")
}

function buildCandidacy(
  ctx: HeartbeatContext,
  log: ChronLog,
  rolled: ReturnType<typeof ideaDayContext>,
  random: () => number,
  lastRuns: Record<string, number>,
  ideaEnabled: boolean,
  expressGapHours: number,
): CandidacyContext {
  return {
    backlogPending: ctx.signals.backlog_pending,
    brainOldest: ctx.brainOldest,
    sleep: {
      status: ctx.sleep.status,
      chance: ctx.autonomy.quiet.dream_chance,
      dreamsTonight: ctx.sleep.dreams_tonight,
      nightlyCap: ctx.autonomy.quiet.nightly_dream_cap,
    },
    nowMs: ctx.nowMs,
    gaps: {
      ...(rolled.state.lastExpressedAt !== null ? { express: rolled.state.lastExpressedAt } : {}),
      ...lastRuns,
    },
    minGapMs: { express: Math.max(0, expressGapHours) * 3_600_000 },
    ...(ideaEnabled ? { ideaDay: rolled.day } : {}),
    random,
    onDreamGate: (info) => {
      log.event({
        ts: new Date(ctx.nowMs).toISOString(),
        event: "dream-gate",
        ...info,
      })
    },
  }
}

async function scan(deps: MissionScanDeps, warned: Set<string>): Promise<MissionScanReport> {
  const nowMs = deps.now?.() ?? Date.now()
  const random = deps.random ?? Math.random
  const report: MissionScanReport = { evaluated: [], emitted: [], overflow: [], skipped: [] }
  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return
    warned.add(key)
    deps.log.warn(`[missions] ${message}`)
  }

  const cfg = await readChronConfig(deps.directory)
  const ctx = await gatherHeartbeatContext(deps.directory, { nowMs })
  if (ctx.autonomy.level <= 0) return report

  const missions = await loadMissions(deps.directory).catch(() => [])
  const storage = await readStorageConfig(deps.directory)
  let store: Awaited<ReturnType<typeof openWorkStore>>
  try {
    store = await openWorkStore({
      stateDir: deps.stateDir,
      path: storage.path,
      busyTimeoutMs: storage.busy_timeout_ms,
      synchronous: storage.synchronous,
      failedRetryMs: storage.failed_retry_ms,
      failedRetentionDays: storage.failed_retention_days,
      legacyInboxDir: cfg.inbox_dir,
      now: deps.now,
    })
  } catch (err) {
    deps.log.warn("[missions] work store unavailable; scan skipped", err)
    report.skipped.push({ id: "-", reason: "store-unavailable" })
    return report
  }

  try {
    const ideaCfg = await readIdeaConfig(deps.directory)
    const ideaStore = createStateStore<IdeaState>(
      join(deps.stateDir, "idea.json"),
      DEFAULT_IDEA_STATE,
    )
    const ideaState = await ideaStore.read()
    const rolled = ideaCfg.enabled
      ? ideaDayContext(ideaState, nowMs, ideaCfg.daily_weights, random)
      : { state: ideaState, day: { target: 0, generated: 0 }, changed: false }
    if (rolled.changed) await ideaStore.write(rolled.state)

    const candidacy = buildCandidacy(
      ctx,
      deps.log,
      rolled,
      random,
      await readLastRuns(deps.stateDir),
      ideaCfg.enabled,
      ideaCfg.express_min_gap_hours,
    )

    const stateFile = join(deps.stateDir, MISSIONS_STATE_FILE)
    const prior = await readEvalState(stateFile)
    const next: MissionEvalState = { version: MISSIONS_STATE_VERSION, missions: { ...prior.missions } }
    let dirty = false
    const window = ctx.quiet ? "night" : "day"
    const eligible: Array<{ mission: Mission; occurrence_ms: number }> = []

    for (const mission of missions) {
      if (mission.enqueue === "item") continue
      if (mission.producer !== "generic") {
        if (!getMissionProducer(mission.producer)) {
          warnOnce(
            `producer|${mission.id}`,
            `${mission.id}: unknown producer "${mission.producer}" — skipped`,
          )
        }
        continue
      }
      if (!mission.schedule) {
        warnOnce(`schedule|${mission.id}`, `${mission.id}: missing schedule — skipped`)
        continue
      }
      const parsed = parseSchedule(mission.schedule)
      if (!parsed.ok) {
        warnOnce(
          `schedule-invalid|${mission.id}`,
          `${mission.id}: invalid schedule "${mission.schedule}" (${parsed.reason}) — skipped`,
        )
        continue
      }

      const entry = next.missions[mission.id]
      if (!entry) {
        next.missions[mission.id] = { last_evaluated_ms: nowMs }
        dirty = true
        continue
      }
      const due = occurrence(parsed.schedule, nowMs, entry.last_evaluated_ms)
      if (!due.due) continue

      const gateOk =
        mission.enabled &&
        mission.menus.includes(window) &&
        ctx.autonomy.level >= mission.min_level &&
        candidacyPasses(mission, candidacy)
      if (!gateOk || store.has(missionItemId(mission.id))) {
        next.missions[mission.id] = { last_evaluated_ms: due.occurrence_ms }
        dirty = true
        report.evaluated.push(mission.id)
        continue
      }
      eligible.push({
        mission,
        occurrence_ms: due.occurrence_ms,
      })
    }

    eligible.sort(
      (a, b) =>
        b.mission.priority - a.mission.priority ||
        a.occurrence_ms - b.occurrence_ms ||
        a.mission.id.localeCompare(b.mission.id),
    )
    const max = Math.max(0, cfg.mission_max_per_scan)
    const selected = max === 0 ? [] : eligible.slice(0, max)
    report.overflow = eligible.slice(selected.length).map((entry) => entry.mission.id)

    const items = selected.map((entry) => {
      const { mission } = entry
      return {
        id: missionItemId(mission.id),
        kind: isStatusMission(mission) ? ("staleness" as const) : ("mission" as const),
        producer: "chron:missions",
        priority: mission.priority,
        expires_ms: missionExpiry(nowMs),
        enqueued_ms: nowMs,
        requeue_count: 0,
        payload: {
          mission: mission.id,
          occurrence_ms: entry.occurrence_ms,
          signals: ctx.signals,
          level: ctx.autonomy.level,
          quiet: ctx.quiet,
          sleep_status: ctx.sleep.status,
        },
      }
    })
    const outcome = store.enqueue(items, nowMs)
    for (const entry of selected) {
      const { mission } = entry
      const id = missionItemId(mission.id)
      if (outcome.rejected.includes(id)) {
        report.skipped.push({ id: mission.id, reason: "queue-full" })
        continue
      }
      next.missions[mission.id] = { last_evaluated_ms: entry.occurrence_ms }
      dirty = true
      report.evaluated.push(mission.id)
      if (outcome.accepted.includes(id)) report.emitted.push(mission.id)
    }

    if (dirty) {
      try {
        await atomicWrite(stateFile, JSON.stringify(next, null, 2) + "\n")
      } catch (err) {
        deps.log.warn(
          `[missions] failed to save ${stateFile}; occurrences may repeat`,
          err,
        )
        report.skipped.push({ id: "-", reason: "state save failed" })
      }
    }

    return report
  } finally {
    store.close()
  }
}

/** Build a scan handler with a process-lifetime warn-once set. */
export function createMissionScan(deps: MissionScanDeps): () => Promise<MissionScanReport> {
  const warned = new Set<string>()
  return () => scan(deps, warned)
}

/** One-shot scan (tests); warn-once is scoped to this call. */
export function runMissionScan(deps: MissionScanDeps): Promise<MissionScanReport> {
  return scan(deps, new Set())
}
