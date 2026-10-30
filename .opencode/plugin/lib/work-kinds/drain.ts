// `drain-pass` work kind: one bounded drain step per tick, and the intent
// that enqueues it when the drain store says work is due.
//
// Loaded via relative import only.
import type { WorkItem } from "../work-queue.ts"
import type { ProducerCtx } from "./shared.ts"
import type { WorkKindHandler } from "./types.ts"

export const drainHandler: WorkKindHandler = {
  kind: "drain-pass",
  async produce(ctx: ProducerCtx): Promise<WorkItem[]> {
    if (!ctx.drainDue) return []
    const due = await ctx.drainDue()
    if (!due.due) return []
    return [
      {
        id: "drain-pass",
        kind: "drain-pass",
        producer: "scheduler",
        enqueued_ms: ctx.nowMs,
        requeue_count: 0,
      },
    ]
  },
  async run(ctx) {
    await ctx.setPhase("drain")
    const step = await ctx.runDrain()
    return {
      executed: step.ran,
      ledger: {
        verdict: "no_reply",
        mission: null,
        outcome: step.ran
          ? step.result.outcome === "error"
            ? "error"
            : "completed"
          : "silent",
        token_cost: step.ran ? step.result.tokens ?? 0 : 0,
        gate: "drain",
        reason: step.ran ? `drain:${step.result.outcome}` : `drain:${step.reason}`,
      },
    }
  },
}
