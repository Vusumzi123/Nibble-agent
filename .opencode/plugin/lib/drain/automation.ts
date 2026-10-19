// Titles owned by the agent's own child sessions.
//
// The pipe spawns a summarizer and a writer per batch; the heartbeat and dream
// schedulers spawn a mission child per tick (`heartbeat:<mission>` /
// `dream:<mission>`). All of them are top-level sessions, so discovery must
// exclude them by title — otherwise every run re-ingests its own transcripts
// and the queue grows faster than it drains. Mission children are excluded
// because those missions already record their outcomes in the vault and the
// tick ledger; draining their transcripts is redundant.
//
// Loaded via relative import only.

export const SUMMARIZER_SESSION_TITLE = "drain-summarize"
export const WRITER_SESSION_TITLE = "knowledge-consolidate"

/** Single source of truth: spawn sites and discovery both import this. */
export const AUTOMATION_SESSION_TITLES: readonly string[] = [
  SUMMARIZER_SESSION_TITLE,
  WRITER_SESSION_TITLE,
]

/** Mission child titles are `heartbeat:<id>` / `dream:<id>`, never fixed. */
export const AUTOMATION_SESSION_PREFIXES: readonly string[] = ["heartbeat:", "dream:"]

export function isAutomationSessionTitle(title: unknown): boolean {
  return (
    typeof title === "string" &&
    (AUTOMATION_SESSION_TITLES.includes(title) ||
      AUTOMATION_SESSION_PREFIXES.some((prefix) => title.startsWith(prefix)))
  )
}
