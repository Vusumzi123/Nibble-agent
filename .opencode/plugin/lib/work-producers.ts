// Shared producer/eligibility surface for the work-kind handlers.
//
// The kind rules now live with their handlers:
//   - `work-kinds/mission.ts`   → collectMissions + mission eligibility
//   - `work-kinds/staleness.ts` → collectStaleness + status eligibility
//   - `work-kinds/drain.ts`     → drain-pass intent
//
// This module keeps the historical entry points (and the shared primitives)
// so callers and tests do not need to know about the split. It imports the
// kind modules, never the reverse.
//
// Loaded via relative import only.
import type { WorkItem } from "./work-queue.ts"
import { allHandlers, handlerFor } from "./work-kinds/registry.ts"
import type { ProducerCtx } from "./work-kinds/shared.ts"

export type { ProducerCtx } from "./work-kinds/shared.ts"
export {
  isStatusSide,
  missionEligible,
  missionExpiry,
  missionIdOf,
  missionItemId,
  statusCandidacy,
  weightedPick,
} from "./work-kinds/shared.ts"
export { collectMissions, missionRunnable, missionStillDue } from "./work-kinds/mission.ts"
export { collectStaleness, stalenessRunnable, stalenessStillDue } from "./work-kinds/staleness.ts"

/** Run every handler's producer; one broken producer never blocks the others. */
export async function collectWork(ctx: ProducerCtx): Promise<WorkItem[]> {
  const out: WorkItem[] = []
  for (const handler of allHandlers()) {
    if (!handler.produce) continue
    try {
      out.push(...(await handler.produce(ctx)))
    } catch {
      /* fail-open: a broken producer contributes nothing */
    }
  }
  return out
}

/** Dequeue-time re-check, delegated to the handler that owns the kind. */
export function itemRunnable(ctx: ProducerCtx, item: WorkItem): boolean {
  return handlerFor(item.kind)?.runnable?.(ctx, item) ?? true
}

/** Prune-time "is the work still needed", delegated to the kind handler. */
export function itemStillDue(ctx: ProducerCtx, item: WorkItem): boolean {
  return handlerFor(item.kind)?.stillDue?.(ctx, item) ?? true
}
