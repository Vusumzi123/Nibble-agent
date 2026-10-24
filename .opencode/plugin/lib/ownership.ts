// Project ownership guard (deconcurrency plan — Phase 1).
//
// One short lease that says "this process owns the project's autonomous loop".
// It is exclusion, not concurrency: a second opencode instance (a TUI-hosted
// server beside `opencode serve`) must not run a second scheduler.
//
// The lease is deliberately unlike the old `heartbeat.lock`:
//
// - `~90 s` TTL with a `~30 s` refresh. A holder that stops refreshing — hung,
//   suspended, SIGKILLed — is stealable after the TTL even when its PID is
//   still alive. The old lock never stole from a live holder, so one hung
//   process could stall the project for 30 minutes.
// - Dead holders (or a recycled PID) are stolen immediately.
// - Acquisition is try-only: callers never wait, a held lease is data.
//
// No other module may call `acquireFileLock`; this guard owns the exclusive
// create at the filesystem level.
//
// Loaded via relative import only.
import { mkdir, open, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { atomicRead, atomicWrite } from "./fsx.ts"
import { holderDead, procStart } from "./file-lock.ts"

export const OWNERSHIP_FILE = "ownership.lock"

/** A lease with no refresh for this long is stealable, even from a live PID. */
export const OWNERSHIP_TTL_MS = 90_000

/** How often a held lease re-stamps `heartbeat_ms` (TTL / 3). */
export const OWNERSHIP_REFRESH_MS = 30_000

export type OwnershipRecord = {
  pid: number
  /** Linux `/proc/<pid>/stat` field 22; guards against PID reuse. */
  pid_start?: string
  acquired_ms: number
  heartbeat_ms: number
}

export type OwnershipHandle = {
  file: string
  record: OwnershipRecord
  /** True while the on-disk record is still ours (stops on steal/removal). */
  held(): boolean
  /** Rewrite `heartbeat_ms` once, atomically. */
  refresh(): Promise<boolean>
  /** Stop refreshing and remove the file when it is still ours. */
  release(): Promise<void>
}

export type AcquireOwnershipOpts = {
  nowMs?: number
  ttlMs?: number
  refreshMs?: number
}

async function readOwnership(file: string): Promise<OwnershipRecord | null> {
  try {
    const text = await atomicRead(file)
    if (text.trim() === "") return null
    const parsed = JSON.parse(text) as Partial<OwnershipRecord>
    if (!parsed || typeof parsed.heartbeat_ms !== "number") return null
    return {
      pid: Number(parsed.pid) || 0,
      acquired_ms: Number(parsed.acquired_ms) || 0,
      heartbeat_ms: parsed.heartbeat_ms,
      ...(typeof parsed.pid_start === "string" ? { pid_start: parsed.pid_start } : {}),
    }
  } catch {
    return null
  }
}

/** Why a record may be taken over: dead holder, unreadable, or expired lease. */
function stealable(record: OwnershipRecord | null, nowMs: number, ttlMs: number): boolean {
  if (!record) return true
  if (holderDead(record.pid, record.pid_start)) return true
  return nowMs - record.heartbeat_ms >= ttlMs
}

/**
 * Try to take the lease. Returns null while a live, refreshing holder owns it.
 * The attempt is bounded: a lost unlink race costs one retry, never a wait.
 */
export async function acquireOwnership(
  file: string,
  opts: AcquireOwnershipOpts = {},
): Promise<OwnershipHandle | null> {
  const nowMs = opts.nowMs ?? Date.now()
  const ttlMs = Math.max(1_000, opts.ttlMs ?? OWNERSHIP_TTL_MS)
  const refreshMs = Math.max(500, opts.refreshMs ?? OWNERSHIP_REFRESH_MS)
  const start = procStart(process.pid)
  const record: OwnershipRecord = {
    pid: process.pid,
    acquired_ms: nowMs,
    heartbeat_ms: nowMs,
    ...(start !== null ? { pid_start: start } : {}),
  }

  await mkdir(dirname(file), { recursive: true }).catch(() => {})
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fh = await open(file, "wx")
      try {
        await fh.writeFile(JSON.stringify(record))
      } finally {
        await fh.close()
      }
      return startRefresh(file, record, refreshMs)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") return null
      const held = await readOwnership(file)
      if (!stealable(held, nowMs, ttlMs)) return null
      await unlink(file).catch(() => {})
    }
  }
  return null
}

/** Resolve the guard's path under the project-local state root. */
export function ownershipFile(stateDir: string): string {
  return join(stateDir, OWNERSHIP_FILE)
}

function startRefresh(
  file: string,
  record: OwnershipRecord,
  refreshMs: number,
): OwnershipHandle {
  let alive = true
  let released = false

  const stillOurs = async (): Promise<OwnershipRecord | null> => {
    const current = await readOwnership(file)
    if (!current) return null
    if (current.pid !== record.pid || current.acquired_ms !== record.acquired_ms) return null
    return current
  }

  const refresh = async (): Promise<boolean> => {
    if (released) return false
    try {
      const current = await stillOurs()
      if (!current) {
        alive = false
        stop()
        return false
      }
      const next = { ...current, heartbeat_ms: Date.now() }
      await atomicWrite(file, JSON.stringify(next))
      record.heartbeat_ms = next.heartbeat_ms
      return true
    } catch {
      // Transient IO: keep the lease and try again on the next tick.
      return true
    }
  }

  const timer = setInterval(() => {
    void refresh()
  }, refreshMs)
  timer.unref?.()

  const stop = (): void => {
    clearInterval(timer)
  }

  return {
    file,
    record,
    held: () => alive && !released,
    refresh,
    async release(): Promise<void> {
      if (released) return
      released = true
      alive = false
      stop()
      try {
        const current = await stillOurs()
        if (current) await unlink(file).catch(() => {})
      } catch {
        /* already gone */
      }
    },
  }
}
