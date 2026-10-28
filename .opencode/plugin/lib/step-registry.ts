// Step registry (deconcurrency plan, Phase 1).
//
// The heartbeat hook owns the only timer. Hooks that used to run their own
// loops (quiet-hours, profile, soul) register a *step* here instead: the runner is a
// function that does one bounded unit of work and returns "sleeping" when it
// is not due (it self-gates on its own window/cooldown).
//
// Loaded via relative import only.
export type StepKind = "quiet-hours" | "profile-update" | "soul-update"

/** Priority order for background steps, after mission and drain-pass. */
export const STEP_ORDER: readonly StepKind[] = [
  "quiet-hours",
  "profile-update",
  "soul-update",
]

export type StepRunner = () => Promise<unknown>

const runners = new Map<StepKind, StepRunner>()

/** Register (or replace) the runner for a step kind. Idempotent. */
export function registerStep(kind: StepKind, run: StepRunner): void {
  runners.set(kind, run)
}

/** Remove a runner (tests, teardown). */
export function unregisterStep(kind: StepKind): void {
  runners.delete(kind)
}

export function hasStep(kind: StepKind): boolean {
  return runners.has(kind)
}

/**
 * Run every registered step in priority order. Each step self-gates, so a
 * sleeping step is cheap. A step that throws is isolated: the error is
 * reported, the remaining steps still run. Returns the kinds that were
 * invoked (not whether they did work).
 */
export async function runSteps(
  order: readonly StepKind[] = STEP_ORDER,
  onError?: (kind: StepKind, err: unknown) => void,
): Promise<StepKind[]> {
  const ran: StepKind[] = []
  for (const kind of order) {
    const run = runners.get(kind)
    if (!run) continue
    ran.push(kind)
    try {
      await run()
    } catch (err) {
      onError?.(kind, err)
    }
  }
  return ran
}
