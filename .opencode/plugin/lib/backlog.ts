// Backlog queue module (kanban card 3, docs/autonomy-harness-plan.md §5).
//
// Canonical machine queue at <state>/backlog.ndjson (one JSON object per line,
// append-safe) plus a one-way derived human view at <vault>/Backlog.md. The
// deterministic heartbeat pre-gate (card 4) needs a cheap countable format; the
// Brain needs markdown — so NDJSON is the source of truth and the .md is a
// projection, never hand-edited (the same pattern as memory.json → notes).
//
// Status transitions are atomic per entry: every mutation goes through
// fsx.atomicUpdate (per-file in-process queue + same-dir rename), so a single
// writer can append/mutate without losing an update. The single-writer
// discipline is the plugin's job (this lib is the only writer of the queue).
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.
import { randomBytes } from "node:crypto"
import { isAbsolute, join } from "node:path"
import { parseFlatBlock, readSection, sectionCoercer } from "./config.ts"
import { atomicRead, atomicUpdate, atomicWrite } from "./fsx.ts"
import { nowIso } from "./util.ts"

// ---------------------------------------------------------------------------
// Config (flat `backlog:` block — mirrors the `knowledge:` reader shape)

export type BacklogConfig = {
  enabled: boolean
  /** LEAF under <state> — e.g. .opencode/state/backlog.ndjson. */
  file: string
  /** LEAF under <vault> — e.g. Brain/Backlog.md. */
  view_file: string
  /** Skip appending a duplicate OPEN entry (same source + normalized title). */
  dedupe: boolean
  /** Max entries rendered per status section in the derived view. */
  max_view: number
}

export const DEFAULT_CONFIG: BacklogConfig = {
  enabled: true,
  file: "backlog.ndjson",
  view_file: "Backlog.md",
  dedupe: true,
  max_view: 200,
}

const KNOWN_KEYS = new Set(Object.keys(DEFAULT_CONFIG))

// `backlog:` infers the type from the value (any key may be a bool/int) and
// accepts signed integers — same coercion as the `knowledge:` block.
const BACKLOG_COERCE = sectionCoercer({ valueTyped: true, intPattern: /^-?\d+$/ })

export function parseBacklogConfig(yamlText: string): Partial<BacklogConfig> {
  return parseFlatBlock(yamlText, "backlog", {
    knownKeys: KNOWN_KEYS,
    coerce: BACKLOG_COERCE,
  }) as Partial<BacklogConfig>
}

// Read the effective `backlog:` config for a project directory. Never throws:
// a missing/malformed block yields the defaults.
export async function readBacklogConfig(directory: string): Promise<BacklogConfig> {
  return readSection(directory, "backlog", DEFAULT_CONFIG, { coerce: BACKLOG_COERCE })
}

function resolveLeaf(root: string, leaf: string): string {
  return isAbsolute(leaf) ? leaf : join(root, leaf)
}

export function resolveBacklogFile(stateDir: string, config: BacklogConfig): string {
  return resolveLeaf(stateDir, config.file)
}

export function resolveViewFile(vaultDir: string, config: BacklogConfig): string {
  return resolveLeaf(vaultDir, config.view_file)
}

// ---------------------------------------------------------------------------
// Entry schema (plan §5.2, finalised for B4)
//
// Core fields are stable from day one; the `channel_notified` / `jev_decision`
// / `result` / `view_ref` fields are RESERVED (null until the comms bridge,
// JEV/result, and dashboard-diff phases populate them) so the NDJSON shape
// never re-migrates across phases.

export type BacklogStatus =
  | "pending"
  | "notified"
  | "approved"
  | "rejected"
  | "done"
  | "failed"
  | "dropped"

export type BacklogSource =
  | "conversation"
  | "heartbeat"
  | "idea-hook"
  | "dashboard"
  | "comm-reply"

export type BacklogKind =
  | "task"
  | "idea"
  | "approval"
  | "notify"
  | "self-improve"
  | "mail-reply"

export type BacklogPayload = {
  title: string
  detail: string
  commands: string[]
  files: string[]
}

export type ChannelNotified = { channel: string; ts: string; message_id: string }
export type JevDecision = { verdict: string; ts: string; reason: string }
export type BacklogResult = { ok: boolean; summary: string; ts: string; token_cost: number }

export type BacklogEntry = {
  id: string
  created: string
  updated: string
  source: BacklogSource
  kind: BacklogKind
  payload: BacklogPayload
  /** Minimum autonomy level to auto-execute solo (plan §5.2). */
  level_required: number
  /** Higher first; tiebreak `created` ascending. */
  priority: number
  status: BacklogStatus
  channel_notified: ChannelNotified | null
  awaiting_reply: boolean
  jev_decision: JevDecision | null
  result: BacklogResult | null
  view_ref: string | null
  links: string[]
}

// A producer supplies a draft; append() fills id/created/updated/status and the
// reserved fields.
export type BacklogDraft = {
  source: BacklogSource
  kind: BacklogKind
  payload: { title: string; detail?: string; commands?: string[]; files?: string[] }
  level_required?: number
  priority?: number
  links?: string[]
}

// ---------------------------------------------------------------------------
// Id + dedupe helpers (deterministic, exported for tests)

export function newBacklogId(now: number = Date.now()): string {
  return `bl-${now.toString(36)}-${randomBytes(3).toString("hex")}`
}

export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase()
}

export function dedupeKey(source: string, title: string): string {
  return `${source}:${normalizeTitle(title)}`
}

export const OPEN_STATUSES: ReadonlySet<BacklogStatus> = new Set([
  "pending",
  "notified",
  "approved",
])

export const BACKLOG_KINDS: ReadonlySet<BacklogKind> = new Set([
  "task",
  "idea",
  "approval",
  "notify",
  "self-improve",
  "mail-reply",
])

export function normalizeKind(raw: unknown): BacklogKind {
  return typeof raw === "string" && BACKLOG_KINDS.has(raw as BacklogKind)
    ? (raw as BacklogKind)
    : "task"
}

export function findOpenDuplicate(
  entries: BacklogEntry[],
  source: string,
  title: string,
): BacklogEntry | undefined {
  const key = dedupeKey(source, title)
  return entries.find(
    (e) => OPEN_STATUSES.has(e.status) && dedupeKey(e.source, e.payload.title) === key,
  )
}

// ---------------------------------------------------------------------------
// NDJSON parse/serialize (tolerant: blank + malformed lines are skipped)

export function parseNdjsonEntries(text: string): BacklogEntry[] {
  const out: BacklogEntry[] = []
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t) as BacklogEntry)
    } catch {
      // skip a malformed line — fail-open, never throw into a turn
    }
  }
  return out
}

export function serializeEntries(entries: BacklogEntry[]): string {
  return entries.length ? entries.map((e) => JSON.stringify(e)).join("\n") + "\n" : ""
}

function appendLine(current: string, entry: BacklogEntry): string {
  const line = JSON.stringify(entry)
  if (current === "") return line + "\n"
  return current.endsWith("\n") ? current + line + "\n" : current + "\n" + line + "\n"
}

// ---------------------------------------------------------------------------
// Reader

export async function readAll(file: string): Promise<BacklogEntry[]> {
  return parseNdjsonEntries(await atomicRead(file))
}

export type ListFilter = {
  status?: BacklogStatus
  statuses?: BacklogStatus[]
  /** Keep only entries whose level_required <= maxLevel (the pre-gate signal). */
  maxLevel?: number
}

// Stable deterministic order: priority desc, then created asc.
export function sortEntries(entries: BacklogEntry[]): BacklogEntry[] {
  return [...entries].sort(
    (a, b) =>
      b.priority - a.priority ||
      (a.created < b.created ? -1 : a.created > b.created ? 1 : 0),
  )
}

export async function list(file: string, filter: ListFilter = {}): Promise<BacklogEntry[]> {
  let entries = sortEntries(await readAll(file))
  if (filter.status !== undefined) entries = entries.filter((e) => e.status === filter.status)
  if (filter.statuses !== undefined) {
    const s = new Set(filter.statuses)
    entries = entries.filter((e) => s.has(e.status))
  }
  if (filter.maxLevel !== undefined) {
    const maxLevel = filter.maxLevel
    entries = entries.filter((e) => e.level_required <= maxLevel)
  }
  return entries
}

// Cheap deterministic "is there work at or below this level?" — the heartbeat
// pre-gate signal. Parses (no LLM); at backlog scale this is effectively free.
export async function pendingCount(file: string, maxLevel?: number): Promise<number> {
  const entries = await readAll(file)
  return entries.filter(
    (e) => e.status === "pending" && (maxLevel === undefined || e.level_required <= maxLevel),
  ).length
}

// ---------------------------------------------------------------------------
// Writer

export type AppendResult = { entry: BacklogEntry; created: boolean }

export function buildEntry(draft: BacklogDraft): BacklogEntry {
  const now = nowIso()
  return {
    id: newBacklogId(),
    created: now,
    updated: now,
    source: draft.source,
    kind: draft.kind,
    payload: {
      title: draft.payload.title,
      detail: draft.payload.detail ?? "",
      commands: draft.payload.commands ?? [],
      files: draft.payload.files ?? [],
    },
    level_required: draft.level_required ?? 0,
    priority: draft.priority ?? 0,
    status: "pending",
    channel_notified: null,
    awaiting_reply: false,
    jev_decision: null,
    result: null,
    view_ref: null,
    links: draft.links ?? [],
  }
}

// Append one entry. Dedupes against OPEN entries by (source, normalized title)
// inside the atomic update unless `dedupe: false`. Returns the duplicate
// (created: false) when deduped, otherwise the appended entry (created: true).
export async function append(
  file: string,
  draft: BacklogDraft,
  opts: { dedupe?: boolean } = {},
): Promise<AppendResult> {
  const dedupe = opts.dedupe ?? true
  const built = buildEntry(draft)
  let result: AppendResult

  await atomicUpdate(file, (current) => {
    if (dedupe) {
      const dup = findOpenDuplicate(parseNdjsonEntries(current), draft.source, draft.payload.title)
      if (dup) {
        result = { entry: dup, created: false }
        return current
      }
    }
    result = { entry: built, created: true }
    return appendLine(current, built)
  })

  return result!
}

// Transition one entry's status (optionally patching reserved fields such as
// `result` / `jev_decision`), bumping `updated`. Atomic per entry. Returns the
// updated entry, or null when the id is unknown.
export async function setStatus(
  file: string,
  id: string,
  status: BacklogStatus,
  patch: Partial<BacklogEntry> = {},
): Promise<BacklogEntry | null> {
  let updated: BacklogEntry | null = null

  await atomicUpdate(file, (current) => {
    const entries = parseNdjsonEntries(current)
    let found = false
    const next = entries.map((e) => {
      if (e.id !== id) return e
      found = true
      const u = { ...e, ...patch, status, updated: nowIso() } as BacklogEntry
      updated = u
      return u
    })
    return found ? serializeEntries(next) : current
  })

  return updated
}

// ---------------------------------------------------------------------------
// Derived view (Brain/Backlog.md)

export const STATUS_ORDER: BacklogStatus[] = [
  "pending",
  "notified",
  "approved",
  "done",
  "rejected",
  "failed",
  "dropped",
]

export function statusHeading(status: BacklogStatus): string {
  return status[0].toUpperCase() + status.slice(1)
}

export function renderEntry(entry: BacklogEntry): string {
  const meta = [`id: ${entry.id}`]
  if (entry.level_required > 0) meta.push(`L${entry.level_required}`)
  meta.push(`priority ${entry.priority}`)
  const links = entry.links.map((l) => l.trim()).filter((l) => l !== "").join(" ")
  let line = `- [ ] **${entry.payload.title}** (${meta.join(", ")})`
  if (links) line += ` ${links}`
  const lines = [line]
  if (entry.payload.detail) lines.push(`  ${entry.payload.detail}`)
  return lines.join("\n")
}

export function renderMarkdown(
  entries: BacklogEntry[],
  opts: { maxView?: number } = {},
): string {
  const max = opts.maxView ?? Infinity
  const sorted = sortEntries(entries)

  const header = [
    "---",
    "title: Backlog",
    "tags: [backlog]",
    "type: generated",
    "---",
    "",
    "# Backlog",
    "",
    "> Auto-generated one-way from the canonical `.opencode/state/backlog.ndjson`. Do not edit by hand — edits are overwritten on the next write.",
    "",
  ]

  const sections: string[] = []
  for (const status of STATUS_ORDER) {
    const group = sorted.filter((e) => e.status === status)
    if (group.length === 0) continue
    sections.push(`## ${statusHeading(status)}`)
    sections.push("")
    for (const e of group.slice(0, max)) sections.push(renderEntry(e))
    if (group.length > max) sections.push(`… ${group.length - max} more ${status} item(s) hidden`)
    sections.push("")
  }
  if (sections.length === 0) sections.push("_No backlog items._", "")

  return [...header, ...sections].join("\n")
}

// Atomically (re)write the derived view from the given entries.
export async function writeView(
  viewFile: string,
  entries: BacklogEntry[],
  opts: { maxView?: number } = {},
): Promise<void> {
  await atomicWrite(viewFile, renderMarkdown(entries, opts))
}

// Read the queue and regenerate the view in one step (used after a mutation).
export async function refreshView(
  file: string,
  viewFile: string,
  opts: { maxView?: number } = {},
): Promise<void> {
  await writeView(viewFile, await readAll(file), opts)
}
