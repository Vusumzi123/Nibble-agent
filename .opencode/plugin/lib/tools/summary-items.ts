// `summary_items` tool: the summarizer's typed report contract.
//
// The child never formats prose: it calls this tool once with every durable
// item (or an empty array when nothing durable happened). The coordinator
// reads the last call from the transcript and re-validates the shape.
//
// Loaded via relative import only.
import { tool } from "@opencode-ai/plugin"
import {
  SUMMARY_ITEMS_TOOL,
  validateSummaryItems,
  type RawSummaryItem,
} from "../drain/summarize.ts"

export { SUMMARY_ITEMS_TOOL }

export function createSummaryItemsTool() {
  const schema = tool.schema
  return tool({
    description:
      "Report the durable knowledge items extracted from one session delta. " +
      "Call exactly once with an empty items array when nothing durable happened.",
    args: {
      items: schema
        .array(
          schema.object({
            title: schema.string().describe("One-line note title; must not be empty."),
            tags: schema.array(schema.string()).describe("Lowercase hierarchical tags."),
            summary: schema.string().describe("1-3 sentence summary."),
            atoms: schema
              .array(schema.string())
              .describe("Commands, paths, URLs, KEY=value and flags, verbatim."),
          }),
        )
        .describe("Durable items; an empty array means nothing to store."),
    },
    async execute(args: any) {
      const result = validateSummaryItems(args)
      if (!result.ok) return JSON.stringify({ ok: false, error: result.error })
      return JSON.stringify({ ok: true, count: result.items.length })
    },
  })
}

export type { RawSummaryItem }
