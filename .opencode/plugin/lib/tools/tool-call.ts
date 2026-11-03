// Read typed tool-call arguments from a child session transcript.
//
// `mission_result` established the pattern: the child calls a schema-validated
// tool and the coordinator reads the last call from the message rows. The
// drain reports use the same surface instead of parsing LLM-formatted prose.
//
// Loaded via relative import only.
export function normalizeToolArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** Last call of `name` in a message array, or null when it was never called. */
export function lastToolCall(rows: unknown[], name: string): unknown | null {
  let found: unknown = null
  for (const row of rows ?? []) {
    const parts = (row as { parts?: unknown })?.parts
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (!part || typeof part !== "object") continue
      const p = part as Record<string, any>
      if (p.type !== "tool" || p.tool !== name) continue
      const input = p.state?.input ?? p.state?.output
      if (input !== undefined) found = normalizeToolArgs(input)
    }
  }
  return found
}
