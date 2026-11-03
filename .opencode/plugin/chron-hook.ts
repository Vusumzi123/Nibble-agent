// Chron plugin entry (docs/CHRON-SCHEDULER-PLAN.md §4.5, §4.8).
//
// Creates the process singleton, registers built-in code jobs, and starts the
// timer. Chron owns its own stale-code guard: a long-lived `opencode serve`
// must not keep firing schedules compiled from code the last restart predates.
//
// Loaded via relative import only.
import type { Plugin } from "@opencode-ai/plugin"
import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { registerChronBridge } from "./lib/chron-bridge.ts"
import { getChron } from "./lib/chron/chron.ts"
import { readChronConfig } from "./lib/chron/config.ts"
import { registerCodeJobs } from "./lib/chron/jobs/index.ts"
import type { ChronLog } from "./lib/chron/types.ts"
import { getLogger, LOG_DEFAULTS } from "./lib/logging.ts"
import { readResolvedPaths } from "./lib/paths.ts"

const CHRON_CODE_FILES = [
  ".opencode/plugin/chron-hook.ts",
  ".opencode/plugin/lib/chron-bridge.ts",
  ".opencode/plugin/lib/chron/chron.ts",
  ".opencode/plugin/lib/chron/config.ts",
  ".opencode/plugin/lib/chron/registry.ts",
  ".opencode/plugin/lib/chron/schedule.ts",
  ".opencode/plugin/lib/chron/store.ts",
  ".opencode/plugin/lib/chron/types.ts",
  ".opencode/plugin/lib/chron/jobs/index.ts",
  ".opencode/plugin/lib/chron/jobs/missions.ts",
  ".opencode/plugin/lib/chron/jobs/drain.ts",
  ".opencode/plugin/lib/work-store.ts",
  ".opencode/plugin/lib/work-store/sqlite.ts",
  ".opencode/plugin/lib/sqlite/open.ts",
  ".opencode/plugin/lib/storage-config.ts",
  ".opencode/plugin/lib/production/intents.ts",
  ".opencode/plugin/lib/production/missions.ts",
  ".opencode/plugin/lib/production/registry.ts",
]

async function staleChronFiles(directory: string, startedAtMs: number): Promise<string[]> {
  const stale: string[] = []
  for (const rel of CHRON_CODE_FILES) {
    try {
      const s = await stat(join(directory, rel))
      if (s.mtimeMs > startedAtMs + 2_000) stale.push(rel)
    } catch {
      /* missing file — nothing to compare */
    }
  }
  return stale
}

export default (async ({ directory }: Parameters<Plugin>[0]) => {
  const dir = directory ?? process.cwd()
  const { logDir, stateDir } = await readResolvedPaths(dir, homedir())

  const logger = getLogger(
    { file: "chron.log", ...LOG_DEFAULTS },
    { logDir, home: homedir(), channel: "chron" },
  )
  const log: ChronLog = {
    event: (entry) => {
      void logger.append(entry)
    },
    warn: (message, err) => {
      const detail = err instanceof Error ? err.message : err === undefined ? "" : String(err)
      console.warn(`[chron] ${message}${detail ? `: ${detail}` : ""}`)
      void logger.append({
        ts: new Date().toISOString(),
        event: "warn",
        msg: message,
        ...(detail ? { detail } : {}),
      })
    },
  }

  const startedAtMs = Date.now() - process.uptime() * 1000
  const stale = await staleChronFiles(dir, startedAtMs)
  if (stale.length > 0) {
    log.warn(`plugin code changed after this process started (${stale.join(", ")}); chron disabled — restart opencode`)
    return {}
  }

  const cfg = await readChronConfig(dir)
  if (!cfg.enabled) return {}

  const chron = getChron({
    directory: dir,
    stateDir,
    logDir,
    log,
  })
  registerChronBridge(chron, { directory: dir, stateDir, log })
  await registerCodeJobs(chron)
  chron.start()
  return {}
}) satisfies Plugin
