// Phase 0 instrumentation for the drain pipeline (knowledge-pipeline-redesign
// §C.5). One NDJSON line per pipe run and per writer/explorer spawn, so every
// later optimisation is falsifiable: source, model, prompt bytes, wall-clock,
// steps/tokens, outcome, and cursor before/after.
//
// Logging only: zero behaviour change, deterministic, and never includes
// prompt text. A write failure is swallowed by the logfile queue, so a broken
// ledger can never take the pipeline down.
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so drain/* is never loaded as
// a plugin itself.
import { homedir } from "node:os"
import { LOG_DEFAULTS, getLogger, type ChannelLogger } from "../logging.ts"
import { nowIso } from "../util.ts"

export const DRAIN_LEDGER_FILE = "drain.log"

export type DrainLedgerSource = "pipe" | "summarizer" | "writer" | "explorer" | "consumer"

export type DrainLedgerOutcome =
  | "completed"
  | "nothing"
  | "degraded"
  | "error"
  | "dropped"
  | "ok"
  | "timeout"
  | "skipped"

export type DrainLedgerEntry = {
  /** ISO timestamp; stamped here when absent. */
  ts?: string
  source: DrainLedgerSource
  outcome: DrainLedgerOutcome
  /** Model used for the call ("" / null when the agent default applied). */
  model?: string | null
  prompt_bytes?: number
  reply_bytes?: number | null
  wall_ms?: number
  steps?: number | null
  tokens?: number | null
  cost?: number | null
  sessions?: number
  items?: number
  /** Child session and the work unit it served. */
  session?: string | null
  item?: string | null
  agent?: string | null
  /** Groups the pipe/summarizer/writer lines of one drain pass. */
  pass_id?: string
  attempt?: number | null
  chunk?: number | null
  /** Caller-side timings, in milliseconds. */
  spawn_ms?: number | null
  queue_ms?: number | null
  run_ms?: number | null
  span_ms?: number | null
  model_ms?: number | null
  tool_ms?: number | null
  /** Wall time split per pass phase. */
  phase_ms?: Record<string, number>
  overhead_ms?: number | null
  /** Activity-time cursor (ms) before and after the run. */
  cursor_before?: number | null
  cursor_after?: number | null
  degraded?: string | null
  error?: string | null
  /** Free-form context. Never prompt or conversation text. */
  [key: string]: unknown
}

export type DrainLedger = {
  write(entry: DrainLedgerEntry): Promise<void>
  flush(): Promise<void>
}

export type DrainLedgerOptions = {
  logDir: string
  home?: string
  /** Inject a logger for tests; production builds the shared drain channel. */
  logger?: ChannelLogger
}

export function createDrainLedger(opts: DrainLedgerOptions): DrainLedger {
  const logger =
    opts.logger ??
    getLogger(
      { file: DRAIN_LEDGER_FILE, ...LOG_DEFAULTS },
      { logDir: opts.logDir, home: opts.home ?? homedir(), channel: "drain" },
    )

  return {
    write(entry: DrainLedgerEntry): Promise<void> {
      return logger.append({ ts: nowIso(), ...entry })
    },
    flush(): Promise<void> {
      return logger.flush()
    },
  }
}
