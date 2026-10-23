// Live `opencode` HTTP targets for the dashboard (hook + backend).
//
// A pointer file alone is not enough: the process it names can die (crash,
// SIGKILL, a terminal closed), and a stale pointer must never be followed. All
// readers probe before trusting a target, and fall back to discovering an
// opencode process running in this project directory.
//
// Discovery is Linux `/proc`-based (the project's primary platform); when
// `/proc` is unavailable the caller still has the explicit pointer/config.
//
// Loaded via relative import only.
import { readdir, readFile, readlink } from "node:fs/promises"

const PROBE_TIMEOUT_MS = 1200

/** True when `base` answers the opencode HTTP API. */
export async function probeServe(base: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/config`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}

/** `--port N` / `--port=N` from an argv vector, or "". */
function portOf(argv: string[]): string {
  let port = ""
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") port = argv[i + 1] ?? ""
    else if (argv[i].startsWith("--port=")) port = argv[i].slice("--port=".length)
  }
  return /^\d+$/.test(port) ? port : ""
}

/**
 * Loopback URLs of opencode processes serving this project directory.
 * Matches both `opencode serve --port N` and a TUI started with `--port N`.
 */
export async function discoverServe(directory: string): Promise<string[]> {
  const targets: string[] = []
  let pids: string[]
  try {
    pids = await readdir("/proc")
  } catch {
    return targets
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue
    try {
      const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean)
      if (argv.length === 0) continue
      if (!argv[0].split("/").pop()?.includes("opencode")) continue
      const port = portOf(argv)
      if (port === "") continue
      if ((await readlink(`/proc/${pid}/cwd`)) !== directory) continue
      targets.push(`http://127.0.0.1:${port}`)
    } catch {
      /* process vanished or is not readable */
    }
  }
  return targets
}

/** First reachable candidate, in order; discovery is appended as a fallback. */
export async function firstReachable(
  candidates: (string | null | undefined)[],
  directory?: string,
): Promise<string | null> {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const candidate of candidates) {
    const value = candidate?.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    ordered.push(value)
  }
  if (directory) {
    for (const candidate of await discoverServe(directory)) {
      if (!seen.has(candidate)) ordered.push(candidate)
    }
  }
  for (const candidate of ordered) {
    if (await probeServe(candidate)) return candidate
  }
  return null
}
