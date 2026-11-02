// Shared chron types. Kept separate so the registry and the core can agree on
// the handler contract without one importing the other at runtime.
//
// Loaded via relative import only.

export type FireEvent = {
  id: string
  source: "file" | "code"
  occurrence_ms: number
  fired_at_ms: number
  late: boolean
  payload?: unknown
}

export type HandlerResult = void | { defer: true }

export type ChronLog = {
  event: (entry: Record<string, unknown>) => void
  warn: (message: string, err?: unknown) => void
}
