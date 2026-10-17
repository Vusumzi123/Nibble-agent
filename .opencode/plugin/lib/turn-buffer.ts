// Read-only accessor for the project-local conversation-turn buffer
// (.opencode/state/memory.json).
//
// The buffer used to be written by the retired knowledge-hook (capture) and
// consumed by its consolidation drain. Two surviving consumers still read it:
// heartbeat.ts (un-consumed turn count signal) and dream-hook.ts (most-recent
// turn as a dream seed). This module deliberately exposes READ ONLY — the
// write/prune/search half of the old lib/temporal.ts went with the hook.
//
// The on-disk format is a single JSON array of entries; a legacy JSON Lines
// buffer is still accepted. A missing or malformed document yields [].
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.
import { join } from "node:path"
import { atomicRead } from "./fsx.ts"

// One captured conversation turn. Only the fields the surviving readers use are
// typed here; unknown extra fields are tolerated on parse.
export type MemoryEntry = {
  seq: number
  session: string
  ts: string
  user: string
  assistant: string
  tags: string[]
  salience: number | null
  newTag: string | null
  hash: string
  attempts?: number
}

function coerceEntry(o: unknown): MemoryEntry | null {
  if (typeof o !== "object" || o === null) return null
  const r = o as Record<string, unknown>
  if (
    typeof r.seq !== "number" ||
    !Number.isFinite(r.seq) ||
    typeof r.session !== "string" ||
    typeof r.user !== "string" ||
    typeof r.assistant !== "string"
  ) {
    return null
  }
  return {
    seq: r.seq,
    session: r.session,
    ts: typeof r.ts === "string" ? r.ts : "",
    user: r.user,
    assistant: r.assistant,
    tags: Array.isArray(r.tags) ? (r.tags as unknown[]).filter((t): t is string => typeof t === "string") : [],
    salience: typeof r.salience === "number" ? r.salience : null,
    newTag: typeof r.newTag === "string" ? r.newTag : null,
    hash: typeof r.hash === "string" ? r.hash : "",
    ...(typeof r.attempts === "number" && Number.isFinite(r.attempts) && r.attempts > 0
      ? { attempts: Math.floor(r.attempts) }
      : {}),
  }
}

// Parse a memory document into entries. A single JSON array is the on-disk
// format; a legacy JSON Lines buffer is still accepted. A malformed document or
// a malformed entry is skipped, never fatal.
export function parseMemory(content: string): MemoryEntry[] {
  const trimmed = content.trim()
  if (!trimmed) return []

  const out: MemoryEntry[] = []
  if (trimmed.startsWith("[")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return []
    }
    if (!Array.isArray(parsed)) return []
    for (const item of parsed) {
      const entry = coerceEntry(item)
      if (entry) out.push(entry)
    }
    return out
  }

  for (const line of trimmed.split("\n")) {
    const t = line.trim()
    if (!t) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(t)
    } catch {
      continue
    }
    const entry = coerceEntry(parsed)
    if (entry) out.push(entry)
  }
  return out
}

// Read + parse the buffer (missing file -> []).
export async function readMemory(memoryFile: string): Promise<MemoryEntry[]> {
  return parseMemory(await atomicRead(memoryFile))
}

// Resolve the buffer leaf against the project state root. An absolute
// `memory_file` override is honored when supplied, else the default name.
export function resolveMemoryFile(stateDir: string, leaf = "memory.json"): string {
  return leaf.startsWith("/") ? leaf : join(stateDir, leaf)
}
