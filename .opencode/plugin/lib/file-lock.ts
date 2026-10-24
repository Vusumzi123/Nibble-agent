// Generic file lock (heartbeat-timeout-lock-resume §5.1).
//
// One lock file serializes a class of writers regardless of caller. The
// properties come straight from the drain lock this was extracted from:
//
// - Record: `{ pid, acquired_ms, heartbeat_ms, pid_start? }`. An unref'd
//   `setInterval` refreshes `heartbeat_ms` while held, so a single long unit
//   cannot lose the lock (a timer, not a unit boundary).
// - A DEAD holder is stealable immediately, even when its heartbeat is fresh
//   (a SIGKILLed process leaves a fresh record). An ALIVE holder is never
//   stolen from, however old its heartbeat — it may be hung, not gone.
//   `pid_start` (Linux `/proc/<pid>/stat` field 22) guards against PID reuse.
// - `isFileLockStale` remains the display heuristic (UI "lock_stale");
//   acquisition uses holder liveness, not age.
// - Acquire is TRY-ONLY: callers never wait on the lock. A held lock is data
//   for the caller (skip the work).
//
// Phase 1 removed the two lock callers (drain.lock, mission.lock). Only the
// ownership lease and its liveness helpers (`holderDead`, `procStart`) remain.
//
// Loaded via relative import only.
import { readFileSync } from "node:fs"
import { mkdir, open, unlink } from "node:fs/promises"
import { dirname } from "node:path"
import { atomicRead, atomicWrite } from "./fsx.ts"

export type FileLockRecord = {
  pid: number
  acquired_ms: number
  heartbeat_ms: number
  /** Process start-time (Linux `stat` field 22); guards against PID reuse. */
  pid_start?: string
}

export type FileLockHandle = {
  file: string
  record: FileLockRecord
  /** Stop the heartbeat and remove the file (idempotent; never throws). */
  release(): Promise<void>
}

/** Unreadable/malformed is stale (steal); an old heartbeat is stale. */
export function isFileLockStale(
  record: FileLockRecord | null,
  nowMs: number,
  staleMs: number,
): boolean {
  if (!record) return true
  if (!Number.isFinite(record.heartbeat_ms)) return true
  return nowMs - record.heartbeat_ms >= staleMs
}

async function readFileLock(file: string): Promise<FileLockRecord | null> {
  try {
    const text = await atomicRead(file)
    if (text.trim() === "") return null
    const parsed = JSON.parse(text) as Partial<FileLockRecord>
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

/** Linux start-time for a pid, or null when `/proc` is unavailable. */
export function procStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const close = stat.lastIndexOf(")")
    if (close < 0) return null
    // Fields after `comm`: state is index 0, so starttime (field 22) is 19.
    return stat.slice(close + 2).split(" ")[19] ?? null
  } catch {
    return null
  }
}

/**
 * Dead check: only a holder whose process is gone may be stolen from.
 * A recycled PID (same number, different start-time) counts as dead.
 */
export function holderDead(pid: number, start?: string): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
  } catch (err) {
    // ESRCH: no such process (dead). EPERM: alive but not ours (alive).
    return (err as NodeJS.ErrnoException)?.code === "ESRCH"
  }
  if (start) {
    const current = procStart(pid)
    if (current !== null && current !== start) return true
  }
  return false
}

export type AcquireFileLockOpts = {
  nowMs?: number
  refreshMs?: number
  /** Kept for compatibility; acquisition decides on holder liveness, not age. */
  staleMs?: number
}

/**
 * Try to acquire the lock. Returns a handle on success, null when a live
 * holder has it or on an unexpected IO error. A dead holder is stolen from
 * immediately (fresh heartbeat or not); an alive holder is never stolen from,
 * however stale its heartbeat — it may be hung, not gone.
 */
export async function acquireFileLock(
  file: string,
  opts: AcquireFileLockOpts = {},
): Promise<FileLockHandle | null> {
  const nowMs = opts.nowMs ?? Date.now()
  const refreshMs = Math.max(1_000, opts.refreshMs ?? 60_000)
  const start = procStart(process.pid)
  const record: FileLockRecord = {
    pid: process.pid,
    acquired_ms: nowMs,
    heartbeat_ms: nowMs,
    ...(start !== null ? { pid_start: start } : {}),
  }

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
      const held = await readFileLock(file)
      if (held && !holderDead(held.pid, held.pid_start)) return null // alive → never steal
      await unlink(file).catch(() => {})
    }
  }
  return null
}

/** Rewrite `heartbeat_ms` atomically; a record no longer ours stops the timer. */
async function refreshOnce(file: string, record: FileLockRecord): Promise<boolean> {
  try {
    const current = await readFileLock(file)
    if (!current || current.pid !== record.pid || current.acquired_ms !== record.acquired_ms) {
      return false // stolen or removed — stop refreshing
    }
    await atomicWrite(
      file,
      JSON.stringify({ ...current, heartbeat_ms: Date.now() } satisfies FileLockRecord),
    )
    return true
  } catch {
    return true // transient IO — keep the timer alive
  }
}

function startHeartbeat(
  file: string,
  record: FileLockRecord,
  refreshMs: number,
): FileLockHandle {
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
        const current = await readFileLock(file)
        if (!current || (current.pid === record.pid && current.acquired_ms === record.acquired_ms)) {
          await unlink(file).catch(() => {})
        }
      } catch {
        /* already gone */
      }
    },
  }
}
