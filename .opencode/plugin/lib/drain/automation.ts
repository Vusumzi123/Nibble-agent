// Titles owned by the drain pipe's own child sessions.
//
// The pipe spawns a summarizer and a writer per batch. Those children are
// top-level sessions (there is no parent session for an in-process runner), so
// discovery must exclude them by title — otherwise every run re-ingests its own
// transcripts and the queue grows faster than it drains.
//
// Loaded via relative import only.

export const SUMMARIZER_SESSION_TITLE = "drain-summarize"
export const WRITER_SESSION_TITLE = "knowledge-consolidate"

/** Single source of truth: spawn sites and discovery both import this. */
export const AUTOMATION_SESSION_TITLES: readonly string[] = [
  SUMMARIZER_SESSION_TITLE,
  WRITER_SESSION_TITLE,
]

export function isAutomationSessionTitle(title: unknown): boolean {
  return typeof title === "string" && AUTOMATION_SESSION_TITLES.includes(title)
}
