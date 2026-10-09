// Loader for `.opencode/decision-prompts.yaml` — the commented, single source
// of truth for the JEV question texts (assertions / criteria) asked by the
// gates. One section per gate: retrieval (retrieval-hook), ingest
// (knowledge-hook drain), tags (knowledge-hook capture tag/salience gate),
// autonomy (autonomy-gate borderline escalation).
//
// Parsing reuses the flat-YAML machinery from lib/config.ts (extractBlock +
// parseFlatBlock): one top-level `section:` with indented `key: value`
// scalars, comments on their own lines, no blank lines inside a section.
// Each key falls back to its built-in default, so a missing file, a missing
// key, or a malformed value NEVER disables a gate — the defaults below are
// the live strings from the owning modules (never a drifted copy).
//
// Loading is side-effect free and never throws: callers get a complete
// DecisionPrompts object or, via readDecisionPromptsFrom, `null` when the
// file has no parseable prompt keys (used by retrieval-hook to fall back to
// a legacy .json prompts_file).
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { parseFlatBlock, sectionCoercer } from "./config.ts"
import { expandHome } from "./paths.ts"
import { INGEST_ASSERTION } from "./decisions.ts"
import { DEFAULT_AUTONOMY_ASSERTION } from "./autonomy-gate.ts"
import { DEFAULT_RETRIEVAL_ASSERTION } from "./retrieval.ts"

export const DECISION_PROMPTS_LEAF = ".opencode/decision-prompts.yaml"

export type DecisionPrompts = {
  retrieval: { assertion: string }
  ingest: { assertion: string }
  tags: { choice_criteria: string; score_criteria: string }
  autonomy: { assertion: string }
}

export type PartialDecisionPrompts = {
  retrieval?: Partial<DecisionPrompts["retrieval"]>
  ingest?: Partial<DecisionPrompts["ingest"]>
  tags?: Partial<DecisionPrompts["tags"]>
  autonomy?: Partial<DecisionPrompts["autonomy"]>
}

// Built-in fallbacks: the gate defaults live in their owning modules and are
// re-exported here so there is exactly one copy of each string in the code.
// The tags prompts were knowledge-hook's inline literals — they moved here as
// part of the decision-prompts extraction; the YAML file mirrors these values.
export const DEFAULT_DECISION_PROMPTS: DecisionPrompts = {
  retrieval: { assertion: DEFAULT_RETRIEVAL_ASSERTION },
  ingest: { assertion: INGEST_ASSERTION },
  tags: {
    choice_criteria:
      "Pick the existing tags that best categorize this turn. Choose NEW only if none of the existing tags fit.",
    score_criteria:
      "How durable/useful is this turn for future retrieval, independent of any note? (1 = ephemeral, 5 = core knowledge)",
  },
  autonomy: { assertion: DEFAULT_AUTONOMY_ASSERTION },
}

const KNOWN_KEYS: Record<keyof DecisionPrompts, Set<string>> = {
  retrieval: new Set(["assertion"]),
  ingest: new Set(["assertion"]),
  tags: new Set(["choice_criteria", "score_criteria"]),
  autonomy: new Set(["assertion"]),
}

// Values are single-line quoted (or plain) scalars; pair-quote stripping
// removes exactly one matching outer quote pair and never touches inner ones.
// Whitespace-only results (e.g. `assertion: "   "`) are dropped so an empty
// value never overrides a built-in default.
const COERCE_RAW = sectionCoercer({ stringMode: "pair-quotes" })
const COERCE = (key: string, raw: string): unknown => {
  const value = COERCE_RAW(key, raw)
  return typeof value === "string" && value.trim() === "" ? undefined : value
}

// Parse the prompts YAML into a partial result: only sections/keys that were
// present with a non-empty string value appear in the output. Pure + total —
// any input (including garbage) yields a partial/empty object, never throws.
export function parseDecisionPrompts(yamlText: string): PartialDecisionPrompts {
  const out: PartialDecisionPrompts = {}
  for (const section of ["retrieval", "ingest", "tags", "autonomy"] as const) {
    const parsed = parseFlatBlock(yamlText, section, {
      knownKeys: KNOWN_KEYS[section],
      coerce: COERCE,
    })
    if (Object.keys(parsed).length === 0) continue
    out[section] = parsed as Partial<DecisionPrompts[typeof section]>
  }
  return out
}

// Overlay a partial parse on the defaults, key by key (per-key fallback — a
// file that defines only `tags:` still yields the default retrieval/ingest
// assertions).
export function mergeDecisionPrompts(partial: PartialDecisionPrompts): DecisionPrompts {
  const d = DEFAULT_DECISION_PROMPTS
  return {
    retrieval: { assertion: partial.retrieval?.assertion || d.retrieval.assertion },
    ingest: { assertion: partial.ingest?.assertion || d.ingest.assertion },
    tags: {
      choice_criteria: partial.tags?.choice_criteria || d.tags.choice_criteria,
      score_criteria: partial.tags?.score_criteria || d.tags.score_criteria,
    },
    autonomy: { assertion: partial.autonomy?.assertion || d.autonomy.assertion },
  }
}

// Read + parse one prompts file. Returns null when the file is missing,
// unreadable, or contains no parseable prompt keys (never throws).
export async function readDecisionPromptsFrom(file: string): Promise<PartialDecisionPrompts | null> {
  try {
    const parsed = parseDecisionPrompts(await readFile(file, "utf8"))
    return Object.keys(parsed).length > 0 ? parsed : null
  } catch {
    return null
  }
}

// Resolve the prompts-file leaf: absolute passes through, `~` is expanded,
// anything else is project-relative (same rule as retrieval.prompts_file).
export function resolveDecisionPrompts(directory: string): string {
  const expanded = expandHome(DECISION_PROMPTS_LEAF, homedir())
  return isAbsolute(expanded) ? expanded : join(directory, expanded)
}

// The always-complete prompts for a project: file overlay (or nothing) on the
// built-in defaults. This is what the knowledge-hook consumes at init.
export async function readDecisionPrompts(directory: string): Promise<DecisionPrompts> {
  return mergeDecisionPrompts((await readDecisionPromptsFrom(resolveDecisionPrompts(directory))) ?? {})
}
