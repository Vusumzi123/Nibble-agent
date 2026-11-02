// `drain-pass` work kind: one bounded drain step per tick. Production moved to
// chron (`lib/chron/jobs/drain.ts`); this module owns execution only.
//
// Loaded via relative import only.
import type { WorkKindHandler } from "./types.ts"

export const drainHandler: WorkKindHandler = {
  kind: "drain-pass",
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
