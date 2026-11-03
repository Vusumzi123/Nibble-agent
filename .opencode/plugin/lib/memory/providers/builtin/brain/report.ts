// Writer-report parsing for the drain pipe (knowledge-pipeline-redesign
// §A.10/§B.6).
//
// The writer calls `drain_report` with the item labels it consolidated and
// skipped. The coordinator reads the last call from the transcript and
// re-validates it against the real batch; it is the authority. The old fenced
// report parser remains until the adapters switch to the tool contract.
//
// Loaded via relative import only.
import { lastToolCall } from "../../../../tools/tool-call.ts"

export const DRAIN_REPORT_TOOL = "drain_report"

export type DrainReport = {
  /** True only when every item is reported exactly once (or partial is set). */
  valid: boolean
  consolidated: number[]
  skipped: number[]
  /** Labels present in either list. */
  reported: number[]
  duplicates: number[]
  unknown: number[]
  missing: number[]
  invalid: string[]
  partial: boolean
  itemCount: number
  error?: string
}

function normalizeLabel(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 ? value : null
  }
  if (typeof value !== "string") return null
  const match = /^#?\s*(\d+)$/.exec(value.trim())
  if (!match) return null
  const label = Number(match[1])
  return Number.isInteger(label) && label > 0 ? label : null
}

function labelsOf(raw: unknown, out: number[], invalid: string[]): void {
  if (!Array.isArray(raw)) return
  for (const entry of raw) {
    const label = normalizeLabel(entry)
    if (label === null) invalid.push(String(entry))
    else out.push(label)
  }
}

/**
 * Validate the `drain_report` arguments. `expectedCount` overrides the
 * declared `item_count` so the coordinator can re-validate against the real
 * batch. `partial` allows missing labels (the step cap stopped the batch).
 */
export function validateDrainReport(raw: unknown, expectedCount?: number): DrainReport {
  let value: unknown = raw
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      value = null
    }
  }
  const obj =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null

  const declared = Number(obj?.item_count ?? NaN)
  const itemCount =
    expectedCount !== undefined
      ? Math.max(0, Math.floor(expectedCount))
      : Number.isFinite(declared)
        ? Math.max(0, Math.floor(declared))
        : 0
  const partial = obj?.partial === true

  const consolidated: number[] = []
  const skipped: number[] = []
  const invalid: string[] = []
  labelsOf(obj?.consolidated, consolidated, invalid)
  labelsOf(obj?.skipped, skipped, invalid)
  const reported = [...consolidated, ...skipped]

  const counts = new Map<number, number>()
  for (const label of reported) counts.set(label, (counts.get(label) ?? 0) + 1)

  const duplicates = [...counts.entries()]
    .filter(([, n]) => n > 1)
    .map(([label]) => label)
    .sort((a, b) => a - b)
  const unknown = [...counts.keys()]
    .filter((label) => label < 1 || label > itemCount)
    .sort((a, b) => a - b)
  const missing: number[] = []
  for (let i = 1; i <= itemCount; i++) {
    if (!counts.has(i)) missing.push(i)
  }

  let error: string | undefined
  if (!obj) error = "invalid report"
  else if (expectedCount === undefined && !Number.isFinite(declared)) error = "missing item_count"
  else if (invalid.length > 0) error = "invalid labels"
  else if (duplicates.length > 0) error = "duplicate labels"
  else if (unknown.length > 0) error = "unknown labels"
  else if (!partial && missing.length > 0) error = "missing labels"

  const valid =
    error === undefined && itemCount > 0 && (partial || reported.length === itemCount)

  return {
    valid,
    consolidated,
    skipped,
    reported,
    duplicates,
    unknown,
    missing,
    invalid,
    partial,
    itemCount,
    ...(error ? { error } : {}),
  }
}

/** Last `drain_report` call in a child transcript, re-validated, or null. */
export function parseDrainReport(rows: unknown[], itemCount: number): DrainReport | null {
  const raw = lastToolCall(rows, DRAIN_REPORT_TOOL)
  if (raw === null) return null
  return validateDrainReport(raw, itemCount)
}

// ---------------------------------------------------------------------------
// Legacy fenced report parser (removed when the adapters switch to the tool).

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
