// `drain_report` tool: the drain writer's typed report contract.
//
// The writer calls this once per batch with the labels it consolidated and
// skipped. The tool validates the labels against the declared item count and
// returns a structured error so the model can correct in the same turn.
//
// Loaded via relative import only.
import { tool } from "@opencode-ai/plugin"
import {
  DRAIN_REPORT_TOOL,
  validateDrainReport,
} from "../memory/providers/builtin/brain/report.ts"

export { DRAIN_REPORT_TOOL }

export function createDrainReportTool() {
  const schema = tool.schema
  const label = schema.union([schema.string(), schema.number()])
  return tool({
    description:
      "Report which batch items were consolidated or skipped. Call exactly once " +
      "when the batch is finished. Every item #1..#N must appear exactly once " +
      "unless partial is true.",
    args: {
      item_count: schema.number().int().min(0).describe("N from Knowledge item #1..N."),
      consolidated: schema.array(label).describe("Labels of items written or updated."),
      skipped: schema.array(label).describe("Labels of items with nothing to store."),
      partial: schema
        .boolean()
        .optional()
        .describe("True only when the step cap stopped the batch early."),
    },
    async execute(args: any) {
      const report = validateDrainReport(args, undefined)
      if (!report.valid) {
        return JSON.stringify({
          ok: false,
          duplicate: report.duplicates,
          unknown: report.unknown,
          missing: report.missing,
          valid_labels: Array.from({ length: Math.max(0, report.itemCount) }, (_, i) => `#${i + 1}`),
          ...(report.invalid.length > 0 ? { invalid: report.invalid } : {}),
          ...(report.error ? { error: report.error } : {}),
        })
      }
      return JSON.stringify({
        ok: true,
        consolidated: report.consolidated,
        skipped: report.skipped,
        partial: report.partial,
      })
    },
  })
}
