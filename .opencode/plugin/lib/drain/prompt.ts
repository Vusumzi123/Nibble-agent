// Consolidation prompt assembly for the drain pipe
// (knowledge-pipeline-redesign §A.8).
//
// The first line is exactly `Consolidation mode.` — that is the writer's
// trigger. Items are labelled `#1..N` and nothing else (no message/session ids
// or timestamps), so the writer can report labels back without knowing where
// the turns came from.
//
// Loaded via relative import only.
import { formatCandidate, type CandidateNote } from "./candidates.ts"
import { truncateToBytes } from "./render.ts"

export type ConsolidationItem = {
  title: string
  tags: string[]
  atoms: string[]
  summary: string
}

export type PromptOptions = {
  /** Total byte ceiling; <= 0 disables the cap. */
  maxBytes?: number
}

const HEADER = `Consolidation mode.
Consolidate the following knowledge items into structured, deduplicated,
[[linked]] Brain vault notes, following your operating instructions.`

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

function renderPrompt(
  items: ConsolidationItem[],
  candidates: CandidateNote[],
  summaryCap: number | null,
): string {
  const parts: string[] = [HEADER]

  if (candidates.length > 0) {
    parts.push(
      "Candidate existing notes (deterministic prefetch — may be incomplete):",
      candidates.map(formatCandidate).join("\n"),
    )
  }

  items.forEach((item, i) => {
    const summary =
      summaryCap === null ? item.summary.trim() : truncateToBytes(item.summary.trim(), summaryCap)
    const atoms = item.atoms.length > 0 ? item.atoms.map((atom) => `- ${atom}`).join("\n") : "-"
    parts.push(
      `### Knowledge item #${i + 1}\ntitle: ${item.title}\ntags: ${item.tags.join(", ")}\natoms:\n${atoms}\nsummary:\n${summary}`,
    )
  })

  return parts.join("\n\n")
}

/**
 * Build the prompt. When the cap is exceeded, candidates are dropped first;
 * if it still does not fit, summaries are shortened while every item header
 * (and therefore every reportable label) is preserved.
 */
export function buildConsolidationPrompt(
  items: ConsolidationItem[],
  candidates: CandidateNote[] = [],
  opts: PromptOptions = {},
): string {
  const maxBytes = opts.maxBytes ?? 60000
  let text = renderPrompt(items, candidates, null)
  if (maxBytes <= 0 || byteLength(text) <= maxBytes) return text

  if (candidates.length > 0) {
    text = renderPrompt(items, [], null)
    if (byteLength(text) <= maxBytes) return text
  }

  let cap = Math.max(0, Math.floor(maxBytes / Math.max(1, items.length)))
  for (;;) {
    text = renderPrompt(items, [], cap)
    if (byteLength(text) <= maxBytes || cap === 0) return text
    cap = Math.floor(cap * 0.8)
  }
}
