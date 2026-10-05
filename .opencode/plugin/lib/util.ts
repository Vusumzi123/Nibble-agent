// Shared primitives used across the hook plugins. Every helper here is
// dependency-free and deterministic so it can be unit-tested in isolation.
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.

export const nowIso = (): string => new Date().toISOString()

export const errText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

// Coerce a YAML/scalar/unknown value to a boolean. Strings accept the usual
// truthy tokens (1/true/yes/on, case- and whitespace-insensitive); numbers and
// other non-null values fall back to JS truthiness.
export function asBool(v: unknown, fallback = false): boolean {
  if (typeof v === "boolean") return v
  if (typeof v === "string") return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase())
  return v != null ? Boolean(v) : fallback
}

// Coerce to an integer. Numbers are truncated; strings must be wholly numeric
// (optionally signed). Anything else yields the fallback.
export function asInt(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === "string") {
    const s = v.trim()
    if (/^[+-]?\d+$/.test(s)) return parseInt(s, 10)
  }
  return fallback
}

// Coerce to a finite float. Numbers pass through; strings must parse as a
// finite number. Anything else yields the fallback.
export function asFloat(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") {
    const s = v.trim()
    if (s !== "" && Number.isFinite(Number(s))) return Number(s)
  }
  return fallback
}

// Token estimate ratio for prose/code transcripts: ~4 characters per token.
// Used to express the drain's aggregate context ceiling in tokens rather than
// only per-part bytes. Deterministic, no tokenizer dependency.
export const CHARS_PER_TOKEN = 4

// Estimate a transcript's token count from its UTF-8 byte length, matching the
// knowledge pipeline's deterministic ceiling accounting.
export function estimateTokens(s: string): number {
  return Math.ceil(Buffer.byteLength(s, "utf8") / CHARS_PER_TOKEN)
}
