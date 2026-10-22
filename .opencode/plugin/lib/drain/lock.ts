// Drain writer gate (drain-consumer-plan §2.4).
//
// One `drain.lock` serializes every drain writer — the consumer loop, the
// `drain_run` tool (dream, manual, mission) — regardless of caller. The lock
// lives INSIDE the pipe, so no caller can forget to take it.
//
// The lock mechanics are generic (`lib/file-lock.ts`, extracted for
// `state/mission.lock` in §5.1); this module only names the drain file and
// reads its dials from the drain config.
//
// Loaded via relative import only.
import { join } from "node:path"
import {
  acquireFileLock,
  isFileLockStale,
  type AcquireFileLockOpts,
  type FileLockHandle,
  type FileLockRecord,
} from "../file-lock.ts"
import type { DrainConfig } from "./config.ts"

export const DRAIN_LOCK_FILE = "drain.lock"

export type DrainLockRecord = FileLockRecord
export type DrainLockHandle = FileLockHandle
export type AcquireDrainLockOpts = AcquireFileLockOpts

/** Unreadable/malformed is stale (steal); an old heartbeat is stale. */
export function isDrainLockStale(
  record: DrainLockRecord | null,
  nowMs: number,
  staleMs: number,
): boolean {
  return isFileLockStale(record, nowMs, staleMs)
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
  return acquireFileLock(file, opts)
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
