// Shared flat-YAML section loader for sysop-config.yaml.
//
// The nine per-section parsers (paths, audit, telegram, mail, browser,
// decisions, retrieval, profile, knowledge) all repeated the same shape: a regex to slice
// the indented block, a `key: raw` line scan, comment stripping, then a
// type-specific coercion. This module owns the block extraction + line scan +
// overlay; each section keeps its own Config type, DEFAULT_*, key sets, and
// leaf resolution, passing a `coerce` callback built from the coercion modes
// below so subtle per-section quirks (signed vs unsigned ints, quote handling,
// value-inferred scalars) are preserved byte-for-byte.
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.
import { readFile } from "node:fs/promises"
import { join } from "node:path"

export const SYSCONFIG = ".opencode/sysop-config.yaml"

export type ScalarType = "bool" | "int" | "float" | "string"

// Default `key:` regex (no hyphens). `paths` passes HYPHEN_KEY_RE instead.
export const DEFAULT_KEY_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/
export const HYPHEN_KEY_RE = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Slice the indented body of `section:` out of the YAML text. The body is the
// run of lines that begin with a space/tab immediately after `section:`, which
// is how every section in this config is written (flat scalars only).
export function extractBlock(yamlText: string, section: string): string {
  const re = new RegExp(`^${escapeRe(section)}:\\s*\\n((?:[ \\t].*\\n?)*)`, "m")
  return yamlText.match(re)?.[1] ?? ""
}

// Infer each key's scalar type from its default value. `Number.isInteger` →
// int, other finite numbers → float, booleans → bool, everything else → string.
export function schemaFromDefaults(
  defaults: Record<string, unknown>,
): Record<string, ScalarType> {
  const out: Record<string, ScalarType> = {}
  for (const [key, value] of Object.entries(defaults)) {
    if (typeof value === "boolean") out[key] = "bool"
    else if (typeof value === "number") out[key] = Number.isInteger(value) ? "int" : "float"
    else out[key] = "string"
  }
  return out
}

// Strip a leading and/or trailing quote independently (audit/profile behavior).
export function stripAnyQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, "")
}

// Strip a matching pair of quotes only (telegram/browser/mail/decisions
// behavior). A quoted empty (`""` / `''`) becomes ""; a lone quote is kept.
export function stripPairQuotes(s: string): string {
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1)
  }
  return s
}

export type SectionCoercerOpts = {
  /** Keys coerced to boolean via strict `true` / `false`. */
  bools?: Set<string>
  /** Keys coerced to integer via `intPattern`. */
  ints?: Set<string>
  /** Keys coerced to float via `coerceFloat` (or the default fixed pattern). */
  floats?: Set<string>
  /** Integer syntax. Default `/^\d+$/` (unsigned); knowledge uses signed. */
  intPattern?: RegExp
  /** Custom float parser (profile uses `Number` + `Number.isFinite`). */
  coerceFloat?: (raw: string) => number | undefined
  /** String-quote handling. Default `"raw"` (leave untouched). */
  stringMode?: "raw" | "any-quotes" | "pair-quotes"
  /** Strip any quotes before type checks (profile behavior). */
  stripQuotesFirst?: boolean
  /**
   * Infer the type from the value for every key (knowledge behavior):
   * `true`/`false` → bool, signed int → int, else raw string. Ignores the
   * bool/int/float key sets.
   */
  valueTyped?: boolean
}

// Build the per-key coercion used by `parseFlatBlock`. Return `undefined` to
// drop the key (unknown/garbage value), matching each parser's `continue`.
export function sectionCoercer(
  opts: SectionCoercerOpts,
): (key: string, raw: string) => unknown | undefined {
  const bools = opts.bools ?? new Set<string>()
  const ints = opts.ints ?? new Set<string>()
  const floats = opts.floats ?? new Set<string>()
  const intRe = opts.intPattern ?? /^\d+$/
  const floatRe = /^-?\d+(?:\.\d+)?$/
  const mode = opts.stringMode ?? "raw"

  return (key, rawInput) => {
    const raw = opts.stripQuotesFirst ? stripAnyQuotes(rawInput) : rawInput

    if (opts.valueTyped) {
      if (raw === "") return undefined
      if (raw === "true") return true
      if (raw === "false") return false
      if (intRe.test(raw)) return parseInt(raw, 10)
      return raw
    }

    if (bools.has(key)) {
      if (raw === "true") return true
      if (raw === "false") return false
      return undefined
    }
    if (ints.has(key)) {
      return intRe.test(raw) ? parseInt(raw, 10) : undefined
    }
    if (floats.has(key)) {
      if (opts.coerceFloat) return opts.coerceFloat(raw)
      return floatRe.test(raw) ? parseFloat(raw) : undefined
    }
    // String value.
    if (raw === "") return undefined
    if (mode === "any-quotes") return stripAnyQuotes(raw)
    if (mode === "pair-quotes") return stripPairQuotes(raw)
    return raw
  }
}

// Default schema-driven coercion used when no explicit `coerce` is supplied.
export function defaultCoerce(
  schema: Record<string, ScalarType>,
  preserveQuotedEmpty = false,
): (key: string, raw: string) => unknown | undefined {
  return (key, raw) => {
    if (raw === "") return undefined
    const type = schema[key] ?? "string"
    if (type === "bool") {
      if (raw === "true") return true
      if (raw === "false") return false
      return undefined
    }
    if (type === "int") return /^-?\d+$/.test(raw) ? parseInt(raw, 10) : undefined
    if (type === "float") {
      return /^-?\d+(?:\.\d+)?$/.test(raw) ? parseFloat(raw) : undefined
    }
    return preserveQuotedEmpty ? stripPairQuotes(raw) : raw
  }
}

export type ParseFlatOptions = {
  /** Key→type map; used for the default coercion when `coerce` is absent. */
  schema?: Record<string, ScalarType>
  /** Allowed keys. When omitted but `schema` is set, the schema keys are used. */
  knownKeys?: Set<string>
  /** Line key regex. Default DEFAULT_KEY_RE; paths passes HYPHEN_KEY_RE. */
  keyPattern?: RegExp
  /** Preserve a quoted empty string in the default coercion (string mode). */
  preserveQuotedEmpty?: boolean
  /** Explicit per-key coercion; overrides schema/preserveQuotedEmpty. */
  coerce?: (key: string, raw: string) => unknown | undefined
}

export function parseFlatBlock(
  yamlText: string,
  section: string,
  opts: ParseFlatOptions = {},
): Record<string, unknown> {
  const block = extractBlock(yamlText, section)
  const re = opts.keyPattern ?? DEFAULT_KEY_RE
  const coerce =
    opts.coerce ?? defaultCoerce(opts.schema ?? {}, opts.preserveQuotedEmpty ?? false)
  const out: Record<string, unknown> = {}
  for (const line of block.split("\n")) {
    const m = line.match(re)
    if (!m) continue
    const key = m[1]
    if (opts.knownKeys) {
      if (!opts.knownKeys.has(key)) continue
    } else if (opts.schema && !(key in opts.schema)) {
      continue
    }
    const raw = m[2].replace(/\s+#.*$/, "").trim()
    const value = coerce(key, raw)
    if (value !== undefined) out[key] = value
  }
  return out
}

// Read the effective `section:` config, overlaying the block (if present) on the
// defaults. Never throws: a missing or malformed config yields the defaults.
// Only keys present in `defaults` are overlaid, matching every current reader.
export async function readSection<T extends Record<string, unknown>>(
  directory: string,
  section: string,
  defaults: T,
  opts: ParseFlatOptions = {},
): Promise<T> {
  const cfg = { ...defaults }
  const schema = opts.schema ?? schemaFromDefaults(defaults)
  const knownKeys = opts.knownKeys ?? new Set(Object.keys(defaults))
  try {
    const raw = await readFile(join(directory, SYSCONFIG), "utf8")
    const parsed = parseFlatBlock(raw, section, { ...opts, schema, knownKeys })
    for (const key of Object.keys(defaults) as Array<keyof T & string>) {
      const value = parsed[key]
      if (value !== undefined && value !== null) {
        ;(cfg as Record<string, unknown>)[key] = value
      }
    }
  } catch {
    // defaults
  }
  return cfg
}
