// Titles owned by the agent's own child sessions.
//
// The pipe spawns a summarizer and a writer per batch; the heartbeat and dream
// schedulers spawn a mission child per tick (`heartbeat:<mission>` /
// `dream:<mission>`). All of them are top-level sessions, so discovery must
// exclude them by title — otherwise every run re-ingests its own transcripts
// and the queue grows faster than it drains.
//
// Mission children are excluded selectively: only the missions that already
// record their outcomes in the vault and the tick ledger (drain, staleness).
// Other missions stay eligible for consolidation.
//
// Loaded via relative import only.

export const SUMMARIZER_SESSION_TITLE = "drain-summarize"
export const WRITER_SESSION_TITLE = "knowledge-consolidate"

/** Mission ids whose child transcripts are redundant with their own output. */
export const EXCLUDED_MISSION_IDS: readonly string[] = ["drain", "staleness"]

/** Mission children are titled `<source>:<mission-id>`. */
const MISSION_SOURCES: readonly string[] = ["heartbeat", "dream"]

/** Single source of truth: spawn sites and discovery both import this. */
export const AUTOMATION_SESSION_TITLES: readonly string[] = [
  SUMMARIZER_SESSION_TITLE,
  WRITER_SESSION_TITLE,
  ...MISSION_SOURCES.flatMap((source) =>
    EXCLUDED_MISSION_IDS.map((id) => `${source}:${id}`),
  ),
]

export function isAutomationSessionTitle(title: unknown): boolean {
  return typeof title === "string" && AUTOMATION_SESSION_TITLES.includes(title)
}
