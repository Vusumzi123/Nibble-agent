// Unified logging factory — the single entry point every hook uses to build a
// structured NDJSON channel logger, plus the shared config normalizer and the
// console->log diagnostics bridge.
//
// Config stays per-section (`knowledge:`, `decisions:`, `browser:`,
// `profile:`, `audit:`), but the *shape* is normalized here via
// `logSettingsFrom`: a section's filename key plus its `log_*` (or bare) keys
// map onto one `LogSettings`. New criteria (compression, time rotation) are read
// with the same naming convention in every section, so no section invents its
// own rotation code.
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { expandHome } from "./paths.ts"
import {
  createNdjsonLogger,
  type NdjsonLogger,
  type RotateBy,
} from "./logfile.ts"

export type LogSettings = {
  /** File leaf: absolute, `~`-prefixed, or resolved under <sysop>. */
  file: string
  rotateBytes: number
  keepGenerations: number
  retentionDays: number
  compress: boolean
  compressAfter: number
  compressLevel: number
  rotateBy: RotateBy
}

// Applied when a section omits a key. Compression is on by default (older
// generations gzip; the newest `compressAfter` stay plain and the active log is
// never compressed).
export const LOG_DEFAULTS: Omit<LogSettings, "file"> = {
  rotateBytes: 1024 * 1024,
  keepGenerations: 5,
  retentionDays: 90,
  compress: true,
  compressAfter: 1,
  compressLevel: 6,
  rotateBy: "size",
}

function num(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.toLowerCase())
  return fallback
}

function rotateByOf(value: unknown): RotateBy {
  return value === "daily" || value === "weekly" ? value : "size"
}

// Map a typed section config onto LogSettings. `filenameKey` is the section's
// log-path field (`log` / `ledger` / `scan_log`); `prefix` is the key prefix the
// section already uses (`log_` for most, `""` for `audit:`). Reads both the
// prefixed and bare form so the two conventions coexist.
export function logSettingsFrom(
  cfg: Record<string, unknown>,
  filenameKey: string,
  prefix = "log_",
): LogSettings {
  const get = (suffix: string): unknown => {
    const keyed = cfg[`${prefix}${suffix}`]
    return keyed !== undefined ? keyed : cfg[suffix]
  }
  return {
    file: typeof cfg[filenameKey] === "string" ? (cfg[filenameKey] as string) : "",
    rotateBytes: num(get("rotate_bytes"), LOG_DEFAULTS.rotateBytes),
    keepGenerations: num(get("keep_generations"), LOG_DEFAULTS.keepGenerations),
    retentionDays: num(get("retention_days"), LOG_DEFAULTS.retentionDays),
    compress: bool(get("compress"), LOG_DEFAULTS.compress),
    compressAfter: num(get("compress_after"), LOG_DEFAULTS.compressAfter),
    compressLevel: num(get("compress_level"), LOG_DEFAULTS.compressLevel),
    rotateBy: rotateByOf(get("rotate_by")),
  }
}

// Resolve a log leaf to an absolute path: absolute passes through, `~` is
// home-expanded, anything else is joined onto the <sysop> root.
export function resolveLogPath(sysopDir: string, leaf: string, home: string = homedir()): string {
  const expanded = expandHome(leaf, home)
  return isAbsolute(expanded) ? expanded : join(sysopDir, expanded)
}

export type LoggerOptions = {
  sysopDir: string
  home?: string
  channel?: string
  rotationEntry?: (ts: string) => Record<string, unknown>
  onError?: (err: unknown) => void
}

export type ChannelLogger = NdjsonLogger

// Build a fresh channel logger (uncached). Prefer `getLogger` so every consumer
// of the same file shares one serialized queue.
export function createLogger(settings: LogSettings, opts: LoggerOptions): ChannelLogger {
  const channel = opts.channel ?? "log"
  return createNdjsonLogger({
    log: resolveLogPath(opts.sysopDir, settings.file, opts.home),
    rotateBytes: settings.rotateBytes,
    keepGenerations: settings.keepGenerations,
    retentionDays: settings.retentionDays,
    compress: settings.compress,
    compressAfter: settings.compressAfter,
    compressLevel: settings.compressLevel,
    rotateBy: settings.rotateBy,
    rotationEntry: opts.rotationEntry,
    onError:
      opts.onError ??
      ((err) => {
        // A logger must never take the pipeline down; surface to the TUI only.
        console.error(`[${channel}] log write failed:`, err)
      }),
  })
}

// One logger instance per resolved file, shared process-wide so concurrent
// plugins writing the same file serialize through a single queue.
const cache = new Map<string, ChannelLogger>()

export function getLogger(settings: LogSettings, opts: LoggerOptions): ChannelLogger {
  const key = resolveLogPath(opts.sysopDir, settings.file, opts.home)
  let logger = cache.get(key)
  if (!logger) {
    logger = createLogger(settings, opts)
    cache.set(key, logger)
  }
  return logger
}

/** Test hook: drop cached loggers so a fresh instance can be built. */
export function clearLoggerCache(): void {
  cache.clear()
}

function stringifyArg(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export type Diagnostics = {
  error: (...args: unknown[]) => Promise<void>
  warn: (...args: unknown[]) => Promise<void>
  info: (...args: unknown[]) => Promise<void>
}

// Bridge hook diagnostics to both destinations: the original console output
// (unchanged TUI behaviour) and a structured `diagnostics.log` line, so
// startup/state/write failures survive the session instead of vanishing with
// the scrollback.
export function createDiagnostics(opts: LoggerOptions): Diagnostics {
  const logger = getLogger({ ...LOG_DEFAULTS, file: "diagnostics.log" }, { ...opts, channel: "diagnostics" })

  const emit = async (level: "error" | "warn" | "info", args: unknown[]): Promise<void> => {
    if (level === "error") console.error(...args)
    else if (level === "warn") console.warn(...args)
    else console.log(...args)
    const msg = args.map(stringifyArg).join(" ")
    await logger.append({ ts: new Date().toISOString(), event: "diagnostic", level, msg })
  }

  return {
    error: (...args) => emit("error", args),
    warn: (...args) => emit("warn", args),
    info: (...args) => emit("info", args),
  }
}
