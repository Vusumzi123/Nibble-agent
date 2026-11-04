// Prompt model spec: config keeps "provider/model" strings; the SDK's
// promptAsync body wants { providerID, modelID }. One owner for the split so
// every prompt site (drain children, mission-resume, profile/soul hooks) sends
// the same shape.
//
// Loaded via relative import only.

export type PromptModel = { providerID: string; modelID: string }

/** Split "provider/model"; null when empty or malformed (caller omits model). */
export function splitModelSpec(spec: string): PromptModel | null {
  const m = spec.trim()
  const i = m.indexOf("/")
  if (i <= 0 || i === m.length - 1) return null
  return { providerID: m.slice(0, i), modelID: m.slice(i + 1) }
}

/** Body fragment for promptAsync: `{ model }` when the spec parses, else `{}`. */
export function modelField(spec: string | undefined): { model?: PromptModel } {
  const parsed = spec ? splitModelSpec(spec) : null
  return parsed ? { model: parsed } : {}
}
