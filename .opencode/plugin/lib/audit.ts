// Audit-trail domain logic, ported 1:1 from the retired `audit-logger.py`.
// Kept separate from the generic logger so the security-sensitive pieces —
// secret redaction and entry coercion/normalization — stay explicit and
// unit-testable. Rotation, compression, and retention are handled by the shared
// engine (lib/logfile.ts) via the `audit:` section's config.
import { parseFlatBlock, readSection, sectionCoercer } from "./config.ts"
import { asBool, nowIso } from "./util.ts"

export type AuditConfig = {
  enabled: boolean
  log: string
  rotate_bytes: number
  keep_generations: number
  retention_days: number
  compress: boolean
  compress_after: number
  compress_level: number
  rotate_by: string
}

export const DEFAULT_AUDIT: AuditConfig = {
  enabled: true,
  log: "audit.log",
  rotate_bytes: 10 * 1024 * 1024,
  keep_generations: 5,
  retention_days: 90,
  compress: true,
  compress_after: 1,
  compress_level: 6,
  rotate_by: "size",
}

const KNOWN_KEYS = new Set(Object.keys(DEFAULT_AUDIT))
const BOOL_KEYS = new Set(["enabled", "compress"])
const INT_KEYS = new Set([
  "rotate_bytes",
  "keep_generations",
  "retention_days",
  "compress_after",
  "compress_level",
])

// `audit:` uses strict true/false, unsigned ints, and strings that have any
// leading/trailing quote stripped (asymmetric).
const AUDIT_COERCE = sectionCoercer({
  bools: BOOL_KEYS,
  ints: INT_KEYS,
  stringMode: "any-quotes",
})

// Parse the flat `audit:` block. Unrecognized keys are ignored; scalar values
// only (same dependency-free approach as the other section parsers).
export function parseAuditConfig(yamlText: string): Partial<AuditConfig> {
  return parseFlatBlock(yamlText, "audit", {
    knownKeys: KNOWN_KEYS,
    coerce: AUDIT_COERCE,
  }) as Partial<AuditConfig>
}

// Read the effective `audit:` config. Never throws: a missing/malformed config
// yields the defaults.
export async function readAuditConfig(directory: string): Promise<AuditConfig> {
  const cfg = await readSection(directory, "audit", DEFAULT_AUDIT, { coerce: AUDIT_COERCE })
  if (typeof cfg.log !== "string" || !cfg.log.trim()) cfg.log = DEFAULT_AUDIT.log
  return cfg
}

// Best-effort secret redaction (never log a cleartext secret). Order matters
// and mirrors the Python original exactly.
const REDACT_PATTERNS: Array<[RegExp, (m: string, ...groups: string[]) => string]> = [
  // --password=x, --passwd x, --token=x, --secret=x, --api-key=x, -p x ...
  [
    /(--?(?:password|passwd|pass|token|secret|api[-_]?key|auth|authorization)\s*=\s*)\S+/gi,
    (_m, g1) => g1 + "***",
  ],
  [/(--?(?:password|passwd|token|secret|api[-_]?key)\s+)\S+/gi, (_m, g1) => g1 + "***"],
  // KEY=VALUE assignment forms
  [/\b((?:password|passwd|token|secret|api[-_]?key|authorization)\s*=\s*)\S+/gi, (_m, g1) => g1 + "***"],
  // Header-style secrets: Authorization: Bearer xyz, X-API-Key: xyz, etc.
  [/(\b(?:Authorization|X-API-Key|API-Key|Token)\s*:\s*)[^"']+/gi, (_m, g1) => g1 + "***"],
  // echo <pw> | sudo -S  (forbidden pattern, but redact anyway)
  [/(echo\s+)\S+(\s*\|\s*sudo\s+-S)/gi, (_m, g1, g2) => g1 + "***" + g2],
]

export function redact(cmd: string): string {
  let out = cmd
  for (const [re, replacer] of REDACT_PATTERNS) {
    out = out.replace(re, replacer as (...args: string[]) => string)
  }
  return out
}

export type AuditEntry = {
  ts: string
  agent: string
  cmd: string
  exit: number | null
  root: boolean
  sandbox: string
  dry: boolean
  /** Autonomy dial level (0..4) live when the command ran; null when unknown
   *  or on legacy lines written before the field existed. */
  autonomy_level: number | null
}

// Autonomy level: 0..4 only. Missing (legacy), non-numeric, fractional, and
// out-of-range values all coerce to null rather than guessing a level.
function coerceLevel(v: unknown): number | null {
  if (v == null) return null
  let n: number
  if (typeof v === "number") n = v
  else if (typeof v === "string" && v.trim() !== "") n = Number(v.trim())
  else return null
  if (!Number.isInteger(n)) return null
  return n >= 0 && n <= 4 ? n : null
}

// Validate/normalize a raw entry into a well-formed, field-ordered object.
// Throws only when `cmd` is not a string, mirroring the Python contract.
export function coerceEntry(raw: Record<string, unknown>): AuditEntry {
  const ts =
    typeof raw.ts === "string" && raw.ts ? raw.ts : nowIso()
  const agent = typeof raw.agent === "string" && raw.agent ? raw.agent : "sysop"

  if (typeof raw.cmd !== "string") throw new Error("entry.cmd must be a string")
  const cmd = redact(raw.cmd)

  let exit: number | null = null
  const rawExit = raw.exit
  if (rawExit != null) {
    const n = typeof rawExit === "number" ? rawExit : Number(rawExit)
    if (Number.isFinite(n)) exit = Math.trunc(n)
  }

  const sandbox =
    typeof raw.sandbox === "string" && raw.sandbox ? raw.sandbox : "opencode"

  return {
    ts,
    agent,
    cmd,
    exit,
    root: asBool(raw.root, false),
    sandbox,
    dry: asBool(raw.dry, false),
    autonomy_level: coerceLevel(raw.autonomy_level),
  }
}

// First line of a freshly rotated audit log — preserves the exact notice shape
// the Python logger wrote.
export function auditRotationEntry(ts: string): Record<string, unknown> {
  return {
    ts,
    agent: "audit-logger",
    cmd: "log-rotation",
    exit: 0,
    root: false,
    sandbox: "none",
    dry: false,
  }
}
