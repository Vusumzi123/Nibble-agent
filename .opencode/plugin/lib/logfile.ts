// Deterministic NDJSON log writer with size- and/or time-based rotation,
// gzip compression of older generations, and age-based retention. The single
// shared engine behind every structured hook log (audit, telemetry, decisions,
// web-scan, profile), mirroring audit-logger.py's original
// shift-and-rename scheme.
//
// Policy per generation index N:
//   - the active log is always plain and is never rotated away by retention.
//   - on rotation the active log becomes `.1`; older generations shift down.
//   - the newest `compressAfter` generations stay plain for quick inspection;
//     anything older is gzipped to `.N.gz`.
//   - rotated files (either `.N` or `.N.gz`) older than `retentionDays` are
//     deleted; the active log is never deleted.
//
// Every write is best-effort and serialized through an internal promise queue,
// so concurrent hook events cannot interleave partial lines and a logging
// failure can never break the caller. No LLM, no network, filesystem only.
import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises"
import { createReadStream, createWriteStream } from "node:fs"
import { createGzip } from "node:zlib"
import { pipeline } from "node:stream/promises"
import { dirname } from "node:path"
import { isEnoent } from "./util.ts"

export type RotateBy = "size" | "daily" | "weekly"

export type NdjsonLogConfig = {
  log: string
  /** Size cap in bytes; <= 0 disables the size trigger. */
  rotateBytes: number
  /** Number of rotated generations to keep (`log.1` .. `log.N`). */
  keepGenerations: number
  /** Delete rotated files older than this many days; <= 0 disables. */
  retentionDays: number
  /** Gzip rotated generations beyond `compressAfter`. Default false. */
  compress?: boolean
  /** Newest N rotated generations stay plain. Default 1. */
  compressAfter?: number
  /** zlib level 1-9. Default 6. */
  compressLevel?: number
  /** Rotation trigger: `size` (default), `daily`, or `weekly` (UTC boundaries). */
  rotateBy?: RotateBy
  /** Entry written as the first line of the fresh log; defaults to a rotation marker. */
  rotationEntry?: (ts: string) => Record<string, unknown>
  /** Called when an append fails; must not throw. */
  onError?: (err: unknown) => void
  /** Injectable clock (ms since epoch) for deterministic tests. */
  now?: () => number
  /** Injectable fs hooks for tests are intentionally not exposed; use a temp dir. */
}

export type NdjsonLogger = {
  append(entry: Record<string, unknown>): Promise<void>
  /** Resolve once every queued append has settled. */
  flush(): Promise<void>
}

const DAY_MS = 86_400_000

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

// A report callback receives phase-tagged failures from the best-effort
// internals (rotation, compression, retention) so they are no longer silent.
// `err` keeps its original error as `cause`; the `phase` field marks the
// origin. Untagged errors coming back through `append` get phase "append".
type Report = (phase: string, err: unknown) => void

async function safeUnlink(p: string, report?: Report): Promise<void> {
  try {
    await unlink(p)
  } catch (err) {
    if (!isEnoent(err)) report?.("unlink", err)
  }
}

async function safeRename(from: string, to: string, report?: Report): Promise<void> {
  try {
    await rename(from, to)
  } catch (err) {
    if (!isEnoent(err)) report?.("rename", err)
  }
}

// UTC period start for the active file's rotation window. `daily` is midnight
// UTC; `weekly` is the preceding Monday 00:00 UTC (ISO-style week).
function periodStart(rotateBy: RotateBy, ms: number): number {
  const d = new Date(ms)
  if (rotateBy === "weekly") {
    const daysSinceMonday = (d.getUTCDay() + 6) % 7
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday)
  }
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

async function enforceRetention(cfg: NdjsonLogConfig, nowMs: number, report: Report): Promise<void> {
  if (cfg.retentionDays <= 0) return
  const cutoff = nowMs - cfg.retentionDays * DAY_MS
  const keep = Math.max(1, cfg.keepGenerations)
  // Rotated files never exceed `keep` generations, so this is a bounded sweep.
  for (let i = 1; i <= keep; i++) {
    for (const p of [`${cfg.log}.${i}`, `${cfg.log}.${i}.gz`]) {
      try {
        const s = await stat(p)
        if (s.mtimeMs < cutoff) await unlink(p)
      } catch (err) {
        // not present — nothing to do; anything else is a real failure.
        if (!isEnoent(err)) report("retention", err)
      }
    }
  }
}

async function shouldRotate(cfg: NdjsonLogConfig, nowMs: number): Promise<boolean> {
  let size: number
  let mtimeMs: number
  try {
    const s = await stat(cfg.log)
    size = s.size
    mtimeMs = s.mtimeMs
  } catch {
    return false
  }
  if (cfg.rotateBytes > 0 && size >= cfg.rotateBytes) return true
  const by = cfg.rotateBy ?? "size"
  if (by !== "size" && periodStart(by, mtimeMs) < periodStart(by, nowMs)) return true
  return false
}

// Compress a plain rotated generation in place: `log.N` -> `log.N.gz`, then
// remove the plain file. Streaming so a large log never buffers in memory.
async function compressGeneration(
  cfg: NdjsonLogConfig,
  index: number,
  level: number,
  report: Report,
): Promise<void> {
  const src = `${cfg.log}.${index}`
  if (!(await exists(src))) return
  const dest = `${src}.gz`
  await safeUnlink(dest, report)
  try {
    await pipeline(createReadStream(src), createGzip({ level }), createWriteStream(dest))
    await unlink(src)
  } catch (err) {
    // Compression is best-effort: leave the plain file if gzip failed —
    // but report the failure so a silently degrading archive is visible.
    report("compress", err)
    await safeUnlink(dest, report)
  }
}

// Move generation `from` -> `to`, handling both plain and `.gz` variants and
// clearing the target first so a stale file can never survive a shift.
async function moveGeneration(log: string, from: number, to: number, report: Report): Promise<void> {
  await safeUnlink(`${log}.${to}`, report)
  await safeUnlink(`${log}.${to}.gz`, report)
  if (await exists(`${log}.${from}.gz`)) {
    await safeRename(`${log}.${from}.gz`, `${log}.${to}.gz`, report)
  }
  if (await exists(`${log}.${from}`)) {
    await safeRename(`${log}.${from}`, `${log}.${to}`, report)
  }
}

async function rotate(cfg: NdjsonLogConfig, nowMs: number, report: Report): Promise<void> {
  const keep = Math.max(1, cfg.keepGenerations)
  const compressAfter = Math.max(0, Math.min(cfg.compressAfter ?? 1, keep))
  const level = Math.max(1, Math.min(cfg.compressLevel ?? 6, 9))

  // Drop the oldest slot, then shift every generation down by one.
  await safeUnlink(`${cfg.log}.${keep}`, report)
  await safeUnlink(`${cfg.log}.${keep}.gz`, report)
  for (let i = keep - 1; i >= 1; i--) {
    await moveGeneration(cfg.log, i, i + 1, report)
  }

  // Active -> .1 (always plain).
  await safeUnlink(`${cfg.log}.1`, report)
  await safeUnlink(`${cfg.log}.1.gz`, report)
  await safeRename(cfg.log, `${cfg.log}.1`, report)

  // Compress generations beyond the hot window.
  if (cfg.compress) {
    for (let i = compressAfter + 1; i <= keep; i++) {
      await compressGeneration(cfg, i, level, report)
    }
  }

  // First line of the fresh active log.
  const ts = new Date(nowMs).toISOString()
  const notice = cfg.rotationEntry
    ? cfg.rotationEntry(ts)
    : { ts, event: "log-rotation" }
  try {
    await appendFile(cfg.log, JSON.stringify(notice) + "\n", "utf8")
  } catch (err) {
    report("marker", err)
  }
}

export function createNdjsonLogger(cfg: NdjsonLogConfig): NdjsonLogger {
  const now = cfg.now ?? Date.now
  let queue: Promise<void> = Promise.resolve()

  // Tag an error with its origin phase (once), preserving the original as
  // `cause`, and hand it to onError without ever letting onError throw back.
  const report: Report = (phase, err) => {
    let tagged = err
    if (!(err instanceof Error && "phase" in err)) {
      const base = err instanceof Error ? err : new Error(String(err))
      tagged = new Error(`[logfile:${phase}] ${base.message}`, { cause: base })
      ;(tagged as { phase?: string }).phase = phase
    }
    try {
      cfg.onError?.(tagged)
    } catch (handlerErr) {
      // Double fault: the error handler itself failed — surface it so a
      // broken onError cannot silently erase every future report.
      console.error("[logfile] onError handler itself failed:", handlerErr)
    }
  }

  async function write(entry: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(cfg.log), { recursive: true })
    const nowMs = now()
    if (await shouldRotate(cfg, nowMs)) await rotate(cfg, nowMs, report)
    await enforceRetention(cfg, nowMs, report)
    await appendFile(cfg.log, JSON.stringify(entry) + "\n", "utf8")
  }

  return {
    append(entry: Record<string, unknown>): Promise<void> {
      // Serialize; swallow failures so a log problem never surfaces as a hook
      // error or breaks the pipeline. Report via onError when provided.
      queue = queue.then(() => write(entry)).catch((err) => {
        report("append", err)
      })
      return queue
    },
    flush(): Promise<void> {
      return queue
    },
  }
}
