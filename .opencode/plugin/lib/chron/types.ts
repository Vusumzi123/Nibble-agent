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

/**
 * A handler/listener may defer (retry the same occurrence) and/or return a
 * small, non-secret `info` object. Chron merges every `info` into the fire log
 * line, so a producer can report its decision without writing its own log.
 */
export type HandlerResult =
  | void
  | { defer?: boolean; info?: Record<string, unknown> }

export type ChronLog = {
  event: (entry: Record<string, unknown>) => void
  warn: (message: string, err?: unknown) => void
}
