// Memory provider contract (docs/knowledge-memory-modularization.md §2).
//
// The core (retrieval directive, drain pipe, heartbeat candidacy, tools,
// permissions) talks to exactly one active MemoryProvider. A provider owns its
// read plan, writer, pending count, search, tools, and the agents it guards.
//
// Loaded via relative import only.
import type { DrainConfig } from "../drain/config.ts"

export type MemoryProfile = "both" | "rag-brain" | "memory-explorer" | "none"

export type MemoryReadRequest = {
  query: string
  mode: "relevance" | "recency"
}

export type WriteItem = {
  title: string
  summary: string
  tags: string[]
  atoms: string[]
}

/**
 * The only cursor contract. The pipe advances only when `ok` and either
 * `atomic` or every item is reported exactly once across `consumed`/`skipped`.
 * `transient` errors back off without poisoning; `permanent` errors count
 * toward the poison threshold.
 */
export type WriteReport = {
  ok: boolean
  /** Item indices (1-based, matching the prompt labels) fully consumed. */
  consumed: number[]
  /** Item indices deliberately skipped by the writer. */
  skipped: number[]
  /** A provider that extracted/wrote the whole batch atomically. */
  atomic?: boolean
  errorKind?: "transient" | "permanent"
  detail?: string
  /** Optional telemetry for the drain ledger. */
  tokens?: number | null
  cost?: number | null
  promptBytes?: number | null
  session?: string | null
}

export type MemoryEvidence = {
  session: string
  time: string
  time_ms: number
  role: string
  excerpt: string
  score: number
}

/** Minimal writer client surface (the opencode SDK session subset). */
export type MemoryWriteClient = {
  session: {
    create(args: any): Promise<{ data?: { id?: string } }>
    promptAsync(args: any): Promise<{ error?: unknown; response?: { ok?: boolean } }>
    messages(args: any): Promise<{ data?: any }>
  }
}

export type WriteContext = {
  directory: string
  vaultDir: string
  config: DrainConfig
  client: MemoryWriteClient
  waitForIdle: (sessionID: string) => Promise<boolean>
  registerChild?: (sessionID: string) => void
  onWarn?: (message: string, err?: unknown) => void
  dbFile?: string
  /** Renderings + item text used for deterministic candidate prefetch. */
  searchText?: string
}

/**
 * The opencode `tool` helper (has `.schema` and wraps a definition). Providers
 * receive it so their tool specs stay free of a hard plugin dependency in unit
 * tests.
 */
export type MemoryToolFactory = any

export interface MemoryProvider {
  id: MemoryProfile
  capabilities: {
    read: boolean
    write: boolean
    searchTool: boolean
  }
  /** Agent names this provider owns (memory guard + SUBAGENT_TIERS). */
  agents: string[]
  /** Prose injected into the retrieval directive; null → memory disabled. */
  readPlan(req?: MemoryReadRequest): string | null
  /** In-process search for a tool or dream seed. */
  search?(req: {
    query: string
    topK: number
    since?: number
    session?: string
    tags?: string[]
  }): Promise<MemoryEvidence[]>
  /** Drain sink. Only one active writer is allowed. */
  consolidate?(items: WriteItem[], ctx: WriteContext): Promise<WriteReport>
  /** Un-consolidated count for `turns-pending`. */
  pending?(): Promise<number>
  /** Tool definitions; the generic memory hook registers them. */
  tools?(factory?: MemoryToolFactory): Record<string, unknown>
  /** Recent-turn dream seed; null → mood fallback. */
  seed?(): Promise<string | null>
  health(): Promise<{ ok: boolean; detail?: string }>
}
