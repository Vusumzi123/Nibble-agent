// Built-in chron code jobs (docs/CHRON-SCHEDULER-PLAN.md §4.8).
//
// Adding a code job is one file plus one registry line. Built-ins that write
// intents live on the heartbeat side and use chron's public API; chron core
// never imports them.
//
// Loaded via relative import only.
import { createMissionScan } from "../../production/missions.ts"
import { createDrainScan } from "./drain.ts"
import type { ChronLog } from "../types.ts"
import type { Chron } from "../chron.ts"
import { readChronConfig } from "../config.ts"

const NOOP_LOG: ChronLog = { event: () => {}, warn: () => {} }

export async function registerCodeJobs(chron: Chron): Promise<void> {
  const cfg = await readChronConfig(chron.deps.directory)
  const log = chron.deps.log ?? NOOP_LOG
  const missionScan = createMissionScan({
    directory: chron.deps.directory,
    stateDir: chron.deps.stateDir,
    log,
  })
  chron.register({
    id: "missions",
    schedule: cfg.mission_scan,
    handler: async () => {
      await missionScan()
    },
  })

  const drainScan = createDrainScan({
    directory: chron.deps.directory,
    stateDir: chron.deps.stateDir,
    inboxDir: cfg.inbox_dir,
    log,
  })
  chron.register({
    id: "drain",
    schedule: "every 1m",
    handler: async () => {
      await drainScan()
    },
  })
}
