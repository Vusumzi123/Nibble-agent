// Work-kind handler registry. The heartbeat hook iterates handlers for the
// pool and looks one up by kind to dispatch; it must never branch on a kind.
//
// Loaded via relative import only.
import type { WorkKind } from "../work-queue.ts"
import type { WorkKindHandler } from "./types.ts"
import { missionHandler } from "./mission.ts"
import { userTaskHandler } from "./user-task.ts"
import { stalenessHandler } from "./staleness.ts"
import { drainHandler } from "./drain.ts"
import { profileUpdateHandler, soulUpdateHandler } from "./steps.ts"

export const HANDLERS: readonly WorkKindHandler[] = [
  missionHandler,
  userTaskHandler,
  stalenessHandler,
  drainHandler,
  profileUpdateHandler,
  soulUpdateHandler,
]

const byKind = new Map<WorkKind, WorkKindHandler>(
  HANDLERS.map((handler) => [handler.kind, handler]),
)

export function allHandlers(): readonly WorkKindHandler[] {
  return HANDLERS
}

export function handlerFor(kind: WorkKind | string): WorkKindHandler | undefined {
  return byKind.get(kind as WorkKind)
}
