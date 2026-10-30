// `mission` and `staleness` work kinds: brief assembly, child dispatch,
// timeout/resume settling, and the idea-pipeline post-process.
//
// Both kinds dispatch a mission child; only the gate label differs. All of the
// decision logic lives here — the heartbeat hook only calls `run`.
//
// Loaded via relative import only.
import {
  HEARTBEAT_FIXED_PROMPT,
  assembleMissionBrief,
  missionContextHeader,
} from "../heartbeat.ts"
import {
  DREAM_TONE_EVENT,
  appendDream,
  buildDreamSeeds,
  dreamHash,
  formatDreamEntry,
  newDreamId,
  parseDreamOutcome,
} from "../dream.ts"
import { pickDreamSeeds } from "../dream-seeds.ts"
import { drawCategory } from "../idea.ts"
import { resumeContextBlock, type ResumePayload } from "../mission-resume.ts"
import type { MissionResult } from "../mission-result.ts"
import type { Mission } from "../missions.ts"
import { nowIso } from "../util.ts"
import { MAX_REQUEUES, stallResumeItem, type WorkItem } from "../work-queue.ts"
import {
  isStatusSide,
  missionEligible,
  missionExpiry,
  missionIdOf,
  missionItemId,
  weightedPick,
  type ProducerCtx,
} from "./shared.ts"
import type {
  ChildRun,
  DispatchContext,
  DispatchResult,
  WorkKindHandler,
} from "./types.ts"

function resumeBlockFor(item: WorkItem | null | undefined): string {
  const payload = item?.payload as Partial<ResumePayload> | undefined
  if (!payload || payload.resume !== true || !payload.summary) return ""
  try {
    return resumeContextBlock(payload as ResumePayload)
  } catch {
    return ""
  }
}

function resultStatusOf(run: ChildRun): MissionResult["status"] | "missing" {
  return run.result?.status ?? (run.outcome === "completed" ? "missing" : "error")
}

function overBudgetOf(ctx: DispatchContext, tokens: number): boolean {
  return ctx.autonomy.mission_token_budget !== "unlimited" && tokens > ctx.autonomy.mission_token_budget
}

function runEntry(
  ctx: DispatchContext,
  mission: Mission,
  run: ChildRun,
  requeued: boolean,
  override?: { resultStatus?: string; resultMissing?: boolean },
): Record<string, unknown> {
  return {
    mission: mission.id,
    lane: "primary",
    outcome: run.outcome,
    token_cost: run.tokenCost,
    over_budget: overBudgetOf(ctx, run.tokenCost),
    session: run.sessionId,
    result_status: override?.resultStatus ?? resultStatusOf(run),
    result_missing: override?.resultMissing ?? !run.result,
    requeued,
    ...(run.aborted === undefined ? {} : { aborted: run.aborted }),
    ...(run.abortError === undefined ? {} : { abort_error: run.abortError }),
    ...(run.stopReason === undefined ? {} : { stop_reason: run.stopReason }),
    ...(run.stalledForMs === undefined ? {} : { stalled_for_ms: run.stalledForMs }),
    ...(run.lastActivity === undefined ? {} : { last_activity: run.lastActivity }),
    ...(run.orphanAborted === undefined ? {} : { orphan_abort: run.orphanAborted.length }),
    ...(run.orphanAbortError === undefined ? {} : { orphan_abort_error: run.orphanAbortError }),
    ...(run.outcome === "timeout" ? { timeout_stopped: true } : {}),
    ...(run.outcome === "timeout" && run.sessionId ? { prior_session: run.sessionId } : {}),
    ...(run.resumeItem === undefined ? {} : { resume_item: run.resumeItem }),
    ...(run.summarizer === undefined ? {} : { summarizer: run.summarizer }),
    ...(run.resumeAbandoned === undefined ? {} : { resume_abandoned: run.resumeAbandoned }),
  }
}

/** Timeout path: summarize and put the item back at the tail (same id). */
async function settleItem(
  ctx: DispatchContext,
  item: WorkItem,
  mission: Mission,
  run: ChildRun,
): Promise<WorkItem | null> {
  if (run.outcome !== "timeout") return null
  if (item.requeue_count >= MAX_REQUEUES) {
    run.summarizer = null
    run.resumeAbandoned = true
    return null
  }
  const resume = await ctx.summarizeResume(mission, run)
  run.summarizer = resume.summarizer
  const requeued = stallResumeItem(item, resume.payload, Date.now())
  if (!requeued) {
    run.summarizer = null
    run.resumeAbandoned = true
    return null
  }
  run.resumeItem = requeued.id
  return requeued
}

function missingMission(item: WorkItem): DispatchResult {
  return {
    executed: false,
    ledger: {
      verdict: "no_reply",
      mission: null,
      outcome: "silent",
      token_cost: 0,
      gate: item.kind,
      reason: "missing-mission",
    },
  }
}

export async function runMissionItem(ctx: DispatchContext, item: WorkItem): Promise<DispatchResult> {  const missionId = missionIdOf(item)
  const mission = missionId ? ctx.missions.find((m) => m.id === missionId) : undefined
  if (!mission) return missingMission(item)

  const isDream = mission.candidacy === "dream-gate"
  const seeds = isDream
    ? await pickDreamSeeds({
        directory: ctx.dir,
        stateDir: ctx.stateDir,
        vaultDir: ctx.vaultDir,
        ...(ctx.dbFile === undefined ? {} : { dbFile: ctx.dbFile }),
        moodLine: ctx.viewMood().label,
      }).catch(() => null)
    : null
  const contextBase = missionContextHeader(
    {
      tick: ctx.tick,
      nowMs: ctx.nowMs,
      level: ctx.level,
      quiet: ctx.quiet,
      signals: ctx.signals,
      digestHash: ctx.digest.digest_hash,
    },
    { tokenBudget: ctx.autonomy.mission_token_budget },
  )
  // The dream body is the prompt and carries its own typed-result contract.
  const context = [contextBase, seeds ? buildDreamSeeds(seeds) : ""]
    .filter((s) => s.trim() !== "")
    .join("\n\n")
  const brief = assembleMissionBrief(
    mission,
    isDream ? "" : HEARTBEAT_FIXED_PROMPT,
    context,
    resumeBlockFor(item),
  )
  if (!brief) return missingMission(item)

  // Record the attempt before dispatch: the no-repeat suppression and the
  // `min-gap:` store both read it back.
  await ctx.recordDispatch(mission.id)

  const extra =
    !isDream && ctx.ideaCfg.enabled && mission.id === "idea-generate"
      ? `\n\n=== REQUESTED CATEGORY ===\n${drawCategory(ctx.ideaCfg.category_weights, Math.random)}\n=== END REQUESTED CATEGORY ===`
      : ""

  await ctx.setPhase("dispatch")
  const run = await ctx.runChild({ mission, prompt: brief.prompt + extra, agent: brief.agent })
  // Dreams are tool-free attempts; a timeout has no resumable contract.
  const requeue = isDream ? null : await settleItem(ctx, item, mission, run)

  await ctx.setPhase("post")
  if (isDream) return runDreamItem(ctx, mission, run, requeue)

  const resultStatus = resultStatusOf(run)
  const declined = resultStatus === "declined"
  const failed = run.outcome !== "completed" || resultStatus === "error"
  const missionOk = !failed && !declined

  const ideaNote = await runIdeaPostProcess(ctx, mission, run, missionOk)

  return {
    executed: true,
    session_id: run.sessionId,
    ...(requeue ? { requeue } : {}),
    ...(failed ? { mood: "mission_failure" } : {}),
    ...(declined
      ? {}
      : {
          backlog: {
            title: mission.title,
            detail: run.summary || `heartbeat tick ${ctx.tick}: ${run.outcome}`,
            failed,
            summary: run.summary,
            token_cost: run.tokenCost,
          },
        }),
    ledger: {
      verdict: `mission:${mission.id}`,
      mission: mission.id,
      outcome: run.outcome,
      token_cost: run.tokenCost,
      over_budget: overBudgetOf(ctx, run.tokenCost),
      gate: item.kind === "staleness" ? "staleness" : "mission",
      reason: declined
        ? "declined"
        : run.outcome === "timeout"
          ? "timeout"
          : run.outcome === "completed"
            ? "none"
            : "error",
      runs: [runEntry(ctx, mission, run, requeue !== null)],
      ...(run.sessionId ? { session: run.sessionId } : {}),
      result_status: resultStatus,
      result_missing: !run.result,
      ...(ideaNote ? { idea: ideaNote } : {}),
      ...(run.runError ? { error: run.runError } : {}),
    },
  }
}

/**
 * Dream disposal (§17.5): parse the typed outcome, apply the tone delta through
 * the shared mood feed, append the fictional bucket entry, and count against
 * the nightly cap. A malformed/missing outcome costs a `mission_failure` wobble
 * and writes nothing.
 */
async function runDreamItem(
  ctx: DispatchContext,
  mission: Mission,
  run: ChildRun,
  requeue: WorkItem | null,
): Promise<DispatchResult> {
  let resultStatus: string = run.outcome === "completed" ? "missing" : "error"
  let resultMissing = true
  let mood: string | undefined

  if (run.outcome === "completed") {
    const parsed = parseDreamOutcome(run.summary)
    if (!parsed) {
      resultStatus = "error"
      mood = "mission_failure"
    } else {
      try {
        const before = ctx.viewMood()
        await ctx.applyMood(DREAM_TONE_EVENT[parsed.tone])
        const after = ctx.viewMood()
        await appendDream(
          ctx.vaultDir,
          formatDreamEntry(parsed, {
            id: newDreamId(ctx.nowMs),
            created: nowIso(),
            tone: parsed.tone,
            mood_before: { valence: before.valence, arousal: before.arousal },
            mood_after: { valence: after.valence, arousal: after.arousal },
            seeds: parsed.seeds,
            hash: dreamHash(parsed.narrative),
          }),
        )
        await ctx.bumpDreamsTonight()
        resultStatus = "completed"
        resultMissing = false
      } catch (err) {
        ctx.diag.error("[heartbeat-hook] dream bucket append failed:", err)
        resultStatus = "error"
        mood = "mission_failure"
      }
    }
  } else {
    mood = "mission_failure"
  }

  return {
    executed: true,
    session_id: run.sessionId,
    ...(requeue ? { requeue } : {}),
    ...(mood ? { mood } : {}),
    ledger: {
      verdict: `mission:${mission.id}`,
      mission: mission.id,
      outcome: run.outcome,
      token_cost: run.tokenCost,
      over_budget: overBudgetOf(ctx, run.tokenCost),
      gate: "dream",
      reason:
        run.outcome === "timeout"
          ? "timeout"
          : run.outcome === "completed"
            ? resultStatus === "completed"
              ? "none"
              : "malformed"
            : "error",
      runs: [runEntry(ctx, mission, run, requeue !== null, { resultStatus, resultMissing })],
      ...(run.sessionId ? { session: run.sessionId } : {}),
      result_status: resultStatus,
      result_missing: resultMissing,
      ...(run.runError ? { error: run.runError } : {}),
    },
  }
}

/** Card 7a (§17.10): the idea pipeline's post-run half. Never throws. */
async function runIdeaPostProcess(
  ctx: DispatchContext,
  mission: Mission,
  run: ChildRun,
  missionOk: boolean,
): Promise<string | null> {
  if (!ctx.ideaCfg.enabled || !missionOk) return null
  try {
    if (mission.id === "idea-generate") {
      const note = await ctx.idea.storeGenerated(run.summary, ctx.ideaCfg)
      if (note === "stored") await ctx.idea.recordGenerated()
      return note
    }
    if (mission.id === "express") {
      await ctx.idea.recordExpressed()
      return "expressed"
    }
    return null
  } catch (err) {
    ctx.diag.error("[heartbeat-hook] idea post-process failed:", err)
    return "error"
  }
}

/** Mission intent: at most one candidate per tick, chosen by frequency × mood.
 *  Missions with `enqueue: item` are produced by their own handler and never
 *  enter through the digest roll (the `user-task` consumer is one). */
export function collectMissions(ctx: ProducerCtx): WorkItem[] {
  const itemEnqueued = new Set(
    ctx.missions.filter((m) => m.enqueue === "item").map((m) => m.id),
  )
  const eligible = ctx.candidates.filter(
    (c) =>
      !isStatusSide(c.candidacy) &&
      !itemEnqueued.has(c.id) &&
      !ctx.queuedIds?.has(missionItemId(c.id)),
  )
  const picked = weightedPick(eligible, ctx.random ?? Math.random)
  if (!picked) return []
  const mission = ctx.missions.find((m) => m.id === picked.id)
  return [
    {
      id: missionItemId(picked.id),
      kind: "mission",
      producer: "tick",
      enqueued_ms: ctx.nowMs,
      priority: mission?.priority ?? 3,
      expires_ms: missionExpiry(ctx.nowMs),
      requeue_count: 0,
    },
  ]
}

/** Dequeue-time re-check: structural eligibility only. A queued mission is a
 *  reservation and runs even when the per-tick roll no longer offers it. */
export function missionRunnable(ctx: ProducerCtx, item: WorkItem): boolean {
  if (item.payload?.resume === true) return true
  const id = missionIdOf(item)
  if (id === null) return false
  const mission = ctx.missions.find((m) => m.id === id)
  return mission ? missionEligible(mission, ctx) : false
}

/** Missions are governed by their TTL, not a status predicate. */
export function missionStillDue(_ctx: ProducerCtx, _item: WorkItem): boolean {
  return true
}

export const missionHandler: WorkKindHandler = {
  kind: "mission",
  produce: collectMissions,
  runnable: missionRunnable,
  stillDue: missionStillDue,
  run: runMissionItem,
}
