// Writer-report parsing for the drain pipe (knowledge-pipeline-redesign
// §A.10/§B.6).
//
// The writer ends with two fences:
//
//   ```consolidated
//   #1
//   ```
//   ```skipped
//   #2
//   ```
//
// The cursor may advance only when every item is reported exactly once across
// the two blocks. Partial, duplicate, unknown, or missing labels block the
// batch (the pipe retries, then poisons).

export type ConsolidationReport = {
  /** True only when every item is reported exactly once. */
  valid: boolean
  consolidated: number[]
  skipped: number[]
  /** Labels present in either block. */
  reported: number[]
  duplicates: number[]
  unknown: number[]
  missing: number[]
  error?: string
}

const FENCE_RE = /```(consolidated|skipped)\s*\n([\s\S]*?)```/g
const LABEL_RE = /#(\d+)\b/g

function labelsIn(body: string): number[] {
  const out: number[] = []
  for (const match of body.matchAll(LABEL_RE)) {
    const n = Number(match[1])
    if (Number.isInteger(n) && n > 0) out.push(n)
  }
  return out
}

/**
 * Parse the writer's report. Prose around the fences is tolerated; anything
 * inside an unrecognized fence is ignored.
 */
export function parseConsolidationReport(reply: string, itemCount: number): ConsolidationReport {
  const consolidated: number[] = []
  const skipped: number[] = []
  let fences = 0

  for (const match of reply.matchAll(FENCE_RE)) {
    fences++
    const labels = labelsIn(match[2])
    if (match[1] === "consolidated") consolidated.push(...labels)
    else skipped.push(...labels)
  }

  if (fences === 0) {
    return {
      valid: false,
      consolidated,
      skipped,
      reported: [],
      duplicates: [],
      unknown: [],
      missing: Array.from({ length: Math.max(0, itemCount) }, (_, i) => i + 1),
      error: "no report fence",
    }
  }

  const reported = [...consolidated, ...skipped]
  const counts = new Map<number, number>()
  for (const label of reported) counts.set(label, (counts.get(label) ?? 0) + 1)

  const duplicates = [...counts.entries()].filter(([, n]) => n > 1).map(([label]) => label).sort((a, b) => a - b)
  const unknown = [...counts.keys()].filter((label) => label < 1 || label > itemCount).sort((a, b) => a - b)
  const missing: number[] = []
  for (let i = 1; i <= itemCount; i++) {
    if (!counts.has(i)) missing.push(i)
  }

  let error: string | undefined
  if (duplicates.length > 0) error = "duplicate labels"
  else if (unknown.length > 0) error = "unknown labels"
  else if (missing.length > 0) error = "missing labels"

  return {
    valid: error === undefined && itemCount > 0 && reported.length === itemCount,
    consolidated,
    skipped,
    reported,
    duplicates,
    unknown,
    missing,
    error,
  }
}
