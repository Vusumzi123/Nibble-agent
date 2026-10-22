import type { Plugin } from "@opencode-ai/plugin"
import { spawn, type ChildProcess } from "node:child_process"
import { closeSync, mkdirSync, openSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { readDashboardConfig } from "./lib/autonomy.ts"
import { createDiagnostics } from "./lib/logging.ts"
import { readResolvedPaths } from "./lib/paths.ts"

// Dashboard lifecycle tie (dashboard-ctl.sh remains the manual escape hatch).
//
// Starting opencode starts the local dashboard backend as a child of this
// process; disposing the plugin (opencode exit) stops the child it started.
// An already-healthy backend — another opencode instance or a manual
// `dashboard-ctl.sh start` — is adopted untouched, so this hook never kills a
// server it does not own.
//
// Opt out with `DASHBOARD_AUTOSTART=0`. A hard SIGKILL of opencode skips the
// dispose/exit handlers, so the child survives that one case; use
// `scripts/dashboard-ctl.sh stop` to clear it.
const HEALTH_TIMEOUT_MS = 1200
const START_GRACE_MS = 150

let owned: ChildProcess | null = null
let starting = false

async function healthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
    return res.ok
  } catch {
    return false
  }
}

export default (async ({ directory }) => {
  const dir = directory ?? process.cwd()
  if (process.env.DASHBOARD_AUTOSTART === "0") return {}

  const cfg = await readDashboardConfig(dir)
  const { logDir } = await readResolvedPaths(dir, homedir())
  const host = cfg.bind_address === "0.0.0.0" || cfg.bind_address === "::" ? "127.0.0.1" : cfg.bind_address
  const url = `http://${host}:${cfg.port}/api/health`
  const diag = createDiagnostics({ logDir, home: homedir(), channel: "dashboard-hook" })

  const stopOwned = (signal: NodeJS.Signals): void => {
    const child = owned
    owned = null
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    try {
      child.kill(signal)
    } catch {
      /* already gone */
    }
  }

  // Adopt a running backend: it is not ours, so dispose leaves it alone.
  if (await healthy(url)) return { dispose: async () => {} }

  if (!starting) {
    starting = true
    try {
      mkdirSync(logDir, { recursive: true })
      const fd = openSync(join(logDir, "dashboard.log"), "a")
      try {
        const child = spawn(
          process.env.NODE_BIN ?? "node",
          [join(dir, ".opencode/plugin/lib/dashboard-server.ts"), dir],
          {
            cwd: dir,
            stdio: ["ignore", fd, fd],
            env: { ...process.env, DASHBOARD_STATIC_DIR: join(dir, "dashboard/static") },
          },
        )
        owned = child
        child.once("exit", () => {
          if (owned === child) owned = null
        })
        child.once("error", (err) => void diag.error("[dashboard-hook] spawn failed:", err))
        // A synchronous exit hook covers the paths where `dispose` never runs
        // (SIGTERM/SIGINT handlers in opencode, normal process exit).
        process.once("exit", () => stopOwned("SIGKILL"))
        await new Promise((resolve) => setTimeout(resolve, START_GRACE_MS))
        if (child.exitCode !== null) {
          await diag.error(`[dashboard-hook] backend exited early (code ${child.exitCode})`)
        }
      } finally {
        closeSync(fd)
      }
    } finally {
      starting = false
    }
  }

  return {
    dispose: async () => {
      stopOwned("SIGTERM")
    },
  }
}) satisfies Plugin
