// The drain as an agent-callable tool.
//
// The mission body owns the prompt; this module owns the deterministic work.
// It pre-checks eligibility (matching the pipe's cursor seed), then delegates
// to runDrainPipe. A skipped result is data for the mission agent, not an
// automatic decline: the agent must call mission_result.
//
// Loaded via relative import only.
import type { DrainConfig } from "./config.ts"
import type { DrainLedger } from "./ledger.ts"
import {
  formatDrainResult,
  runDrainPipe,
  type DrainPipeClient,
  type DrainPipeResult,
} from "./pipe.ts"
import { readDrainStatus, type DrainSkipReason } from "./status.ts"
import type { MemoryProvider } from "../memory/types.ts"

export type DrainToolResult = {
  status: "completed" | "skipped"
  reason: DrainSkipReason | "nothing" | null
  outcome: DrainPipeResult["outcome"] | null
  summary: string
  tokens: number
  /** Writer child session: the consolidation transcript. */
  session: string | null
  cursor_before: number | null
  cursor_after: number | null
  sessions: number
  items: number
  error?: string
}

/** Parse a tool output/transcript value back into the typed result. */
export function parseDrainToolOutput(value: unknown): DrainToolResult | null {
  let raw: unknown = value
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  let o = raw as Record<string, unknown>
  if (o.status !== "completed" && o.status !== "skipped") {
    // Some tool transports wrap the returned value under `output`/`result`.
    const nested = o.output ?? o.result
    if (nested === undefined || nested === raw) return null
    return parseDrainToolOutput(nested)
  }
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  return {
    status: o.status,
    reason: (typeof o.reason === "string" ? o.reason : null) as DrainToolResult["reason"],
    outcome: (typeof o.outcome === "string" ? o.outcome : null) as DrainToolResult["outcome"],
    summary: typeof o.summary === "string" ? o.summary : "",
    tokens: num(o.tokens),
    session: typeof o.session === "string" ? o.session : null,
    cursor_before: typeof o.cursor_before === "number" ? o.cursor_before : null,
    cursor_after: typeof o.cursor_after === "number" ? o.cursor_after : null,
    sessions: num(o.sessions),
    items: num(o.items),
    ...(typeof o.error === "string" ? { error: o.error } : {}),
  }
}

/** Last `drain_run` tool result in a message array, or null. */
export function findDrainToolResult(messages: unknown[]): DrainToolResult | null {
  let found: DrainToolResult | null = null
  for (const row of messages ?? []) {
    const parts = (row as { parts?: unknown })?.parts
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (!part || typeof part !== "object") continue
      const p = part as Record<string, any>
      if (p.type !== "tool" || p.tool !== "drain_run") continue
      const parsed = parseDrainToolOutput(p.state?.output ?? p.state?.input)
      if (parsed) found = parsed
    }
  }
  return found
}

export type DrainToolDeps = {
  directory: string
  stateDir: string
  vaultDir: string
  config: DrainConfig
  client: DrainPipeClient
  provider?: MemoryProvider
  waitForIdle: (sessionID: string) => Promise<boolean>
  registerChild?: (sessionID: string) => void
  dbFile?: string
  ledger?: DrainLedger
  now?: number
  onWarn?: (message: string, err?: unknown) => void
}

/**
 * Run one drain. Never throws: an unexpected failure is reported as a
 * completed/error result so the mission agent can call mission_result(error).
 */
export async function runDrainForMission(deps: DrainToolDeps): Promise<DrainToolResult> {
  const status = await readDrainStatus({
    directory: deps.directory,
    stateDir: deps.stateDir,
    config: deps.config,
    provider: deps.provider,
    dbFile: deps.dbFile,
    now: deps.now,
  })

  if (status.reason) {
    return {
      status: "skipped",
      reason: status.reason,
      outcome: null,
      summary: `drain:${status.reason}`,
      tokens: 0,
      session: null,
      cursor_before: null,
      cursor_after: null,
      sessions: 0,
      items: 0,
      ...(status.error ? { error: status.error } : {}),
    }
  }

  try {
    const result = await runDrainPipe({
      directory: deps.directory,
      stateDir: deps.stateDir,
      vaultDir: deps.vaultDir,
      config: deps.config,
      client: deps.client,
      provider: deps.provider,
      waitForIdle: deps.waitForIdle,
      registerChild: deps.registerChild,
      dbFile: deps.dbFile,
      ledger: deps.ledger,
      trigger: "tool",
      onWarn: deps.onWarn,
    })
    // §2.4: the pipe is try-only on drain.lock — a held lock is a clean skip
    // for the mission (roll-mission), never a wait.
    if (result.lockHeld) {
      return {
        status: "skipped",
        reason: "lock-held",
        outcome: null,
        summary: "drain:lock-held",
        tokens: 0,
        session: null,
        cursor_before: result.cursorBefore,
        cursor_after: result.cursorAfter,
        sessions: 0,
        items: 0,
      }
    }
    return {
      status: "completed",
      reason: result.outcome === "nothing" ? "nothing" : null,
      outcome: result.outcome,
      summary: formatDrainResult(result),
      tokens: result.tokens ?? 0,
      session: result.session ?? null,
      cursor_before: result.cursorBefore,
      cursor_after: result.cursorAfter,
      sessions: result.sessions,
      items: result.items,
      ...(result.error ? { error: result.error } : {}),
    }
  } catch (err) {
    deps.onWarn?.("drain tool: pipe failed", err)
    return {
      status: "completed",
      reason: null,
      outcome: "error",
      summary: "drain:error",
      tokens: 0,
      session: null,
      cursor_before: null,
      cursor_after: null,
      sessions: 0,
      items: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
