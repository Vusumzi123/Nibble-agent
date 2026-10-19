// Titles owned by the agent's own child sessions.
//
// The pipe spawns a summarizer and a writer per batch; the heartbeat and dream
// schedulers spawn a mission child per tick (`heartbeat:<mission>` /
// `dream:<mission>`). All of them are top-level sessions, so discovery must
// exclude them by title — otherwise every run re-ingests its own transcripts
// and the queue grows faster than it drains.
//
// Mission children are excluded selectively: `drain.exclude_missions` in
// sysop-config.yaml lists the missions that already record their outcomes in
// the vault and the tick ledger. Other missions stay eligible for
// consolidation.
//
// Loaded via relative import only.

export const SUMMARIZER_SESSION_TITLE = "drain-summarize"
export const WRITER_SESSION_TITLE = "knowledge-consolidate"

/** Titles owned by the drain pipe itself, regardless of config. */
export const PIPE_SESSION_TITLES: readonly string[] = [
  SUMMARIZER_SESSION_TITLE,
  WRITER_SESSION_TITLE,
]

/** Mission children are titled `<source>:<mission-id>`. */
const MISSION_SOURCES: readonly string[] = ["heartbeat", "dream"]

/** Exact session titles to skip: pipe children + configured mission children. */
export function automationSessionTitles(
  excludeMissionIds: readonly string[],
): string[] {
  return [
    ...PIPE_SESSION_TITLES,
    ...MISSION_SOURCES.flatMap((source) =>
      excludeMissionIds.map((id) => `${source}:${id}`),
    ),
  ]
}

export function isAutomationSessionTitle(
  title: unknown,
  excludeMissionIds: readonly string[] = [],
): boolean {
  return (
    typeof title === "string" &&
    automationSessionTitles(excludeMissionIds).includes(title)
  )
}
