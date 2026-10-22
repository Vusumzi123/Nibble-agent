// Drain writer gate (drain-consumer-plan §2.4).
//
// One `drain.lock` serializes every drain writer — the consumer loop, the
// `drain_run` tool (dream, manual, mission) — regardless of caller. The lock
// lives INSIDE the pipe, so no caller can forget to take it.
//
// Record: `{ pid, acquired_ms, heartbeat_ms }`. An unref'd `setInterval`
// refreshes `heartbeat_ms` while held, so a single summarize unit longer than
// the stale window cannot lose the lock (a timer, not a unit boundary). Stale
// means `heartbeat_ms` older than `staleMs` (default 3 × refresh); a steal
// requires stale AND a dead holder (`process.kill(pid, 0)` fails) — a
// hung-but-alive holder is never stolen from.
//
// Acquire is TRY-ONLY: callers never wait on the lock (§2.4). A held lock is
// data for the caller — the tool returns `skipped: lock-held`, the consumer
// skips the wake.
//
// Loaded via relative import only.
import { mkdir, open, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { atomicRead, atomicWrite } from "../fsx.ts"
import type { DrainConfig } from "./config.ts"

export const DRAIN_LOCK_FILE = "drain.lock"

export type DrainLockRecord = {
  pid: number
  acquired_ms: number
  heartbeat_ms: number
}

export type DrainLockHandle = {
  file: string
  record: DrainLockRecord
  /** Stop the heartbeat and remove the file (idempotent; never throws). */
  release(): Promise<void>
}

/** Unreadable/malformed is stale (steal); an old heartbeat is stale. */
export function isDrainLockStale(
  record: DrainLockRecord | null,
  nowMs: number,
  staleMs: number,
): boolean {
  if (!record) return true
  if (!Number.isFinite(record.heartbeat_ms)) return true
  return nowMs - record.heartbeat_ms >= staleMs
}

async function readDrainLock(file: string): Promise<DrainLockRecord | null> {
  try {
    const text = await atomicRead(file)
    if (text.trim() === "") return null
    const parsed = JSON.parse(text) as Partial<DrainLockRecord>
    if (!parsed || typeof parsed.heartbeat_ms !== "number") return null
    return {
      pid: Number(parsed.pid) || 0,
      acquired_ms: Number(parsed.acquired_ms) || 0,
      heartbeat_ms: parsed.heartbeat_ms,
    }
  } catch {
    return null
  }
}

/** Dead check: only a holder whose process is gone may be stolen from. */
function holderDead(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return false
  } catch (err) {
    // ESRCH: no such process (dead). EPERM: alive but not ours (not dead).
    return (err as NodeJS.ErrnoException)?.code === "ESRCH"
  }
}

export type AcquireDrainLockOpts = {
  nowMs?: number
  refreshMs?: number
  staleMs?: number
}

/**
 * Try to acquire the drain lock. Returns a handle on success, null when a
 * fresh (or alive-but-stale) lock is held by someone else or on an unexpected
 * IO error. A dead-and-stale lock is stolen once; a steal race loses to the
 * winner (their pipe just runs).
 */
export async function acquireDrainLock(
  file: string,
  opts: AcquireDrainLockOpts = {},
): Promise<DrainLockHandle | null> {
  const nowMs = opts.nowMs ?? Date.now()
  const refreshMs = Math.max(1_000, opts.refreshMs ?? 60_000)
  const staleMs = Math.max(refreshMs, opts.staleMs ?? 3 * refreshMs)
  const record: DrainLockRecord = { pid: process.pid, acquired_ms: nowMs, heartbeat_ms: nowMs }

  await mkdir(dirname(file), { recursive: true }).catch(() => {})
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(file, "wx")
      try {
        await fh.writeFile(JSON.stringify(record))
      } finally {
        await fh.close()
      }
      return startHeartbeat(file, record, refreshMs)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") return null
      const held = await readDrainLock(file)
      if (!isDrainLockStale(held, nowMs, staleMs)) return null // fresh → caller skips
      if (held && !holderDead(held.pid)) return null // alive → never steal
      await unlink(file).catch(() => {})
    }
  }
  return null
}

/** Rewrite `heartbeat_ms` atomically; a record no longer ours stops the timer. */
async function refreshOnce(file: string, record: DrainLockRecord): Promise<boolean> {
  try {
    const current = await readDrainLock(file)
    if (!current || current.pid !== record.pid || current.acquired_ms !== record.acquired_ms) {
      return false // stolen or removed — stop refreshing
    }
    await atomicWrite(
      file,
      JSON.stringify({ ...current, heartbeat_ms: Date.now() } satisfies DrainLockRecord),
    )
    return true
  } catch {
    return true // transient IO — keep the timer alive
  }
}

function startHeartbeat(
  file: string,
  record: DrainLockRecord,
  refreshMs: number,
): DrainLockHandle {
  const timer = setInterval(() => {
    void refreshOnce(file, record).then((alive) => {
      if (!alive) clearInterval(timer)
    })
  }, refreshMs)
  timer.unref?.()

  let released = false
  return {
    file,
    record,
    async release(): Promise<void> {
      if (released) return
      released = true
      clearInterval(timer)
      try {
        const current = await readDrainLock(file)
        if (!current || (current.pid === record.pid && current.acquired_ms === record.acquired_ms)) {
          await unlink(file).catch(() => {})
        }
      } catch {
        /* already gone */
      }
    },
  }
}

/** Resolve the lock path under the project-local state root. */
export function drainLockFile(stateDir: string): string {
  return join(stateDir, DRAIN_LOCK_FILE)
}

/**
 * Lock parameters from config (§2.4): refresh interval and the 3 × refresh
 * stale window. Config validation already floors both.
 */
export function lockOptsFromConfig(cfg: Pick<DrainConfig, "lock_refresh_ms" | "lock_stale_ms">): {
  refreshMs: number
  staleMs: number
} {
  return { refreshMs: cfg.lock_refresh_ms, staleMs: cfg.lock_stale_ms }
}
