// Shared YAML section loader for sysop-config.yaml.
//
// The per-section parsers (paths, audit, decisions, retrieval, browser,
// profile, knowledge, telemetry) all repeated the same shape: a regex to slice
// the indented block, a `key: raw` line scan, comment stripping, then a
// type-specific coercion. This module owns the block extraction + line scan +
// overlay; each section keeps its own Config type, DEFAULT_*, key sets, and
// leaf resolution, passing a `coerce` callback built from the coercion modes
// below so subtle per-section quirks (signed vs unsigned ints, quote handling,
// value-inferred scalars) are preserved byte-for-byte.
//
// The bottom half adds `parseNestedSection` / `readNestedSection` for the
// autonomy-harness sections (autonomy:, mood:, comms:, dashboard:) — flat
// scalars plus one level of sub-blocks, inline/block lists, and reject
// reporting so invalid values can warn before falling back to defaults.
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
// is how every section in this config is written (flat scalars only). A
// trailing comment on the section line itself (`mood:   # …`) is tolerated.
export function extractBlock(yamlText: string, section: string): string {
  const re = new RegExp(`^${escapeRe(section)}:[ \\t]*(?:#[^\\n]*)?\\n((?:[ \\t].*\\n?)*)`, "m")
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

// ---------------------------------------------------------------------------
// Nested-section parsing (autonomy harness config — plan §11)
//
// The harness sections (`autonomy:`, `mood:`, `comms:`, `dashboard:`) mix flat
// scalars with one level of sub-blocks (`autonomy.quiet.window`), inline lists
// (`root_classes: []`, `dream_missions: [drain, dream]`), and int-or-string
// unions (`mission_token_budget: 32000 | unlimited`) — shapes `parseFlatBlock`
// cannot represent. Same conventions as the flat parser (comment stripping,
// known-keys filtering, never throws) but a coercion failure is RETURNED as a
// reject instead of silently dropped, so the caller can log a warning before
// falling back to the default.

export type NestedReject = {
  /** Dotted path within the section, e.g. `quiet.window`. */
  path: string
  /** The offending raw text (after comment stripping). */
  raw: string
  reason: string
}

export type NestedParse = {
  scalars: Record<string, unknown>
  blocks: Record<string, Record<string, unknown>>
  rejects: NestedReject[]
}

export type NestedDefaults = {
  scalars: Record<string, unknown>
  blocks: Record<string, Record<string, unknown>>
}

// Result of coercing one raw value. `undefined` drops the key silently
// (matching the flat parser's `continue`); `{ ok: false }` records a reject.
export type CoerceResult = { ok: true; value: unknown } | { ok: false; reason: string }

export type NestedCoerce = (path: string, raw: string) => CoerceResult | undefined

export type NestedSectionOptions = {
  /** Known top-level scalar keys. */
  scalarKeys?: Set<string>
  /** Known top-level sub-block names → their known keys. */
  blockKeys?: Record<string, Set<string>>
  /** Scalar keys whose value is a YAML list (inline `[a, b]` or block `- a`). */
  listKeys?: Set<string>
  /** `<block>.<key>` entries whose value is a YAML list. */
  blockListKeys?: Set<string>
  /** Per-path coercion. Unknown keys are rejected before this is called. */
  coerce?: NestedCoerce
}

const LIST_ITEM_RE = /^\s*-\s+(.*)$/

// Parse an inline YAML list (`[a, b, "c"]`) into trimmed, de-quoted strings.
// An empty body (`[]`) yields []. Returns undefined for non-list raw text.
export function parseInlineList(raw: string): string[] | undefined {
  const t = raw.trim()
  if (!t.startsWith("[")) return undefined
  if (!t.endsWith("]")) return undefined
  const body = t.slice(1, -1).trim()
  if (body === "") return []
  return body
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s !== "")
}

/** A duration in whole hours or minutes, e.g. `12h`, `30m` (plan §4.2). */
export const DURATION_RE = /^\d+[mh]$/

export function isDuration(raw: string): boolean {
  return DURATION_RE.test(raw)
}

// Parse one `section:` whose body may mix flat scalars, one level of
// sub-blocks, and list keys (inline or block form). Unknown keys/blocks,
// empty non-list values, and comment lines are recorded as rejects or
// dropped per the options; never throws.
export function parseNestedSection(
  yamlText: string,
  section: string,
  opts: NestedSectionOptions = {},
): NestedParse {
  const out: NestedParse = { scalars: {}, blocks: {}, rejects: [] }
  const body = extractBlock(yamlText, section)
  if (body === "") return out

  const reject = (path: string, raw: string, reason: string) =>
    out.rejects.push({ path, raw, reason })

  const put = (
    container: Record<string, unknown>,
    path: string,
    key: string,
    raw: string,
  ) => {
    if (!opts.coerce) {
      container[key] = raw
      return
    }
    const res = opts.coerce(path, raw)
    if (res === undefined) return
    if (res.ok) container[key] = res.value
    else reject(path, raw, res.reason)
  }

  const lines = body.split("\n")
  let baseIndent = -1
  for (const line of lines) {
    const t = line.trim()
    if (t !== "" && !t.startsWith("#")) {
      baseIndent = line.length - line.trimStart().length
      break
    }
  }
  if (baseIndent < 0) return out

  let currentBlock: string | null = null
  let pendingList: { path: string; container: Record<string, unknown>; key: string; items: string[] } | null = null

  const flushList = () => {
    if (pendingList === null) return
    const { path, container, key, items } = pendingList
    pendingList = null
    put(container, path, key, "[" + items.join(", ") + "]")
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const indent = line.length - line.trimStart().length
    if (indent < baseIndent) break

    // List item under a pending `key:` list opener.
    const item = trimmed.match(LIST_ITEM_RE)
    if (item && pendingList !== null) {
      pendingList.items.push(item[1].trim().replace(/^["']|["']$/g, ""))
      continue
    }

    const m = trimmed.match(DEFAULT_KEY_RE)
    if (!m) continue
    const key = m[1]
    // `m[2]` may start with `#` (the key regex already ate the whitespace),
    // so strip a comment at position 0 as well as one preceded by a space.
    const raw = m[2].replace(/(^|\s)#.*$/, "$1").trim()
    const atBase = indent === baseIndent

    if (atBase) {
      flushList()
      if (raw === "") {
        // Block or list opener, unknown key, or an empty non-list scalar.
        if (opts.blockKeys && key in opts.blockKeys) {
          currentBlock = key
          out.blocks[key] = out.blocks[key] ?? {}
        } else if (opts.listKeys?.has(key)) {
          currentBlock = null
          pendingList = { path: key, container: out.scalars, key, items: [] }
        } else if (opts.scalarKeys?.has(key)) {
          currentBlock = null
          reject(key, "", "empty value for non-list key")
        } else if (opts.scalarKeys || opts.blockKeys) {
          currentBlock = null
          reject(key, "", "unknown key")
        } else {
          currentBlock = key
          out.blocks[key] = out.blocks[key] ?? {}
        }
        continue
      }
      currentBlock = null
      if (opts.scalarKeys && !opts.scalarKeys.has(key)) {
        reject(key, raw, "unknown key")
        continue
      }
      put(out.scalars, key, key, raw)
      continue
    }

    // Deeper-indented line: must belong to an open block.
    if (currentBlock !== null) {
      const known = opts.blockKeys?.[currentBlock]
      const path = `${currentBlock}.${key}`
      if (raw === "") {
        if (opts.blockListKeys?.has(path)) {
          pendingList = { path, container: out.blocks[currentBlock], key, items: [] }
        } else {
          reject(path, "", "nested deeper than supported or empty non-list value")
        }
        continue
      }
      if (known && !known.has(key)) {
        reject(path, raw, "unknown key")
        continue
      }
      put(out.blocks[currentBlock], path, key, raw)
      continue
    }
    // Deeper line with no open block (body of an unknown block) — skip.
  }
  flushList()
  return out
}

// Overlay a parsed result onto defaults: deep-clones the defaults, then
// applies every coerced value that was actually parsed. Rejects are carried
// through. Never throws.
export function overlayNestedSection(defaults: NestedDefaults, parsed: NestedParse): NestedParse {
  const scalars: Record<string, unknown> = { ...defaults.scalars }
  const blocks: Record<string, Record<string, unknown>> = {}
  for (const [name, values] of Object.entries(defaults.blocks)) {
    blocks[name] = { ...values }
  }
  for (const [key, value] of Object.entries(parsed.scalars)) {
    if (value !== undefined && key in scalars) scalars[key] = value
  }
  for (const [name, values] of Object.entries(parsed.blocks)) {
    if (!(name in blocks)) continue
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined && key in blocks[name]) blocks[name][key] = value
    }
  }
  return { scalars, blocks, rejects: parsed.rejects }
}

// Read the effective nested `section:` for a project directory, overlaying it
// on the defaults. Never throws: a missing or malformed config yields the
// defaults (with whatever rejects the parse produced).
export async function readNestedSection(
  directory: string,
  section: string,
  defaults: NestedDefaults,
  opts: NestedSectionOptions = {},
): Promise<NestedParse> {
  let raw = ""
  try {
    raw = await readFile(join(directory, SYSCONFIG), "utf8")
  } catch {
    // defaults
  }
  return overlayNestedSection(defaults, parseNestedSection(raw, section, opts))
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
