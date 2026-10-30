// Background step work kinds: `quiet-hours`, `profile-update`, `soul-update`.
// The runners are registered in `step-registry.ts` by their own hooks; this
// handler only invokes the one the picker selected.
//
// Loaded via relative import only.
import { runSteps, type StepKind } from "../step-registry.ts"
import type { WorkKindHandler } from "./types.ts"

function stepHandler(kind: StepKind): WorkKindHandler {
  return {
    kind,
    async run(ctx) {
      await ctx.setPhase(kind)
      const errors: string[] = []
      await runSteps([kind], (failedKind, err) => {
        errors.push(failedKind)
        ctx.diag.error(`[heartbeat-hook] step ${failedKind} failed:`, err)
      })
      return {
        executed: true,
        ledger: {
          verdict: "no_reply",
          mission: null,
          outcome: errors.length ? "error" : "completed",
          token_cost: 0,
          gate: kind,
          reason: errors.length ? "step-error" : "step",
        },
      }
    },
  }
}

export const quietHoursHandler = stepHandler("quiet-hours")
export const profileUpdateHandler = stepHandler("profile-update")
export const soulUpdateHandler = stepHandler("soul-update")
