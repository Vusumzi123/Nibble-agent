// Shared producer/eligibility surface for the work-kind handlers.
//
// Production split (chron-scheduler plan): mission and staleness intents are
// produced by the chron mission scan, user tasks are ingested from their files,
// and drain intents are produced by the chron drain job. Execution stays here.
//
// Loaded via relative import only.
import type { WorkItem } from "./work-queue.ts"
import { handlerFor } from "./work-kinds/registry.ts"
import type { ProducerCtx } from "./work-kinds/shared.ts"

export type { ProducerCtx } from "./work-kinds/shared.ts"
export {
  isStatusSide,
  missionEligible,
  missionExpiry,
  missionIdOf,
  missionItemId,
  statusCandidacy,
} from "./work-kinds/shared.ts"
export { missionRunnable, missionStillDue } from "./work-kinds/mission.ts"
export { stalenessRunnable, stalenessStillDue } from "./work-kinds/staleness.ts"
export {
  collectUserTasks,
  userTaskRunnable,
  userTaskStillDue,
} from "./work-kinds/user-task.ts"

/** Dequeue-time re-check, delegated to the handler that owns the kind. */
export function itemRunnable(ctx: ProducerCtx, item: WorkItem): boolean {
  return handlerFor(item.kind)?.runnable?.(ctx, item) ?? true
}

/** Prune-time "is the work still needed", delegated to the kind handler. */
export function itemStillDue(ctx: ProducerCtx, item: WorkItem): boolean {
  return handlerFor(item.kind)?.stillDue?.(ctx, item) ?? true
}
