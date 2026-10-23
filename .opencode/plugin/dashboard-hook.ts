import type { Plugin } from "@opencode-ai/plugin"
import { spawn, type ChildProcess } from "node:child_process"
import { closeSync, mkdirSync, openSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { readDashboardConfig } from "./lib/autonomy.ts"
import { createDiagnostics } from "./lib/logging.ts"
import { readResolvedPaths } from "./lib/paths.ts"
import { firstReachable } from "./lib/serve-target.ts"

// Dashboard lifecycle tie (dashboard-ctl.sh remains the manual escape hatch).
//
// `scripts/run.sh` starts the backend itself and exports
// `DASHBOARD_AUTOSTART=0`; the hook still publishes the live `serve-url`
// pointer before returning. On a bare `opencode` launch the hook starts the
// backend (dynamic port by default) and publishes `state/dashboard-url`, which
// later starts adopt instead of spawning a duplicate.
//
// A hard SIGKILL of opencode skips the dispose/exit handlers, so the child
// survives that one case; use `scripts/dashboard-ctl.sh stop` to clear it.
const HEALTH_TIMEOUT_MS = 1200
const READY_TIMEOUT_MS = 3000

let owned: ChildProcess | null = null
let starting = false

type Health = { ok: boolean; serveUrl: string | null }

async function health(url: string): Promise<Health> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, serveUrl: null }
    const body = (await res.json()) as { serve_url?: unknown; serve_ok?: unknown }
    return {
      ok: true,
      serveUrl: typeof body.serve_url === "string" ? body.serve_url : null,
    }
  } catch {
    return { ok: false, serveUrl: null }
  }
}

async function readPointer(file: string): Promise<string> {
  try {
    return (await readFile(file, "utf8")).trim()
  } catch {
    return ""
  }
}

export default (async ({ directory, serverUrl }) => {
  const dir = directory ?? process.cwd()
  const cfg = await readDashboardConfig(dir)
  const { logDir, stateDir } = await readResolvedPaths(dir, homedir())
  const diag = createDiagnostics({ logDir, home: homedir(), channel: "dashboard-hook" })
  try {
    mkdirSync(stateDir, { recursive: true })
  } catch {
    /* read-only state dir: pointers stay unwritten, the rest still works */
  }

  // Publish a *reachable* proxy target. `serverUrl` is a placeholder
  // (http://localhost:4096) when opencode runs its server in-process, so probe
  // before trusting it; fall back to an explicit env URL, the last-good
  // pointer, or an opencode process discovered in this directory.
  const fromInstance = (() => {
    try {
      return serverUrl ? new URL(serverUrl).origin : undefined
    } catch {
      return undefined
    }
  })()
  const serveUrlFile = join(stateDir, "serve-url")
  const prior = await readPointer(serveUrlFile)
  const target = await firstReachable(
    [fromInstance, process.env.OPENCODE_SERVE_URL, prior],
    dir,
  )
  if (target) {
    try {
      await writeFile(serveUrlFile, `${target}\n`, "utf8")
    } catch (err) {
      await diag.error("[dashboard-hook] could not write state/serve-url:", err)
    }
  } else {
    await diag.warn(
      `[dashboard-hook] no reachable opencode server (instance ${fromInstance ?? "unknown"}); leaving the pointer untouched`,
    )
  }

  // run.sh supervises the backend; its pointer is already live.
  if (process.env.DASHBOARD_AUTOSTART === "0") return {}

  const dashboardUrlFile = join(stateDir, "dashboard-url")
  const host = cfg.bind_address === "0.0.0.0" || cfg.bind_address === "::" ? "127.0.0.1" : cfg.bind_address
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

  // Adopt a live backend: it is not ours, so dispose leaves it alone.
  const existing = await readPointer(dashboardUrlFile)
  const live = existing !== "" ? await health(existing) : { ok: false, serveUrl: null }
  if (live.ok) {
    if (target && live.serveUrl && live.serveUrl !== target) {
      await diag.warn(
        `[dashboard-hook] dashboard proxies ${live.serveUrl}, expected ${target}; leaving it untouched — run scripts/dashboard-ctl.sh restart`,
      )
    }
    return { dispose: async () => {} }
  }

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
            env: {
              ...process.env,
              DASHBOARD_PORT: String(cfg.port),
              DASHBOARD_STATIC_DIR: join(dir, "dashboard/static"),
            },
          },
        )
        owned = child
        child.once("exit", () => {
          if (owned === child) owned = null
        })
        child.once("error", (err) => void diag.error("[dashboard-hook] spawn failed:", err))
        // A synchronous exit hook covers the paths where `dispose` never runs.
        process.once("exit", () => stopOwned("SIGKILL"))

        // Wait for the backend to publish its bound URL (dynamic ports included).
        const deadline = Date.now() + READY_TIMEOUT_MS
        let ready = false
        while (Date.now() < deadline) {
          if (child.exitCode !== null) break
          const url = await readPointer(dashboardUrlFile)
          if (url !== "" && (await health(url)).ok) {
            ready = true
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        if (!ready) {
          await diag.warn(
            child.exitCode !== null
              ? `[dashboard-hook] backend exited early (code ${child.exitCode})`
              : "[dashboard-hook] backend did not become healthy within 3s",
          )
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
      // The backend removes its own pointer on SIGTERM. If opencode is
      // SIGKILLed the pointer survives, but every reader probes liveness and
      // the next start overwrites it — never delete a backend we do not own.
      stopOwned("SIGTERM")
    },
  }
}) satisfies Plugin
