# Drain producer plan

Status: proposed, not implemented
Date: 2026-11-01
Project: `/home/vuszi/Projects/Agents/Kael/projects/Nibble-agent`
All paths below are relative to this project root. Run every command from it.
Scope: `.opencode/plugin/lib/chron/jobs/drain.ts`,
`.opencode/plugin/lib/chron/jobs/index.ts`, drain-job tests, config docs
Related: `docs/CHRON-SCHEDULER-PLAN.md` §6.4,
`wiki/Mission-Producers.md`, `docs/sysop-config-reference.md`

## 1. Goal

Make the existing chron drain job a deterministic producer that reads
`drain.producer_interval_minutes` on every scan, decides from the unconsumed
backlog count and the oldest pending turn whether a `drain-pass` job is due,
and writes at most one durable intent per interval with its own persistent
dedupe state.

## 2. Scope decision: drain is not a mission file

Drain is a work kind (`drain-pass`), not a markdown mission. The existing
design says: "Non-agent work such as drain is not a mission file: it is a
standalone chron code job emitting its own intent kind"
(`docs/CHRON-SCHEDULER-PLAN.md` §6.2).

This plan therefore does **not** add `.opencode/missions/drain.md`, does not
register a `MissionProducer` in `lib/production/registry.ts`, and does not
route drain through mission execution. A `MissionProducer` returns `WorkItem`s
for the mission pipeline; drain must execute the drain pipe, not spawn a
mission child.

"Custom producer" here means the dedicated drain producer and its own
gate/state. If the intent was a mission-file `producer:` owner, stop and
reframe the request: that is a different design and would change what executes.

## 3. Current behavior and gaps

Current flow:

1. `registerCodeJobs()` reads `drain.producer_interval_minutes` once at
   startup and registers the `drain` cron job at
   `every max(1, producer_interval_minutes)m`.
2. On every fire, `runDrainScan()` in
   `.opencode/plugin/lib/chron/jobs/drain.ts` reads `drain.enabled`, calls
   `drainDue()` (`lib/drain/step.ts`), checks `work-queue.json` for an
   existing `drain-pass`, and writes a `chron:drain` intent with id
   `drain-pass`, kind `drain-pass`, priority 3.
3. `drainDue()` checks:
   - `drain.enabled`;
   - cursor `blocked_until` backoff;
   - `effectiveCursorLastTs()` and per-session marks;
   - `countUnconsumed()`;
   - `oldestPendingAge()`;
   - `pending >= trigger_pending` or
     `oldest_age_ms >= trigger_max_age_hours * 3_600_000`.
4. Dedupe today is two layers: the queued `drain-pass` id and the intent file
   existence checked by `writeIntent()`.

Gaps against the requested producer:

| Gap | Consequence |
| --- | --- |
| Frequency is read only at registration | Changing `producer_interval_minutes` needs an opencode restart. |
| No producer-owned dedupe state | A restart or an externally cleared queue can produce a second pass sooner than the configured interval. Queue/intent dedupe prevents duplicates only while those records exist. |
| Decision logic is mixed with I/O | The cooldown, queue check, due check, and intent write are one procedural block; boundary cases are harder to test as one contract. |
| Report lacks evidence | `DrainScanReport` is `{ emitted, reason }`; it does not return the backlog count or oldest age. |
| Backoff and DB failure are conflated | `drainDue()` returns `pending: null` for both. This plan reports both as `unavailable`; it does not change `drainDue()` to distinguish them. |

Keep `drainDue()` as the single trigger implementation. Do not duplicate the
trigger formula in the producer.

## 4. Target design

```
chron drain clock (every 1m, fixed)
  -> runDrainScan()
       -> read drain config (hot)
       -> read producer state (last emitted)
       -> gate: enabled / cooldown
       -> read queue + check intent (dedupe)
       -> drainDue()  (backlog count + oldest age + cursor backoff)
       -> map due/not-due to a reason
       -> writeIntent("chron:drain", "drain-pass")
       -> save producer state only after a successful, non-deduped write
  -> consumer merges inbox -> work-queue.json
  -> drain-pass execution -> runDrainStep()
```

The producer never writes `work-queue.json`, never runs a drain pass, and never
opens an LLM session.

### 4.1 Clock versus frequency

The chron code job is a **clock**, not the frequency policy. Register it at a
fixed `every 1m`. The producer reads `producer_interval_minutes` on every scan
and enforces it with `last_emitted_ms`.

Why this works:

- `chron.register()` stores the schedule at plugin load
  (`lib/chron/registry.ts`), so a schedule registered from config cannot be
  changed without a restart.
- `readDrainConfig()` calls `readSection()`, which reads
  `.opencode/sysop-config.yaml` on every call (`lib/config.ts:461-482`), so the
  interval is hot-read.
- Chron's tick uses `occurrence(job.schedule, at, entry.last_fired_ms)` and
  ignores the persisted `next_due_ms` for the due decision
  (`lib/chron/chron.ts:252`). Changing the job from `every 15m` to `every 1m`
  therefore fires on the first tick if the last fire is already older than one
  minute; it does not wait for the old 15-minute next-due.
- The 1-minute clock is the same cadence as the generic mission scan
  (`chron.mission_scan` defaults to `every 1m`). The cooldown gate returns
  before any queue or DB read when the interval has not elapsed.

Tradeoff: `chron.list()` shows `every 1m` for the `drain` job, not the effective
interval. Document this in the config reference.

### 4.2 Decision order

The producer evaluates these gates in order and stops at the first match.

| Order | Gate | Emit? | Reason |
| --- | --- | --- | --- |
| 1 | `drain.enabled` is false | no | `disabled` |
| 2 | `now - last_emitted_ms < interval_ms` | no | `cooldown` |
| 3 | `work-queue.json` contains `drain-pass` | no | `queued` |
| 4 | An inbox intent for `drain-pass` exists | no | `pending-intent` |
| 5 | `drainDue()` returns `due: false` with `pending === null` | no | `unavailable` |
| 6 | `drainDue()` returns `due: false` with `pending === 0` | no | `empty` |
| 7 | `drainDue()` returns `due: false` with `pending > 0` | no | `below-trigger` |
| 8 | All gates pass | yes | `emitted` |

`disabled`, `cooldown`, `queued`, and `pending-intent` are checked before the
DB. `unavailable`, `empty`, and `below-trigger` come from `drainDue()`.

`unavailable` covers cursor backoff, DB unavailability, and a thrown due check.
The producer does not distinguish them; none should emit.

`config-error` and `write-failed` are I/O outcomes, not trigger gates:

| Outcome | When |
| --- | --- |
| `config-error` | `readDrainConfig()` throws |
| `write-failed` | `writeIntent()` returns `ok: false` |

The trigger itself stays in `drainDue()` and is unchanged:

```ts
due =
  pending !== null &&
  (pending >= trigger_pending ||
    (oldest_age_ms !== null &&
      oldest_age_ms >= trigger_max_age_hours * 3_600_000))
```

`pending` is the unconsumed turn count from `countUnconsumed()`;
`oldest_age_ms` is `now - oldestUnconsumedTs` from `oldestPendingAge()`.
Boundaries are inclusive.

### 4.3 Frequency arithmetic

```ts
function intervalMs(minutes: number): number {
  const n =
    Number.isFinite(minutes) && minutes >= 1
      ? Math.floor(minutes)
      : DEFAULT_DRAIN.producer_interval_minutes
  return n * 60_000
}

cooling =
  last_emitted_ms > 0 &&
  now - last_emitted_ms < intervalMs
```

- The boundary is inclusive: `now - last_emitted_ms === intervalMs` may emit.
- A missing or zero `last_emitted_ms` allows an immediate first emit.
- Any `last_emitted_ms > now` is invalid. Reset it to `0`, persist `0`
  best-effort, and log a warning. This covers both clock rollback and a corrupt
  future value; there is no partial cooldown window.
- Config values below 1, `NaN`, or non-finite fall back to the shipped default
  (15 minutes). The config reader already does this for YAML values; the
  producer repeats it for injected/test configs.
- A config change takes effect on the next scan. Increasing the interval can
  delay the next emit; decreasing it can allow an earlier emit.
- `last_emitted_ms` records the last **intent write**, not the last drain pass
  execution.

Semantic change: `producer_interval_minutes` currently sets the chron job
cadence. It becomes the minimum interval between emitted intents, with a
1-minute clock. The effective drain cadence is the same or slightly tighter
(first check after the interval, not at a fixed 15-minute boundary). Document
this in `docs/sysop-config-reference.md`.

### 4.4 Producer state

New file: `.opencode/state/drain-producer.json` (leaf under the resolved state
directory, not configurable in this phase).

```json
{
  "version": 1,
  "last_emitted_ms": 1760000000000
}
```

Rules:

- Missing, empty, malformed, unsupported `version`, or a negative/non-finite
  timestamp yields `{ version: 1, last_emitted_ms: 0 }`; the producer still
  works and relies on queue/inbox dedupe.
- State is written with `atomicWrite()` from `lib/fsx.ts`. `atomicWrite()`
  creates the parent directory, so a missing state directory is not an error.
- The state file is written **after** `writeIntent()` succeeds and is not
  deduped. If the state save fails, log a warning; the intent is already
  durable, and queue/inbox dedupe remains the safety net.
- If `writeIntent()` returns `deduped: true`, report `pending-intent` and do
  **not** advance `last_emitted_ms`; the existing intent is the record.
- Delete the file to reset the cooldown. There is no migration.

Why a separate state file instead of `chron.json`:

- `chron.json` is scheduler-owned occurrence bookkeeping; `pruneMissingJobs()`
  can remove entries for jobs that disappear. A producer cooldown should not be
  coupled to that lifecycle.
- The consumer never writes this file, so it cannot be clobbered by a queue
  save.
- A separate file can be inspected or deleted without touching scheduling.

### 4.5 Intent contract and in-flight limits

Keep the existing work id, kind, and priority:

```json
{
  "version": 1,
  "id": "drain-pass",
  "kind": "drain-pass",
  "producer": "chron:drain",
  "priority": 3,
  "enqueued_ms": 1760000000000
}
```

- No `expires_ms`: a drain pass does not expire like a primary mission.
- No new payload. The current execution path ignores it, and adding diagnostic
  fields would expand the intent contract for no scheduling benefit.
- `writeIntent()` remains the final idempotency boundary. Its existence check
  is best-effort under concurrency; chron's `chron.lock` serializes code-job
  ticks, and `atomicWrite()` ensures one file per id.

Important limit: the queue dedupe covers only the queued window. The consumer
dequeues an item and saves the queue before running it
(`heartbeat-hook.ts:1206`), so during a long drain pass `work-queue.json` no
longer contains `drain-pass`. The producer cooldown is the only guard during
execution. If `producer_interval_minutes` is shorter than the pass wall time, a
second intent can be emitted and a later consumer session runs it after the
first. This plan accepts that; it does not add an in-flight marker check.

### 4.6 Report shape

Extend the existing report; keep the exported names and update the job's own
test assertions for the added fields:

```ts
type DrainScanReport = {
  emitted: boolean
  reason:
    | "emitted"
    | "disabled"
    | "config-error"
    | "cooldown"
    | "queued"
    | "pending-intent"
    | "unavailable"
    | "empty"
    | "below-trigger"
    | "write-failed"
  pending: number | null
  oldest_age_ms: number | null
}
```

`pending` and `oldest_age_ms` are `null` when the gate returns before the DB
(`disabled`, `cooldown`, `queued`, `pending-intent`, `config-error`).

`DrainScanDeps` gains test seams. The production defaults close over
`deps.stateDir` and `deps.inboxDir`:

```ts
readConfig?: () => Promise<DrainConfig>
readQueue?: () => Promise<{ items: Array<{ id: string }> }>
intentExists?: () => boolean
readState?: () => Promise<DrainProducerState>
saveState?: (state: DrainProducerState) => Promise<boolean>
```

No success log is added. Chron already logs each fire in `chron.log`. The
producer calls `log.warn` for a config failure, a thrown queue/intent read, a
`write-failed` result, and a state save failure.

## 5. Files

| File | Action | Purpose |
| --- | --- | --- |
| `.opencode/plugin/lib/chron/jobs/drain.ts` | edit | Producer state, pure decision helper, cooldown, extended `runDrainScan()`. |
| `.opencode/plugin/lib/chron/jobs/drain.test.ts` | edit | Boundary, dedupe, state, and orchestration tests. |
| `.opencode/plugin/lib/chron/jobs/index.ts` | edit | Register `drain` at fixed `every 1m`; remove the startup config read used for the schedule. |
| `.opencode/plugin/lib/chron/chron.test.ts` and/or `chron-e2e.test.ts` | edit | Upgrade test with a persisted old `last_fired_ms`. |
| `docs/sysop-config-reference.md` | edit | Hot-read frequency, 1-minute clock, state file, semantic change. |
| `.opencode/sysop-config.example.yaml` | edit comment | Say the key is a hot-read emission interval, not the chron clock. |
| `wiki/Mission-Producers.md` | edit (optional) | One note: drain is a dedicated work producer, not a `MissionProducer`. |

No changes to `lib/work-queue.ts`, `lib/production/intents.ts`,
`lib/drain/step.ts`, `lib/drain/pipe.ts`, or the consumer loop. `drainDue()`
already accepts `readConfig` and `now`; use those existing options. If the
implementation needs a `drainDue()` signature change, stop and revise this
plan.

This plan file is unignored via `.gitignore` (`!docs/DRAIN-PRODUCER-PLAN.md`)
so it can be reviewed with the change.

No `CHRON_CODE_FILES` change is needed because no new module is added.

## 6. Implementation steps

Each step is one diff, one command-based acceptance check, and one commit. Do
not batch steps. Commit only after the step's check passes, and keep each commit
limited to that step's files. If a check fails, fix it within the same step and
do not commit until it passes.

### Step 1: Add the pure decision helper and interval normalizer

In `lib/chron/jobs/drain.ts`, add and export:

```ts
export function normalizeIntervalMs(minutes: number): number
export type DrainDecisionInput = {
  now_ms: number
  interval_ms: number
  last_emitted_ms: number
  enabled: boolean
  queued: boolean
  intent_pending: boolean
  due: boolean
  pending: number | null
  oldest_age_ms: number | null
}
export type DrainDecision = {
  emit: boolean
  reason: DrainScanReport["reason"]
}
export function decideDrainProduction(input: DrainDecisionInput): DrainDecision
```

The helper has no I/O and no clock. It implements §4.2 in order. It does not
recompute the trigger; the caller passes `due` from `drainDue()`.

**Acceptance:** `node --test .opencode/plugin/lib/chron/jobs/drain.test.ts`
passes. The new tests cover every gate in §4.2, `pending`/`oldest` boundaries
from §7, and `normalizeIntervalMs` for `0`, negative, `NaN`, `Infinity`,
fractional, and valid values.

**Commit:** `Add the drain producer decision helper`

### Step 2: Add producer state read/write

Add to the same file:

```ts
export const DRAIN_PRODUCER_STATE_FILE = "drain-producer.json"
export type DrainProducerState = {
  version: 1
  last_emitted_ms: number
}
export async function readDrainProducerState(stateDir: string): Promise<DrainProducerState>
export async function saveDrainProducerState(
  stateDir: string,
  state: DrainProducerState,
): Promise<boolean>
export function effectiveLastEmitted(
  last_emitted_ms: number,
  now_ms: number,
  interval_ms: number,
): number
```

Read behavior: missing/corrupt/wrong version -> `{ version: 1,
last_emitted_ms: 0 }`; never throw. Save behavior: `atomicWrite()`, return
`false` on failure; never throw.

`effectiveLastEmitted()` treats any value greater than `now_ms` as `0`. When
`runDrainScan()` sees a future value, it persists `0` best-effort and logs a
warning.

**Acceptance:** `node --test .opencode/plugin/lib/chron/jobs/drain.test.ts`
passes state tests for missing, valid, corrupt, wrong version, future
timestamp, save failure, and a missing state directory. The future test asserts
the stored state is reset to `0` and the warning is logged.

**Commit:** `Persist the drain producer cooldown state`

### Step 3: Wire the producer into `runDrainScan()`

Extend `DrainScanDeps` with the seams in §4.6. Production defaults:

```ts
readState ?? (() => readDrainProducerState(deps.stateDir))
saveState ?? ((state) => saveDrainProducerState(deps.stateDir, state))
readQueue ?? (() => loadWorkQueueState(join(deps.stateDir, WORK_QUEUE_FILE)))
intentExists ?? (() => existsSync(intentPath(deps.stateDir, "chron:drain",
  "drain-pass", deps.inboxDir)))
```

`runDrainScan()`:

1. Read config; on throw log and return `config-error`.
2. Return `disabled` when `!cfg.enabled`.
3. Read producer state; compute `interval_ms` and `effectiveLastEmitted`.
   A thrown state read is logged and returned as `unavailable`.
4. Read the queue and check `drain-pass` only when not cooling. If queued,
   return `queued`. A thrown queue read is logged and returned as `unavailable`.
5. Check the inbox intent path only when not cooling/queued. If pending,
   return `pending-intent`. A thrown intent check is logged and returned as
   `unavailable`.
6. Call `drainDue()` with `readConfig: async () => cfg` and `now`; wrap it in
   `try/catch`. Map `!due.due` as in §4.2. A throw is logged and returned as
   `unavailable`.
7. On `due`, call `writeIntent()` with the existing contract inside `try/catch`.
   A throw is logged and returned as `write-failed`.
8. On `!ok`, log and return `write-failed`; do not save state.
9. On `deduped`, return `pending-intent`; do not save state.
10. On a new write, save state with `last_emitted_ms = now`; on save failure,
    log a warning and still return `emitted`.

Keep `runDrainScan` and `DrainScanReport` names. `rg -n
"runDrainScan|DrainScanReport" .opencode/plugin` should show only
`lib/chron/jobs/drain.ts` and its test; if another importer appears, adapt it
rather than renaming.

**Acceptance:** `node --test .opencode/plugin/lib/chron/jobs/drain.test.ts`
passes the orchestration table in §7. It must prove:

- a due backlog writes exactly one intent and one state update;
- a second run inside the interval returns `cooldown` and does not touch the
  queue, inbox, or DB;
- a queued `drain-pass` returns `queued` and does not write;
- an existing inbox intent returns `pending-intent` and does not advance state;
- a DB failure returns `unavailable` and does not write;
- `drain.enabled: false` returns `disabled` and does not read the queue or DB;
- a thrown state/queue/intent read returns `unavailable` and logs;
- `writeIntent` failure or throw returns `write-failed`, logs, and does not save
  state;
- a state save failure still reports `emitted` and logs a warning.

**Commit:** `Wire drain producer dedupe and reports`

### Step 4: Register the fixed clock and verify upgrade behavior

In `lib/chron/jobs/index.ts`, keep the created handler and register:

```ts
const drainScan = createDrainScan({ ... })
chron.register({
  id: "drain",
  schedule: "every 1m",
  handler: async () => {
    await drainScan()
  },
})
```

Remove the startup `readDrainConfig()` call used only for the schedule. Keep
the startup `readChronConfig()` for the mission scan.

Add a test with a seeded `chron.json` for the `drain` job whose
`last_fired_ms` is five minutes old, register the new `every 1m` schedule, and
assert the first `tick()` fires `drain`. This proves the schedule change does
not wait for the old 15-minute next-due. A recent `last_fired_ms` (for example
10 seconds old) should wait for the new 1-minute boundary.

**Acceptance:** `node --test .opencode/plugin/lib/chron/chron.test.ts
.opencode/plugin/lib/chron-e2e.test.ts` passes. The upgrade test covers the old
`last_fired_ms` cases. `rg -n "producer_interval_minutes|readDrainConfig"
.opencode/plugin/lib/chron/jobs/index.ts` returns nothing.

**Commit:** `Run the drain producer on a one-minute clock`

### Step 5: Update config documentation and example comments

Update `docs/sysop-config-reference.md`:

- `producer_interval_minutes` is hot-read on every 1-minute chron clock.
- It is the minimum interval between emitted `drain-pass` intents, not the
  chron clock and not the drain-pass execution duration.
- The producer state is `state/drain-producer.json`; deleting it resets the
  cooldown.
- `trigger_pending` and `trigger_max_age_hours` are unchanged and inclusive.
- This changes the old meaning (chron job cadence) to an emission interval.

Update the `.opencode/sysop-config.example.yaml` comment for the key. Do not
change its default.

Optionally add one sentence to `wiki/Mission-Producers.md`: drain is a
dedicated work producer, not a `MissionProducer`; custom mission producers are
for mission files.

Do not add a `CHANGELOG.md` entry; this repository has no enforced
changelog-per-change convention.

**Acceptance:** `git diff --check` is clean and the docs name the state file,
1-minute clock, hot-read behavior, and semantic change. No code test is
required for this step.

**Commit:** `Document the drain producer frequency and state`

### Step 6: Add integration coverage and run the full suite

Add one deterministic integration test in `drain.test.ts` instead of a manual
smoke check:

1. Seed a temp state dir with a fixture backlog (or inject `due`/`pending`).
2. Run the producer once: exactly one `drain-pass` intent appears and state has
   `last_emitted_ms`.
3. Run again immediately: `cooldown`, still one intent.
4. Seed a queued `drain-pass` and advance past the interval:
   `queued`, still one intent.
5. Set `drain.enabled: false`: `disabled`, no new intent.

Then run:

```bash
find .opencode/plugin/lib -name '*.test.ts' -print0 | xargs -0 node --test
```

**Acceptance:** each integration report reason matches, the intent count is
exactly one in the emitted cases, no test sleeps, and the full suite passes
with zero failures. The baseline observed on 2026-11-01 before this change is
962 pass, 0 fail; do not require the exact count, only `fail 0`.

**Commit:** `Add drain producer integration coverage`

## 7. Test matrix

| # | Scenario | Expected |
| --- | --- | --- |
| 1 | `drain.enabled: false` | `disabled`; no queue, DB, or intent read; `pending`/`oldest` null |
| 2 | `pending: 0`, oldest `null` | `empty` |
| 3 | `pending: trigger_pending - 1`, oldest below threshold | `below-trigger` |
| 4 | `pending: trigger_pending`, oldest below threshold | `emitted` |
| 5 | `pending: trigger_pending - 1`, oldest exactly threshold | `emitted` |
| 6 | `pending: trigger_pending - 1`, oldest threshold - 1 ms | `below-trigger` |
| 7 | `pending: null` from DB failure/backoff | `unavailable`; no intent |
| 8 | queue contains `drain-pass` | `queued`; no DB read, no intent; `pending`/`oldest` null |
| 9 | inbox contains `drain-pass` | `pending-intent`; no DB read, no intent; `pending`/`oldest` null |
| 10 | `last_emitted_ms = now - interval + 1` | `cooldown`; no DB read; `pending`/`oldest` null |
| 11 | `last_emitted_ms = now - interval` | allowed to emit |
| 12 | `last_emitted_ms` is in the future (any amount) | reset to 0, warning logged, emits if due |
| 13 | state file corrupt | treated as empty; emits if due |
| 14 | state save fails after intent write | `emitted`, warning logged, intent exists |
| 15 | `writeIntent` returns `deduped` | `pending-intent`, state unchanged |
| 16 | two sequential producer calls in the same millisecond | one intent total; second is cooldown |
| 17 | config read throws | `config-error`; no state write |
| 18 | real `sysop-config.yaml` changes 15 -> 1 between scans | next scan observes the new interval without re-registering |
| 19 | persisted `chron.json` has an old 15-minute last fire | first 1-minute tick fires; no 15-minute delay |
| 20 | persisted `chron.json` has a 10-second-old last fire | first tick waits for the 1-minute boundary |
| 21 | `readState()`, `readQueue()`, or `intentExists()` throws | `unavailable`; warning logged |
| 22 | `writeIntent()` fails or throws | `write-failed`; warning logged; no state write |

Boundary values use an injected clock; no test sleeps.

## 8. Non-goals

- Changing the drain pipe, summarizer, writer, cursor schema, or provider
  selection.
- Changing `trigger_pending` or `trigger_max_age_hours` semantics.
- Changing the fair scheduler, queue ordering, or consumer session caps.
- Adding a mission file for drain.
- Running a drain pass from the producer.
- Adding autonomy-level gating. Drain currently runs independently of
  `autonomy.level`; this plan preserves that behavior. An autonomy gate is a
  separate policy decision because it changes maintenance at level 0.
- Combining the backlog count and oldest-age queries.
- A dashboard panel or a new success log line.
- An in-flight marker check for a currently running drain pass. Queue dedupe
  does not cover execution; §4.5 documents the stacking limit.
- A separate `lib/drain/producer.ts` module. The simplest path is to keep the
  producer in the existing chron job file; see §11.

## 9. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| The 1-minute clock makes `chron.log` noisier | No new success log. Chron's existing fire line is the only recurring line; the producer returns before DB work when cooling. |
| `chron.list()` shows `every 1m` while the effective interval is 15m | Document it in `docs/sysop-config-reference.md`. |
| A clock rollback or corrupt future timestamp causes a long cooldown | Any value greater than `now` is reset to 0. |
| A state write failure lets a second intent appear sooner | The queue and inbox gates still dedupe while the first intent exists. The worst case is a new intent after the first is consumed, bounded by the 1-minute check interval. |
| The producer writes an intent that the consumer never merges | Existing behavior: intents are durable in `state/inbox/`. The producer never bypasses the consumer. |
| A long drain pass allows a second intent after the cooldown | The consumer is serialized and runs the second pass after the first. Document the recommendation that `producer_interval_minutes` should be at least the expected pass wall time. |
| The producer holds no lease | Chron's `chron.lock` serializes code-job ticks; `writeIntent` dedupe is the second layer. Do not add a producer lock. |
| Backoff and DB failure are indistinguishable | Both return `unavailable` and neither emits; this is a reporting limitation, not a scheduling one. |
| The semantic change in `producer_interval_minutes` surprises an operator | Document it in the reference and example. With the default 15, the effective cadence remains roughly 15 minutes. |

## 10. Rollout and rollback

- No data migration. The producer state file is created on the first successful
  emit.
- Existing `chron.json` state is compatible: the due decision uses
  `last_fired_ms`, not the persisted `next_due_ms`, so the first 1-minute tick
  fires if the last drain fire is already older than one minute.
- To reset the cooldown, delete `.opencode/state/drain-producer.json`.
- To disable production without touching code, set `drain.enabled: false`.
  The chron clock still fires every minute but returns `disabled` before any
  DB read.
- Reverting the implementation commit restores the current `runDrainScan()`
  behavior; no queue or cursor schema changes are involved.
- Existing queued `drain-pass` items are unaffected. A restart after deploying
  this plan can merge any pre-existing inbox intent.

## 11. Alternatives considered

1. **Keep the job schedule at `every N m` and only add state.** Rejected: the
   frequency would still require a restart, which is the first gap in §3. If
   the operator accepts a restart, this is the smaller change and Step 4 can be
   dropped.
2. **Put the cooldown in `chron.json`.** Rejected: chron state is
   scheduler-owned and `pruneMissingJobs()` removes entries for jobs that
   disappear; a producer policy field should not share that lifecycle.
3. **Extract `lib/drain/producer.ts` and a versioned state schema.** Rejected
   for this change: it adds a module, test file, stale-code entry, and a
   migration surface for a single timestamp. The existing chron job file is the
   natural home; it already owns the producer's dedupe and intent write.
4. **Fingerprint the backlog and suppress repeat intents until it changes.**
   Rejected: a failed pass with an unchanged backlog must retry after the
   interval, not wait for new turns.
5. **Add autonomy-level gating.** Rejected: it changes existing behavior and
   is outside the goal.
6. **Add an in-flight marker check.** Considered to prevent a second pass while
   the first runs. Rejected for this change because it couples the producer to
   `heartbeat.current.json` and needs a stale-marker rule. The cooldown plus
   the serialized consumer are sufficient; the limitation is documented.

## 12. Open questions resolved by this plan

1. **Is drain a mission?** No. It is a `drain-pass` work kind; there is no
   `.opencode/missions/drain.md`.
2. **Does the producer write the queue?** No. It writes one intent; the
   heartbeat consumer remains the only `work-queue.json` writer.
3. **What does "frequency" mean?** The minimum interval between emitted
   `drain-pass` intents, hot-read from `drain.producer_interval_minutes`. It is
   not the chron clock and not the pass duration.
4. **What is "oldest item"?** The activity time of the oldest unconsumed turn
   after the cursor/watermark and per-session marks, returned as an age by
   `oldestPendingAge()`.
5. **What does "own dedupe" mean?** A persisted `last_emitted_ms` cooldown,
   plus the existing queue-id and inbox-intent checks, plus `writeIntent`'s
   final idempotency check.
