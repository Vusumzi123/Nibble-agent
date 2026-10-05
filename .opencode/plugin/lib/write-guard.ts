// Pure, testable helpers for the deterministic post-write guard. Extracted from
// wikilink-guard.ts so the escape/date/bullet checks can be unit-tested without
// a live opencode client, and so the guard's coverage of the former rag-brain
// re-read mandate is explicit and provable.
//
// Three serializer symptoms are handled:
//   1. escaped wikilinks  `[[Note]]` -> `\[\[Note]]`          (repairable)
//   2. mangled dates       `2026-08-04T00:00:00.000Z` / quoted (repairable,
//                          only for unambiguous, valid created/updated dates)
//   3. bullet rewrites     `- x` -> `* x`                      (repairable only
//                          when a before/after diff proves it is marker-only)
//
// Code regions (fenced blocks and inline code) are masked before any check, so
// intentional escaped wikilinks or `*` bullets inside documentation examples are
// never "repaired". Invalid or ambiguous dates are left untouched and reported.
import { basename, isAbsolute, join, relative } from "node:path"

// ---------------------------------------------------------------------------
// Code masking

export type Masked = { work: string; restore: (text: string) => string }

export function maskCode(text: string): Masked {
  const masked: Array<{ key: string; value: string }> = []
  let n = 0
  const mask = (m: string): string => {
    const key = `\u0000${n++}\u0000`
    masked.push({ key, value: m })
    return key
  }
  let work = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, mask)
  work = work.replace(/`[^`\n]*`/g, mask)
  return {
    work,
    restore: (out: string) => {
      let restored = out
      for (const { key, value } of masked) restored = restored.replace(key, () => value)
      return restored
    },
  }
}

// ---------------------------------------------------------------------------
// Escaped wikilinks

const ESCAPED_OPEN = /\\\[\\\[/g
const ESCAPED_CLOSE = /\\\]\\\]/g

export function unescapeOutsideCode(text: string): { out: string; count: number } {
  const { work, restore } = maskCode(text)
  const open = (work.match(ESCAPED_OPEN) ?? []).length
  const close = (work.match(ESCAPED_CLOSE) ?? []).length
  if (open + close === 0) return { out: text, count: 0 }
  const out = restore(work.replace(ESCAPED_OPEN, "[[").replace(ESCAPED_CLOSE, "]]"))
  return { out, count: open + close }
}

// ---------------------------------------------------------------------------
// Frontmatter date normalization

const FRONTMATTER_RE = /^(---\s*\n)([\s\S]*?)(\n---\s*(?:\n|$))/
// A valid `created:`/`updated:` value that is quoted and/or carries a time
// component. A plain `2026-08-05` is already canonical and left alone.
const DATE_LINE_RE = /^(\s*(?:created|updated):\s*)(.*?)(\s*)$/
const VALID_DATE = /(\d{4})-(\d{2})-(\d{2})/

function isValidYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

export type DateFix = { out: string; fixed: number; invalid: number }

export function normalizeFrontmatterDates(text: string): DateFix {
  const m = FRONTMATTER_RE.exec(text)
  if (!m) return { out: text, fixed: 0, invalid: 0 }

  let fixed = 0
  let invalid = 0
  const body = m[2]
    .split("\n")
    .map((line) => {
      const lm = DATE_LINE_RE.exec(line)
      if (!lm) return line
      const rawValue = lm[2].trim()
      if (rawValue === "") return line
      const unquoted = rawValue.replace(/^['"]|['"]$/g, "")
      const dm = VALID_DATE.exec(unquoted)
      if (!dm) {
        invalid++
        return line
      }
      const [, y, mo, d] = dm
      if (!isValidYmd(Number(y), Number(mo), Number(d))) {
        invalid++
        return line
      }
      const canonical = `${y}-${mo}-${d}`
      // Fix only when the value is not already the canonical plain date.
      if (unquoted === canonical && rawValue === canonical) return line
      fixed++
      return `${lm[1]}${canonical}`
    })
    .join("\n")

  if (fixed === 0) return { out: text, fixed: 0, invalid }
  return { out: m[1] + body + m[3], fixed, invalid }
}

// ---------------------------------------------------------------------------
// Bullet rewrites (before/after diff)

export type BulletDiff =
  | { kind: "none"; repaired: string; count: 0 }
  | { kind: "safe"; repaired: string; count: number }
  | { kind: "ambiguous"; repaired: null; count: number }

const DASH_BULLET = /^(\s*)-(\s.*)?$/
const STAR_AT_SAME_TEXT = /^(\s*)\*(\s.*)?$/

// Compare a pre-write snapshot to the post-write bytes. A marker-only diff
// (`-` -> `*` with identical trailing text, same line count) is unambiguously a
// serializer artifact and is restored. Anything else is reported as ambiguous
// rather than guessed at, so an intentional `*` bullet (or a real content edit)
// is never clobbered.
export function diffBulletRewrites(before: string, after: string): BulletDiff {
  if (before === after) return { kind: "none", repaired: after, count: 0 }
  const b = before.split("\n")
  const a = after.split("\n")
  if (b.length !== a.length) return { kind: "ambiguous", repaired: null, count: 0 }

  const restored = [...a]
  let markerOnly = 0
  let otherChanges = 0
  for (let i = 0; i < a.length; i++) {
    if (b[i] === a[i]) continue
    const bm = DASH_BULLET.exec(b[i])
    const am = STAR_AT_SAME_TEXT.exec(a[i])
    if (bm && am && bm[1] === am[1] && (bm[2] ?? "") === (am[2] ?? "")) {
      markerOnly++
      restored[i] = b[i]
    } else {
      otherChanges++
    }
  }
  if (otherChanges > 0) return { kind: "ambiguous", repaired: null, count: markerOnly }
  if (markerOnly === 0) return { kind: "none", repaired: after, count: 0 }
  return { kind: "safe", repaired: restored.join("\n"), count: markerOnly }
}

// ---------------------------------------------------------------------------
// Write-target path extraction (drives before/after snapshots)

export type WriteAction = { path: string; action: string; before: string | null }

const WRITE_ACTIONS = new Set(["create", "update", "delete", "create_from_template"])

// Pull the target file paths out of a tool invocation. Covers native
// edit/write, apply_patch patchText (add/update/move/delete), and the
// markdown-vault MCP vault tool. Returns absolute paths.
export function extractWritePaths(
  tool: string,
  args: Record<string, unknown>,
  vaultRoot: string,
): string[] {
  const out: string[] = []
  const push = (p: unknown): void => {
    if (typeof p === "string" && p.trim()) out.push(p)
  }

  if (tool === "edit" || tool === "write") {
    push(args.filePath ?? args.file_path)
    return out
  }

  if (tool === "apply_patch") {
    const patch = typeof args.patchText === "string" ? args.patchText : typeof args.patch === "string" ? args.patch : ""
    for (const line of patch.split("\n")) {
      const m = /^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+?)\s*$/.exec(line)
      if (m) push(m[1])
      const mv = /^\*\*\*\s+Move\s+to:\s*(.+?)\s*$/.exec(line)
      if (mv) push(mv[1])
    }
    return out
  }

  if (tool === "markdown-vault_vault") {
    const rel = args.path
    const action = typeof args.action === "string" ? args.action : ""
    const isWrite = WRITE_ACTIONS.has(action)
    if (isWrite && typeof rel === "string") {
      out.push(isAbsolute(rel) ? rel : join(vaultRoot, rel))
    }
    return out
  }

  if (tool === "markdown-vault_edit") {
    // Denied for rag-brain, but still guarded if it ever runs elsewhere.
    const rel = args.path ?? args.filePath
    if (typeof rel === "string") out.push(isAbsolute(rel) ? rel : join(vaultRoot, rel))
    return out
  }

  return out
}

// Map any extracted path to a vault-relative label (for diagnostics).
export function vaultLabel(vaultRoot: string, p: string): string {
  if (p === vaultRoot || p.startsWith(vaultRoot + "/")) return relative(vaultRoot, p) || basename(p)
  return p
}
