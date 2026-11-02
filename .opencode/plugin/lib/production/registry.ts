// Custom mission-producer registry (docs/CHRON-SCHEDULER-PLAN.md §6.2).
//
// A mission with `producer: <name>` is owned by that registered producer; the
// generic scan skips it. One owner per mission: duplicate producer ids keep the
// first registration. Registering is code, not config — a custom producer owns
// its own cadence and emits its own intents.
//
// Loaded via relative import only.
import type { AutonomyConfig } from "../autonomy.ts"
import type { CandidacyContext, HeartbeatSignals } from "../heartbeat.ts"
import type { Mission } from "../missions.ts"
import type { SleepState } from "../sleep.ts"
import type { WorkItem } from "../work-queue.ts"

export type ProductionCtx = {
  nowMs: number
  level: number
  quiet: boolean
  signals: HeartbeatSignals
  sleep: SleepState
  autonomy: AutonomyConfig
  queuedIds: ReadonlySet<string>
  random: () => number
  candidacy: CandidacyContext
}

export type MissionProducer = {
  id: string
  produce(mission: Mission, ctx: ProductionCtx): Promise<WorkItem[]> | WorkItem[]
}

const producers = new Map<string, MissionProducer>()

export function registerMissionProducer(producer: MissionProducer): boolean {
  if (producers.has(producer.id)) return false
  producers.set(producer.id, producer)
  return true
}

export function getMissionProducer(id: string): MissionProducer | undefined {
  return producers.get(id)
}

export function listMissionProducers(): MissionProducer[] {
  return [...producers.values()]
}

/** Test hook: drop registrations so a fresh test file starts clean. */
export function clearMissionProducers(): void {
  producers.clear()
}
