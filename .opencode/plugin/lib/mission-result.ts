// Structured mission result parsing.
//
// The `mission_result` tool is the only accepted decline signal. The
// orchestrator reads the last call from the child transcript; a missing call
// falls back to the final assistant text and the child outcome, never to an
// inferred decline.
//
// Loaded via relative import only.

export type MissionResultStatus = "completed" | "declined" | "error"

export type MissionResult = {
  status: MissionResultStatus
  summary: string
  reason?: string
}

const STATUSES = new Set<MissionResultStatus>(["completed", "declined", "error"])

function normalize(raw: unknown): MissionResult | null {
  let value: unknown = raw
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  const status = obj.status
  if (typeof status !== "string" || !STATUSES.has(status as MissionResultStatus)) return null
  return {
    status: status as MissionResultStatus,
    summary: typeof obj.summary === "string" ? obj.summary : "",
    ...(typeof obj.reason === "string" ? { reason: obj.reason } : {}),
  }
}

/** Last `mission_result` tool call in a message array, or null. */
export function parseMissionResult(messages: unknown[]): MissionResult | null {
  let found: MissionResult | null = null
  for (const row of messages ?? []) {
    const parts = (row as { parts?: unknown })?.parts
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (!part || typeof part !== "object") continue
      const p = part as Record<string, any>
      if (p.type !== "tool" || p.tool !== "mission_result") continue
      const parsed = normalize(p.state?.input ?? p.state?.output)
      if (parsed) found = parsed
    }
  }
  return found
}
