# How mission producers work

Production and execution are separate. A **producer** decides that a mission
should run and writes durable work. The **heartbeat consumer** later merges that
work and runs it. A mission producer never writes `work-queue.json` and never
starts a child session.

The generic producer is a chron code job. It scans every mission's `schedule`,
applies the gates once per occurrence, and writes one intent per selected
mission. Custom producers use the same intent rail but own their own trigger.

```
chron mission scan (default every 1m)
  -> load missions + queue snapshot
  -> occurrence + gates
  -> priority sort + per-scan cap
  -> intent under state/inbox/
  -> consumer merges under its lease
  -> work-queue.json
  -> fair session -> mission child
```

## The generic scan

The scan lives in `lib/production/missions.ts` and is registered as the chron
code job `missions` (`lib/chron/jobs/index.ts`). It runs on
`chron.mission_scan` (default `every 1m`).

Each scan:

1. Reads the `chron:` config and gathers the heartbeat context. If
   `autonomy.level` is `0`, it returns without producing anything.
2. Loads `.opencode/missions/*.md` and the current work queue. The queue is read
   only to build a `queuedIds` set.
3. Builds the candidacy context from heartbeat signals, sleep state, the idea
   day, and last-run/gap state. Mood is not a production input.
4. For each mission, skips `enqueue: item` missions, skips missions owned by a
   custom producer, validates the schedule, and compares the schedule
   occurrence against the mission's own `last_evaluated_ms`.
5. Applies the gates once for a due occurrence. A failed gate consumes that
   occurrence; it does not retry later in the same window.
6. Sorts eligible missions by `priority` descending, then occurrence ascending,
   then id.
7. Takes up to `chron.mission_max_per_scan` (default `5`; `0` produces none).
8. Writes one intent per selected mission. On success, advances that mission's
   `last_evaluated_ms` to the occurrence.

The first time a mission is seen, the scan seeds `last_evaluated_ms = now` and
moves on. A new mission waits for its next occurrence instead of firing on the
next scan.

## Gates

A due occurrence is eligible only when all of these hold:

- `enabled: true`
- the current window is in `menus` (`day` when awake, `night` when quiet)
- `autonomy.level >= min_level`
- the `candidacy` predicate passes
- `mission:<id>` is not already in the queue

If any gate fails, or the mission is already queued, the scan advances
`last_evaluated_ms` to the occurrence. The occurrence is consumed. The next
chance is the next schedule occurrence, not the next scan.

Candidacy predicates are evaluated once per occurrence:

| Predicate | Passes when |
| --- | --- |
| `always` | Always. |
| `backlog-pending` | The un-consolidated backlog has at least one turn. |
| `brain-stale` / `brain-stale:<hours>` | The oldest refreshable reference note is at least that old. |
| `dream-gate` | Sleep status is `dreaming`, the nightly cap is not reached, and the dream roll passes. |
| `idea-roll` | The day's idea target is not yet met. |
| `min-gap:<key>` | The recorded last run for that key is old enough. Only `express` sets a non-zero gap today. |
| `roll:<chance>` | A random roll is below the chance. |

The predicate list and the exact checks live in
`lib/heartbeat.ts` (`candidacyPasses`).

## Ordering and the per-scan cap

Eligible work is ordered by:

1. `priority` descending (0–9, default `5`)
2. occurrence time ascending (older first)
3. mission id

`chron.mission_max_per_scan` bounds how many intents one scan may write. It is
not a cap on occurrences: missions that do not fit stay eligible and are
re-evaluated on the next scan. `0` pauses generic production without changing
any mission file.

There is no frequency weight and no mood-weighted draw. The old
`frequency × mood` lottery is gone; the schedule decides when, and priority
decides order.

## The intent

A selected mission becomes an intent under the state inbox:

```json
{
  "version": 1,
  "id": "mission:research",
  "kind": "mission",
  "producer": "chron:missions",
  "enqueued_ms": 1760000000000,
  "priority": 5,
  "expires_ms": 1760086400000,
  "payload": {
    "mission": "research",
    "occurrence_ms": 1760000000000,
    "signals": {},
    "level": 3,
    "quiet": false,
    "sleep_status": "awake"
  }
}
```

- The id is `mission:<id>`; the consumer uses it to find the mission.
- `kind` is `staleness` for `brain-stale*`, otherwise `mission`.
- `expires_ms` is the standard primary TTL (24 hours).
- The payload records the decision context. Execution rebuilds the brief from
  live state; the payload is not the prompt.

If an intent file for the same id already exists, the write is deduped and the
scan treats it as success. That is why a second scan before the consumer merges
cannot stack the same occurrence.

## The handoff

The heartbeat consumer calls `mergeIntents` under its own lease. The merge:

1. Reads the inbox and quarantines malformed files under `inbox/bad/`.
2. Prunes expired queue items and expired intents.
3. Dedupes by work id.
4. Accepts only up to the free queue capacity (`MAX_QUEUE_DEPTH`, 50). Overflow
   stays in the inbox for a later session.
5. Saves the queue with the checked writer.
6. Deletes accepted files only after a successful save; duplicate and expired
   files are removed either way.

The consumer then runs the work in a bounded fair session. A `mission` or
`staleness` item assembles the brief, records the dispatch, runs the child,
handles timeout/resume, and writes the ledger and backlog. A declined mission
drops its item; the next schedule occurrence can propose it again. If the
mission file disappeared before execution, the item settles as a silent
`no-reply`.

## Custom producers

A mission with `producer: <name>` is reserved for a registered custom producer.
The generic scan skips it. If the name is not registered, the scan warns once and
skips the mission.

Registering is code:

```ts
import { registerMissionProducer } from "./production/registry.ts"

registerMissionProducer({
  id: "my-producer",
  async produce(mission, ctx) {
    // return WorkItem[]; the caller writes them as intents
    return []
  },
})
```

The registry is a declaration and lookup, not a scheduler. It does not run
`produce` on a timer. A custom producer must have its own trigger (usually a
chron code job) and must write intents itself. Duplicate producer ids keep the
first registration. One owner per mission; dedupe by work id is the safety net,
not the routing.

`enqueue: item` is a different escape hatch. It marks a mission as owned by a
dedicated ingester, such as the `user-task` rail. The generic scan skips those
missions before it looks at `producer` or `schedule`.

## Configuration and the overlay

Scheduler knobs:

- `chron.mission_scan` — scan cadence (default `every 1m`). This is read when
  the code job registers, so changing it needs an opencode restart.
- `chron.mission_max_per_scan` — intents per scan (default `5`). Read on each
  scan.
- `chron.enabled` — if false at startup, the chron plugin does not start; turn
  it on and restart.
- `chron.inbox_dir` — intent spool leaf under the state directory.

The `autonomy.missions.<id>` overlay is restrict-only:

- `enabled: false` disables a mission; it cannot enable one the file disables.
- `min_level` may only be raised.
- `priority` may only be lowered.
- `menus` may only be narrowed.
- The overlay does not change `schedule`, `producer`, or `enqueue`.

## Mission frontmatter

| Key | Default | Effect on production |
| --- | --- | --- |
| `schedule` | none | Occurrence source for the generic scan. A generic mission without a valid schedule is skipped. |
| `priority` | `5` | Ordering; 0–9, higher first. The overlay may lower it. |
| `producer` | `generic` | `generic` uses the scan; any other value reserves the mission for a registered producer. |
| `enqueue` | `producer` | `item` skips the generic scan and hands the mission to its dedicated ingester. |
| `menus` | `[day]` | Window gate; `both` expands to day and night. |
| `min_level` | `2` | Minimum autonomy level. |
| `candidacy` | `always` | Predicate gate. |
| `enabled` | `true` | Master gate. |
| `agent` | empty | Child agent override; empty uses the heartbeat agent. |
| `approval` | `writes-follow-dial` | Execution-side policy, not a producer gate. |

## Observability and failure

- `.opencode/state/missions.json` — `last_evaluated_ms` per mission. This is
  producer state, separate from the dispatch history.
- `.opencode/state/inbox/` — pending intents. A full queue leaves them here.
- `.opencode/state/work-queue.json` — the merged queue.
- `.opencode/logs/chron.log` — code-job fire events and warn-once issues.
- `.opencode/state/heartbeat.json` — `last_runs`, used by `min-gap`
  candidacy.
- `.opencode/state/idea.json` — the idea day used by `idea-roll`.

Failure behavior:

- Intent write fails: the occurrence is not marked, so the next scan retries.
- Queue is full: the intent stays in the inbox and is retried after space frees.
- State save fails: the scan is logged; occurrences may repeat.
- Bad intent: quarantined, never blocks the merge.
- Consumer lease is held: the merge waits for the next session; the inbox is
  durable.

## Tests and source

```bash
node --test .opencode/plugin/lib/production/missions.test.ts \
  .opencode/plugin/lib/production/intents.test.ts \
  .opencode/plugin/lib/chron-e2e.test.ts
```

- [`production/missions.ts`](../.opencode/plugin/lib/production/missions.ts) —
  the scan.
- [`production/registry.ts`](../.opencode/plugin/lib/production/registry.ts) —
  custom producers.
- [`production/intents.ts`](../.opencode/plugin/lib/production/intents.ts) —
  intent write and merge.
- [`missions.ts`](../.opencode/plugin/lib/missions.ts) — frontmatter and the
  restrict-only overlay.
- [`heartbeat.ts`](../.opencode/plugin/lib/heartbeat.ts) — candidacy and the
  context snapshot.
- [`chron/jobs/index.ts`](../.opencode/plugin/lib/chron/jobs/index.ts) — the
  `missions` code job.
- [`docs/CHRON-SCHEDULER-PLAN.md`](../docs/CHRON-SCHEDULER-PLAN.md) — design.
