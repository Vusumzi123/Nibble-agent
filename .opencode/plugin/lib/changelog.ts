// Deterministic Brain vault changelog writer (knowledge-hook drain).
//
// The consolidation child no longer writes `meta/log.md` itself. Instead it
// reports its summary as a ```log fence, and this module appends the entry with
// the hook's own date and rolls the oldest entries into an out-of-vault NDJSON
// archive so `log.md` stays bounded/readable. `meta/log.md` remains the only
// vault file the hook writes. No LLM, no network, filesystem only.
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.
import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { atomicRead, atomicUpdate } from "./fsx.ts"

// One changelog entry: `## [date] op | title` followed by a 1–3 sentence body.
export type LogEntry = { date: string; op: string; title: string; body: string }

export type AppendChangelogResult = {
  appended: boolean
  /** Oldest entries moved to the archive this write. */
  archived: number
  /** True when rolling over the entry cap moved at least one entry. */
  rotated: boolean
}

// Parseable header line. `op` is one of consolidation|change|hygiene|
// reclassification and is captured as the first pipe-separated token.
const ENTRY_HEAD_RE = /^## \[(\d{4}-\d{2}-\d{2})\]\s+([^|\s]+)\s*\|\s*(.+?)\s*$/

// Renders one entry (no trailing newline; serializeLog owns separation).
export function renderEntry(entry: LogEntry): string {
  const title = entry.title.trim()
  const body = entry.body.trim()
  return body ? `## [${entry.date}] ${entry.op} | ${title}\n${body}` : `## [${entry.date}] ${entry.op} | ${title}`
}

// Split the file into the immutable head (frontmatter + intro prose, everything
// up to the first entry) and the parsed entries. Non-entry content that appears
// after the first entry stays attached to the preceding entry's body.
export function parseLog(text: string): { head: string; entries: LogEntry[] } {
  const lines = text.split("\n")
  let first = -1
  for (let i = 0; i < lines.length; i++) {
    if (ENTRY_HEAD_RE.test(lines[i])) {
      first = i
      break
    }
  }
  if (first === -1) {
    const head = text.replace(/\s+$/, "")
    return { head, entries: [] }
  }

  const head = lines.slice(0, first).join("\n").replace(/\s+$/, "")
  const entries: LogEntry[] = []
  let cur: LogEntry | null = null
  let bodyLines: string[] = []
  // A `## Related` section (a legacy artifact when the changelog was split out
  // of overview.md) is dropped — a changelog is chronological, not a note.
  let skippingRelated = false
  const flush = (): void => {
    if (cur) {
      cur.body = bodyLines.join("\n").trim()
      entries.push(cur)
    }
  }
  for (let i = first; i < lines.length; i++) {
    const m = lines[i].match(ENTRY_HEAD_RE)
    if (m) {
      flush()
      cur = { date: m[1], op: m[2], title: m[3], body: "" }
      bodyLines = []
      skippingRelated = false
    } else if (cur) {
      if (/^##\s+Related\s*$/.test(lines[i])) {
        skippingRelated = true
      } else if (!skippingRelated) {
        bodyLines.push(lines[i])
      }
    }
  }
  flush()
  return { head, entries }
}

export function serializeLog(head: string, entries: LogEntry[]): string {
  const parts: string[] = []
  if (head.trim()) parts.push(head.replace(/\s+$/, ""))
  for (const e of entries) parts.push(renderEntry(e))
  return parts.join("\n\n") + "\n"
}

// Bump the frontmatter `updated:` (and legacy `updated_at:`) date so the note
// follows the vault convention on every append.
export function bumpFrontmatterDate(head: string, date: string): string {
  const fm = head.match(/^---\n[\s\S]*?\n---/)
  if (!fm) return head
  const bumped = fm[0]
    .replace(/^(updated:\s*).*$/m, `$1${date}`)
    .replace(/^(updated_at:\s*).*$/m, `$1${date}`)
  return head.replace(fm[0], bumped)
}

// Minimal contract-compliant head for a changelog that does not exist yet
// (setup.sh seeds one; this is the runtime safety net).
export function defaultHead(date: string): string {
  return [
    "---",
    "title: Vault Changelog",
    "tags: [meta/log]",
    "type: log",
    `created: ${date}`,
    `updated: ${date}`,
    "status: in_progress",
    "managed_by: host",
    "---",
    "",
    "# Vault Changelog",
    "",
    "Append-only changelog of the vault. Newest entries last.",
    "Format: `## [YYYY-MM-DD] op | Short Title` — `op` ∈",
    "`consolidation | reclassification | hygiene | change`.",
  ].join("\n")
}

// Parse the drain child's ```log summary fence. Prefers a JSON object
// `{title, body}`; falls back to a `title:` line + the remaining lines as body.
export function parseLogSummary(reply: string): { title: string; body: string } | null {
  const raw = reply.match(/```log\s*\n([\s\S]*?)```/)?.[1]
  if (raw === undefined) return null
  const text = raw.trim()
  if (!text) return null

  try {
    const obj = JSON.parse(text)
    if (obj && typeof obj.title === "string" && obj.title.trim()) {
      return {
        title: obj.title.trim(),
        body: typeof obj.body === "string" ? obj.body.trim() : "",
      }
    }
  } catch {
    // not JSON — fall through to the line form
  }

  const lines = text.split("\n")
  const title = lines[0].replace(/^title:\s*/i, "").trim()
  if (!title) return null
  return { title: title.slice(0, 120), body: lines.slice(1).join("\n").trim() }
}

// Append one entry to the changelog and roll the oldest entries past the cap
// into the archive. Atomic per-file (serialized read-modify-write).
export async function appendChangelog(
  logPath: string,
  entry: LogEntry,
  opts: { maxEntries: number; archiveFile: string },
): Promise<AppendChangelogResult> {
  let archived = 0
  let rotated = false
  let overflow: LogEntry[] = []

  await atomicUpdate(logPath, (current) => {
    const parsed = current.trim() ? parseLog(current) : { head: defaultHead(entry.date), entries: [] }
    const entries = [...parsed.entries, entry]
    const max = opts.maxEntries
    if (max > 0 && entries.length > max) {
      overflow = entries.splice(0, entries.length - max)
      rotated = true
      archived = overflow.length
    }
    const head = bumpFrontmatterDate(parsed.head, entry.date)
    return serializeLog(head, entries)
  })

  if (overflow.length > 0) {
    await appendArchive(opts.archiveFile, overflow).catch(() => {})
  }
  return { appended: true, archived, rotated }
}

// Append rolled-off entries to the out-of-vault NDJSON archive (one JSON object
// per line), matching the state-dir convention (memory.json, backlog.ndjson).
export async function appendArchive(file: string, entries: LogEntry[]): Promise<void> {
  if (entries.length === 0) return
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8")
}

// Read the archive back (used by tests and any future tooling).
export async function readArchive(file: string): Promise<LogEntry[]> {
  const text = await atomicRead(file)
  const out: LogEntry[] = []
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (!t) continue
    try {
      const obj = JSON.parse(t)
      if (obj && typeof obj.date === "string" && typeof obj.title === "string") {
        out.push({ date: obj.date, op: obj.op ?? "consolidation", title: obj.title, body: obj.body ?? "" })
      }
    } catch {
      // skip a malformed line — the archive is cold storage
    }
  }
  return out
}
