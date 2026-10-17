// Mission runner registry for the drain pipe
// (knowledge-pipeline-redesign §A.11 step 4).
//
// The heartbeat dispatches `mission.runner` in-process. Today the only runner
// is `drain-pipe`; an unknown name returns null so the caller can log and fall
// through to the normal child-session dispatch.
//
// Loaded via relative import only.
import { runDrainPipe, type DrainPipeDeps, type DrainPipeResult } from "./pipe.ts"

export type MissionRunner = (deps: DrainPipeDeps) => Promise<DrainPipeResult>

const RUNNERS: Record<string, MissionRunner> = {
  "drain-pipe": runDrainPipe,
}

export function hasMissionRunner(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(RUNNERS, name)
}

/**
 * Dispatch one mission runner. Returns null for an unknown runner (the caller
 * falls back to the normal dispatch path).
 */
export async function runMissionRunner(
  name: string,
  deps: DrainPipeDeps,
): Promise<DrainPipeResult | null> {
  const runner = RUNNERS[name]
  if (!runner) return null
  return runner(deps)
}
