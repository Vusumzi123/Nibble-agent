// Vault staleness scan: the oldest refreshable reference note by `updated:`.
//
// The staleness mission is gated on real note age, not on mtime: a note whose
// frontmatter says `updated: 2026-08-05` is stale even if something touched
// its bytes yesterday. Only `type: reference` notes count — logs, journals,
// drafts, and historical meta notes are not part of the refresh sweep.
//
// Read-only and fail-open: an unreadable vault or note yields `null`, never a
// throw. Loaded via relative import only (the plugin auto-discovery glob is
// non-recursive).
import { readFile, readdir } from "node:fs/promises"
import { basename, join, relative } from "node:path"

export type BrainNoteAge = {
  /** Vault-relative path with POSIX separators. */
  path: string
  title: string
  /** Raw `updated:` value from the frontmatter. */
  updated: string
  /** Whole hours since the updated date (0 when in the future). */
  ageHours: number
}

/** Default gate: the oldest reference note must be at least 30 days old. */
export const DEFAULT_BRAIN_STALE_HOURS = 30 * 24

/** Directories never scanned, even if the vault policy names others. */
const ALWAYS_SKIP_DIRS = new Set([".obsidian", ".trash", ".markdown_vault_mcp", ".git"])

/** Parse a frontmatter `updated:` value (date or ISO datetime) to UTC ms. */
export function parseUpdatedDate(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(value.trim())
  if (!m) return null
  const year = parseInt(m[1], 10)
  const month = parseInt(m[2], 10)
  const day = parseInt(m[3], 10)
  const ms = Date.UTC(year, month - 1, day)
  const d = new Date(ms)
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null
  }
  return ms
}

/** Extract the first frontmatter block's flat `key: value` fields. */
function frontmatterFields(text: string): Record<string, string> {
  const m = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(text)
  if (!m) return {}
  const out: Record<string, string> = {}
  for (const line of m[1].split("\n")) {
    const field = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (!field) continue
    const value = field[2].trim().replace(/^["']|["']$/g, "")
    if (value) out[field[1]] = value
  }
  return out
}

function isExcluded(rel: string, excludeDirs: readonly string[]): boolean {
  return excludeDirs.some((d) => rel === d || rel.startsWith(d + "/"))
}

export type OldestNoteOpts = {
  nowMs?: number
  /** Vault-relative directories to skip (readonly zones from the vault policy). */
  excludeDirs?: readonly string[]
}

/**
 * Scan the vault for notes with `type: reference` and return the one whose
 * `updated:` date is oldest. Ties break on the path so the signal is stable.
 * Returns null when no eligible note carries a valid date.
 */
export async function oldestReferenceNote(
  vaultDir: string,
  opts: OldestNoteOpts = {},
): Promise<BrainNoteAge | null> {
  const nowMs = opts.nowMs ?? Date.now()
  const excludeDirs = opts.excludeDirs ?? []
  let oldest: { note: BrainNoteAge; ms: number } | null = null

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      const rel = relative(vaultDir, full).replace(/\\/g, "/")
      if (entry.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue
        if (isExcluded(rel, excludeDirs)) continue
        await walk(full)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue
      if (isExcluded(rel, excludeDirs)) continue

      let text: string
      try {
        text = await readFile(full, "utf8")
      } catch {
        continue
      }
      const fields = frontmatterFields(text)
      if ((fields.type ?? "").toLowerCase() !== "reference") continue
      const ms = parseUpdatedDate(fields.updated ?? "")
      if (ms === null) continue

      const note: BrainNoteAge = {
        path: rel,
        title: fields.title || basename(entry.name, ".md"),
        updated: fields.updated,
        ageHours: Math.max(0, (nowMs - ms) / 3_600_000),
      }
      if (!oldest || ms < oldest.ms || (ms === oldest.ms && note.path < oldest.note.path)) {
        oldest = { note, ms }
      }
    }
  }

  await walk(vaultDir)
  return oldest?.note ?? null
}
