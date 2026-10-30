// `staleness` work kind: a status-fed mission. The producer, candidacy gate,
// and dispatch live with the kind; dispatch reuses the shared mission path.
//
// Loaded via relative import only.
import { candidacyPasses } from "../heartbeat.ts"
import type { WorkItem } from "../work-queue.ts"
import {
  isStatusSide,
  missionEligible,
  missionIdOf,
  missionItemId,
  statusCandidacy,
  type ProducerCtx,
} from "./shared.ts"
import type { WorkKindHandler } from "./types.ts"
import { runMissionItem } from "./mission.ts"

/** Staleness intent: at most one status mission per tick. */
export function collectStaleness(ctx: ProducerCtx): WorkItem[] {
  const candidacy = statusCandidacy(ctx)
  for (const mission of ctx.missions) {
    if (!isStatusSide(mission.candidacy)) continue
    if (mission.enqueue === "item") continue
    if (ctx.queuedIds?.has(missionItemId(mission.id))) continue
    if (!missionEligible(mission, ctx)) continue
    if (!candidacyPasses(mission, candidacy)) continue
    return [
      {
        id: missionItemId(mission.id),
        kind: "staleness",
        producer: "brain-stale",
        enqueued_ms: ctx.nowMs,
        requeue_count: 0,
      },
    ]
  }
  return []
}

export function stalenessRunnable(ctx: ProducerCtx, item: WorkItem): boolean {
  const id = missionIdOf(item)
  if (id === null) return false
  const mission = ctx.missions.find((m) => m.id === id)
  if (!mission) return false
  if (!missionEligible(mission, ctx)) return false
  return candidacyPasses(mission, statusCandidacy(ctx))
}

/** Staleness drops when the status predicate stops holding. */
export function stalenessStillDue(ctx: ProducerCtx, item: WorkItem): boolean {
  return stalenessRunnable(ctx, item)
}

export const stalenessHandler: WorkKindHandler = {
  kind: "staleness",
  produce: collectStaleness,
  runnable: stalenessRunnable,
  stillDue: stalenessStillDue,
  run: runMissionItem,
}
