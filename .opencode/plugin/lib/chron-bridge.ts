// Prompt bridge: markdown chron jobs -> user-task files
// (docs/CHRON-SCHEDULER-PLAN.md §4.9).
//
// The bridge is the producer for prompt jobs. It owns the policy chron must not
// read: autonomy level and the `user-task` mission gate. A gated occurrence is
// consumed silently; a full task store returns `defer`, so chron retries the
// same occurrence on the next wake instead of dropping the prompt.
//
// Loaded via relative import only.
import { join } from "node:path"
import { readAutonomyConfig } from "./autonomy.ts"
import type { Chron } from "./chron/chron.ts"
import { readChronConfig } from "./chron/config.ts"
import { readJobFiles, type ChronJob } from "./chron/store.ts"
import type { ChronLog, HandlerResult } from "./chron/types.ts"
import { loadMissions } from "./missions.ts"
import { createTask } from "./user-tasks.ts"
import { userTaskEnabled } from "./work-kinds/user-task.ts"

export type ChronBridgeDeps = {
  directory: string
  stateDir: string
  log: ChronLog
}

async function jobById(directory: string, id: string): Promise<ChronJob | null> {
  const cfg = await readChronConfig(directory)
  const { jobs } = await readJobFiles(join(directory, cfg.schedule_dir))
  return jobs.find((job) => job.id === id) ?? null
}

export function registerChronBridge(chron: Chron, deps: ChronBridgeDeps): () => void {
  return chron.on("fire", async (event): Promise<HandlerResult> => {
    if (event.source !== "file") return
    try {
      const cfg = await readChronConfig(deps.directory)
      const job = await jobById(deps.directory, event.id)
      if (!job || !job.enabled) return

      const autonomy = await readAutonomyConfig(deps.directory)
      if (autonomy.level <= 0) return
      const missions = await loadMissions(deps.directory).catch(() => [])
      if (!userTaskEnabled({ missions, level: autonomy.level })) return

      const result = await createTask(
        deps.stateDir,
        {
          title: `[chron] ${job.title}`,
          prompt: job.prompt,
          context: `source: ${job.path}\noccurrence: ${new Date(event.occurrence_ms).toISOString()}`,
          priority: cfg.default_priority,
          requested_by: "chron",
          dedupe_key: `chron:${job.id}`,
          expires_in_hours: cfg.prompt_ttl_hours,
          ...(job.agent ? { agent: job.agent } : {}),
        },
        { nowMs: event.fired_at_ms },
      )
      if (!result.ok) {
        if (result.reason.includes("cap")) return { defer: true }
        deps.log.warn(`[chron-bridge] task write failed for ${job.id}: ${result.reason}`)
      }
      return
    } catch (err) {
      deps.log.warn(`[chron-bridge] fire failed for ${event.id}`, err)
      return
    }
  })
}
