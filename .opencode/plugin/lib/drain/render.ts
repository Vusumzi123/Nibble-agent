// Deterministic session rendering + atom extraction for the drain pipe
// (knowledge-pipeline-redesign §A.4/§A.5).
//
// Turns are rendered chronologically as `## User` / `## Assistant` blocks, with
// the previous consolidated summary prepended for long-lived sessions. Nothing
// here calls a model: atoms (commands, paths, URLs, KEY=value, flags,
// filenames, decision sentences) are extracted verbatim so summarization can
// never silently drop them.
//
// Loaded via relative import only.
import { createHash } from "node:crypto"
import type { DrainTurn } from "./db.ts"
import { DURABLE_SIGNAL_PATTERNS, SIGNAL_PATTERNS } from "../transcript.ts"

export type RenderOptions = {
  /** Byte ceiling for the rendered delta (<= 0 = unlimited). */
  maxBytes?: number
  /** Previous consolidated summary for continuity. */
  priorSummary?: string | null
}

export type RenderedSession = {
  sessionID: string
  /** Rendered delta (prior summary first when supplied). */
  text: string
  /** Deterministic atoms extracted from the delta, verbatim. */
  atoms: string[]
  /** The turns that produced this render (report/cursor mapping). */
  turns: DrainTurn[]
  /** UTF-8 byte length of `text`. */
  bytes: number
}

const ATOM_LIMIT = 50

const COMMAND_RE =
  /^\s*(?:[$>]\s+)?(?:sudo\s+)?(?:systemctl|pacman|paru|yay|git|npm|pnpm|bun|python3?|pip|node|make|cmake|docker|podman|nix|flatpak|snap|ssh|gpg|mount|umount|chmod|chown|ln|cp|mv|rm|mkdir|cat|echo|grep|sed|awk|find|rg)\b/

const TOKEN_PATTERNS: Array<{ re: RegExp; group?: number }> = [
  { re: /\[\[[^\[\]]+\]\]/g },
  { re: /https?:\/\/[^\s)>\]]+/g },
  { re: /(?:^|[\s"'`(])((?:~|\.)?\/[\w.+~-][\w./+~-]{3,})/g, group: 1 },
  { re: /\b[A-Z][A-Z0-9_]{2,}=\S+/g },
  { re: /(?:^|\s)(--?[a-z][\w-]{1,})/g, group: 1 },
  { re: /\b[\w.-]+\.(?:md|ts|tsx|js|jsx|json|yaml|yml|toml|conf|service|sh|py|rs|go|cpp|h)\b/g },
]

function clampAtom(value: string): string {
  const flat = value.trim().replace(/\s+/g, " ")
  return flat.length > 200 ? flat.slice(0, 197) + "..." : flat
}

/**
 * Extract deterministic atoms from a rendered session. Order is first-seen;
 * duplicates are dropped; the result is capped at 50 entries.
 */
export function extractAtoms(text: string, limit = ATOM_LIMIT): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (value: string): void => {
    const atom = clampAtom(value)
    if (atom.length < 2 || seen.has(atom)) return
    seen.add(atom)
    out.push(atom)
  }

  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("```")) continue

    if (COMMAND_RE.test(trimmed)) push(trimmed)
    if (SIGNAL_PATTERNS.some((re) => re.test(trimmed)) && trimmed.length <= 200) push(trimmed)
    if (DURABLE_SIGNAL_PATTERNS.some((re) => re.test(trimmed))) push(trimmed)

    for (const { re, group } of TOKEN_PATTERNS) {
      for (const match of line.matchAll(re)) {
        push(group === undefined ? match[0] : (match[group] ?? ""))
      }
    }
  }

  return out.slice(0, Math.max(0, limit))
}

/**
 * Stable sha1 over the normalized (summary + atoms) pair, used to dedupe and
 * to identify items in the ledger.
 */
export function hashContent(summary: string, atoms: string[]): string {
  const normalized = [summary, ...atoms]
    .join("\n")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
  return createHash("sha1").update(normalized).digest("hex")
}

/** Cut a UTF-8 string at a byte ceiling without splitting a code point. */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  const buf = Buffer.from(text, "utf8")
  if (buf.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString("utf8")
}

function roleLabel(role: string): string {
  if (role === "user") return "User"
  if (role === "assistant") return "Assistant"
  const trimmed = role.trim()
  return trimmed ? trimmed[0].toUpperCase() + trimmed.slice(1) : "Turn"
}

function sortTurns(turns: DrainTurn[]): DrainTurn[] {
  return [...turns].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
}

/**
 * Render one session delta. Returns null when the delta has no non-empty text
 * (so the pipe never sends an empty item upstream).
 */
export function renderSession(
  sessionID: string,
  turns: DrainTurn[],
  opts: RenderOptions = {},
): RenderedSession | null {
  const sorted = sortTurns(turns)
  const blocks: Array<{ role: string; text: string }> = []

  for (const turn of sorted) {
    const text = turn.text.trim()
    if (!text) continue
    const role = turn.role || "turn"
    const last = blocks[blocks.length - 1]
    if (last && last.role === role) last.text += "\n\n" + text
    else blocks.push({ role, text })
  }

  if (blocks.length === 0) return null

  const delta = blocks.map((b) => `## ${roleLabel(b.role)}\n${b.text}`).join("\n\n")
  const atoms = extractAtoms(delta)
  const prior = opts.priorSummary?.trim()

  const composed = prior ? `## Prior summary\n${prior}\n\n${delta}` : delta
  const maxBytes = opts.maxBytes ?? 0
  const text = maxBytes > 0 ? truncateToBytes(composed, maxBytes) : composed

  return {
    sessionID,
    text,
    atoms,
    turns: sorted,
    bytes: Buffer.byteLength(text, "utf8"),
  }
}
