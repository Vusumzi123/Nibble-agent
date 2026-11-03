// DB-backed heartbeat lease (docs/SQLITE-WORK-STORE-PLAN.md §3.6).
//
// The lease row lives in `state/work.db`; chron keeps its own file lock. The
// handle mirrors the old `OwnershipHandle` surface so the heartbeat ticks do
// not branch on the storage backend.
//
// Loaded via relative import only.
import { randomBytes } from "node:crypto"
import { procStart } from "./file-lock.ts"
import {
  LEASE_REFRESH_MS,
  LEASE_TTL_MS,
  type LeaseHandle,
  type WorkStore,
} from "./work-store.ts"

export type AcquireLeaseOptions = {
  nowMs?: number
  ttlMs?: number
  refreshMs?: number
  /** Test seam; production derives it from pid + pid_start + randomness. */
  owner?: string
}

export function newOwnerToken(): string {
  const start = procStart(process.pid) ?? "0"
  return `${process.pid}:${start}:${randomBytes(4).toString("hex")}`
}

/**
 * Try to take the lease. Returns null while a live, refreshing holder owns it.
 * The attempt is try-only, like the file lease it replaces.
 */
export function acquireLease(store: WorkStore, opts: AcquireLeaseOptions = {}): LeaseHandle | null {
  const owner = opts.owner ?? newOwnerToken()
  const nowMs = opts.nowMs ?? Date.now()
  const ttlMs = Math.max(1_000, opts.ttlMs ?? LEASE_TTL_MS)
  const refreshMs = Math.max(500, opts.refreshMs ?? LEASE_REFRESH_MS)
  const record = store.leaseAcquire(owner, nowMs, ttlMs)
  if (!record) return null

  let alive = true
  let released = false

  const refresh = (atMs?: number): boolean => {
    if (released || !alive) return false
    try {
      if (store.leaseRefresh(owner, atMs ?? Date.now())) return true
    } catch {
      // A transient busy/locked write keeps the lease for the next tick.
      return true
    }
    alive = false
    stop()
    return false
  }

  const timer = setInterval(() => {
    refresh()
  }, refreshMs)
  timer.unref?.()

  const stop = (): void => {
    clearInterval(timer)
  }

  return {
    owner,
    record,
    held: () => alive && !released,
    refresh,
    release(): void {
      if (released) return
      released = true
      alive = false
      stop()
      try {
        store.leaseRelease(owner)
      } catch {
        /* lease might already be stolen; release is best-effort */
      }
    },
  }
}
