# Chron Scheduler + Heartbeat Producer/Consumer Split

Status: implemented on `feat/chron-scheduler` (2026-11-01); full suite green, Appendix B covered by the e2e/session tests
Date: 2026-10-31
Target repo: `/home/vuszi/Projects/Agents/Kael/projects/Nibble-agent`
Live agent (DO NOT EDIT): `/home/vuszi/Projects/Agents/Kael` and `/home/vuszi/Projects/Agents/Kael/.opencode`
Branch: `feat/chron-scheduler` (create before Phase 1)

## 0. Read this first

- Every change in this plan lands in the **target repo above**. The live Kael
  tree is the running agent; do not edit it, do not copy files into it, and do
  not restart the live agent from this work.
- Create a dedicated branch before the first edit:

  ```bash
  cd /home/vuszi/Projects/Agents/Kael/projects/Nibble-agent
  git status --short          # must be clean; stop and ask if not
  git switch -c feat/chron-scheduler
  git branch --show-current   # must print feat/chron-scheduler
  ```

- Work one phase at a time. Each phase has one action and one acceptance check.
  Run the check, paste the real output into the Progress table, then continue.
  If a check fails twice, stop and revise the plan instead of improvising.
- The test runner is Node's. `node --test <directory>` does **not** work in this
  repo (Node 24 exits 1); use explicit files or `find`. The full suite is the
  final gate:

  ```bash
  npm --prefix .opencode ci                              # test-only deps
  node --test .opencode/plugin/lib/chron/*.test.ts       # narrow phase check
  find .opencode/plugin/lib -name '*.test.ts' -print0 | xargs -0 node --test
  ```

  The README baseline is 821 tests for root + drain; the `find` run covers all
  of `lib/` (verified 2026-10-31: 893 pass, 0 fail).

## Plan review (2026-10-31)

A fresh-context review against the target repo found gaps this revision now
covers: install `croner` (manifest + lock) and use the real test command; give
chron its own `state/chron.lock`; use a checked queue save before deleting
intents; accept only up to capacity instead of `cap()` eviction; check
`lease.refresh()` between items, not `held()`; make `no-runnable` sleep to
frequency; wire config readers, not YAML-only edits; let an explicit mission
priority win (`dream.md` stays 0); keep the inline producers alive until the
generic and drain replacements are running; and handle the dirty
`opencode.json` at branch time.

## 1. Goal

Decouple **production** from **execution**: chron decides when work exists and
writes durable intents; the heartbeat becomes a pure consumer that merges
intents and runs a bounded, fairly ordered session from the work queue.

Non-goals:

- No LLM work inside chron or inside producers. Producers are deterministic.
- No concurrent execution. One consumer session at a time, guarded by the
  existing ownership lease.
- No producer writes `work-queue.json`. The consumer stays the sole writer.
- No hand-rolled cron parser. Use `croner` for cron/DST correctness.
- No changes to the vault, Brain notes, or the live Kael `.opencode` tree.
- No new work kind for prompt jobs in v1; reuse the `user-task` rail.

## 2. Current state (baseline)

- The tick's producer block calls every handler's `produce` inline:
  `.opencode/plugin/heartbeat-hook.ts:1006-1033`.
- Mission intent is a weighted draw over `digest.candidates`
  (`lib/work-kinds/mission.ts:348-371`); `frequency` is a weight
  (`lib/heartbeat.ts:81-85, 286-296`), not a cadence.
- `priority: 0-9` already exists and orders items inside a kind
  (`lib/missions.ts:73-74`, `lib/work-queue.ts:330-338`).
- Drain production is inline via `drainDue()` (`lib/work-kinds/drain.ts:11-23`,
  `lib/drain/step.ts:55-96`).
- The consumer runs exactly one item per tick (`heartbeat-hook.ts:1037-1085`)
  and then schedules the next wake from `last_tick + frequency`
  (`lib/heartbeat.ts:696-701`).
- Failures already observed: drain writer hops inherit the 600 s mission stall
  window; queue overflow drops the oldest item; lazy cadences (12 h) starve
  queued work.
- `saveWorkQueueState` is best-effort and returns `void`
  (`lib/work-queue.ts:247-258`); delete-after-save needs a checked variant.
- `enqueueWork` caps by dropping the oldest (`lib/work-queue.ts:271-282`), so
  "reject new" requires a capacity-aware merge.
- `dream.md` already sets `priority: 0`; an explicit priority wins over the
  `frequency` migration mapping.
- There is no chron lease today; a second instance would run a second chron.

## 3. Target architecture

```text
chron (own wake, own state, own log)
  |-- MD jobs (.opencode/schedule/*.md) --fire--> bridge --> user-task files
  |-- code jobs (register/handler) ------fire--> producer --> intent files
  |-- mission scan (code job, every 1m) -> intents (mission/staleness)
  |-- drain scan   (code job, every 15m)-> intents (drain-pass)
  |-- push sources (emit) --------------> intents

state/inbox/<producer>/<id>.json  (intents, atomic, unique)
state/user-tasks/*.md             (prompt-job occurrences, existing rail)
                 |
                 v
heartbeat consumer session (lease)
  merge intents -> ingest user tasks -> prune -> snapshot
  loop: pickFair -> run one -> settle -> save -> repeat (reorder each pass)
  caps between items: items / wall / tokens
  if backlog remains after a cap: wake 0; else sleep to heartbeat.frequency
```

Dependency direction: **heartbeat imports chron; chron core imports nothing
from heartbeat.** The bridge, the mission scan, the drain scan, and the custom
producers live on the heartbeat side and use chron's public API.

## 4. Chron module

New directory: `.opencode/plugin/lib/chron/`.

| File | Responsibility |
| --- | --- |
| `schedule.ts` | pure grammar + due evaluation (`parse`, `nextDue`, `occurrence`) |
| `store.ts` | read/parse job files; atomic `state/chron.json` |
| `config.ts` | the `chron:` section reader (defaults + coercion) |
| `registry.ts` | job registry, duplicate-id policy, `list()` |
| `chron.ts` | `createChron`, `getChron`, `tick`, `start`, `on`, `emit` |
| `schedule.test.ts`, `store.test.ts`, `config.test.ts`, `chron.test.ts` | unit tests |

Adapter files outside the core:

| File | Responsibility |
| --- | --- |
| `.opencode/plugin/chron-hook.ts` | process singleton, timer start, code-job manifest |
| `.opencode/plugin/lib/chron-bridge.ts` | MD fire -> `createTask`; defer on cap |
| `.opencode/plugin/lib/chron/jobs/missions.ts` | generic mission scan |
| `.opencode/plugin/lib/chron/jobs/drain.ts` | drain scan |

### 4.1 Independence rules

- Chron never reads `autonomy.*`, never loads missions, never calls
  `createTask`, never touches `work-queue.json`.
- Chron owns `state/chron.json`, its own log (`log/chron.log`), and its own
  code-freshness/restart behavior.
- Chron acquires `state/chron.lock` with the shared `lib/ownership.ts` for each
  tick (short TTL/refresh; a held lock skips the tick). This is separate from
  the consumer's `state/ownership.lock`, so production continues while the
  consumer drains, and a second opencode instance cannot run a second chron.
- Shared generic utilities (`fsx`, `ownership`, `logging`) are allowed; chron
  still imports no heartbeat policy module.
- The bridge/producers read autonomy and write intents; chron sees only
  `{ id, schedule, source, handler? }`.

### 4.2 Job sources

1. **Markdown jobs** in `.opencode/schedule/*.md`. Hot-read. The file is the
   schedule and the prompt body. No `menus`, `priority`, or `min_level`.
2. **Code jobs** registered at plugin load:
   `chron.register({ id, schedule, handler })`. The handler is deterministic;
   it writes an intent or performs local deterministic work. Heavy or
   LLM-backed work must become an intent, never a direct dispatch.

Duplicate `id`: first registration wins; the later one is logged and skipped.
This prevents a code job and an MD file from both owning one name.

### 4.3 Schedule grammar

```yaml
schedule: every 1h        # interval: 30m | 50m | 1h | 12h
schedule: 0 9 * * *       # standard 5-field cron
schedule: @daily          # croner alias
schedule: manual          # only chron.emit()/push sources fire it
```

- Local time, same as the quiet window.
- Interval shorthand without `every` is normalized (`1h` -> `every 1h`).
- `croner` (small, MIT, zero-dep) owns cron parsing, DST, and exact next-run.
- Invalid expression: warn once, never fire (fail closed).
- First sight seeds `last_fired_ms = now`, so a new job waits for its next
  occurrence instead of firing at boot. `manual` jobs never fire on time.

### 4.4 Due semantics

`occurrence(schedule, now, lastFiredMs)` returns at most one occurrence:

- interval: due when `now - lastFired >= interval`; occurrence = `lastFired + i`.
- cron: due when the latest occurrence after `lastFired` is `<= now`;
  missed occurrences coalesce to one fire.
- one-shot `at <ISO>` (optional extension): fire once, then mark done.
- The handler receives `late: true` when the fired occurrence is older than
  the current schedule window.
- State is advanced only after a handler resolves without `defer`.

### 4.5 State and wake

`state/chron.json`:

```json
{
  "version": 1,
  "jobs": {
    "research-daily": {
      "last_fired_ms": 1793500000000,
      "next_due_ms": 1793520000000,
      "first_deferred_ms": null
    }
  }
}
```

- The timer sleeps to the earliest `next_due_ms`, capped at 60 s so folder and
  config edits land within a minute. `unref()`.
- First wake is deferred with `setTimeout(0)` so every plugin module registers
  before the clock starts.
- One in-process single-flight flag; a slow handler delays the next wake but
  never overlaps it.
- Each tick is lease-guarded by `state/chron.lock`; a held lease returns
  `lock-held` and neither fires nor writes state.
- `chron.list()` returns `{ id, source, schedule, next_due_ms, last_fired_ms,
  deferred }` for inspection, regardless of source.
- Deleted job files leave state behind; prune entries unseen for 30 days.

### 4.6 Handler contract

```ts
type FireEvent = {
  id: string
  occurrence_ms: number
  fired_at_ms: number
  late: boolean
  payload?: unknown
}

type HandlerResult = void | { defer: true }

chron.on("fire", (e: FireEvent) => Promise<void | { defer: true }>)
chron.on(`fire:${id}`, handler)
chron.register({ id, schedule, handler })
chron.emit(id, payload?)   // push sources; same event path, no schedule needed
```

- Handlers run sequentially and fail open: one throw is logged, the next job
  still runs.
- `defer` means "do not advance this occurrence; retry on the next wake."
  Chron sets `first_deferred_ms`; after `chron.defer_ttl_hours` it drops the
  occurrence with a loud log and advances, so a full store cannot spin forever.
- `register({ handler })` is the single owner of that job's action.
  `on("fire")` is an observer/telemetry hook. Do not give a job both a handler
  and a second owner.

### 4.7 Markdown job template

```md
---
id: disk-check              # defaults to the filename stem
schedule: daily 09:00       # or 0 9 * * * | every 6h | 1h | manual
enabled: true
agent: chat                 # optional; defaults to the user-task mission agent
---
Check disk usage and report anything above 80%. Include the top five directories.
```

- The body is the prompt. No heartbeat policy fields.
- `enabled: false` is a local pause.
- The file is hot-read; a rename changes the id (state follows the id, so rename
  is a new job unless the id is kept explicit).

### 4.8 Code job manifest

`plugin/chron-hook.ts` creates the singleton and imports
`lib/chron/jobs/index.ts`, which registers built-ins:

```ts
export function registerCodeJobs(chron: Chron) {
  chron.register({ id: "missions", schedule: "every 1m", handler: missionScan })
  chron.register({ id: "drain", schedule: drainSchedule(), handler: drainScan })
  // user code jobs: one file + one line here
}
```

Adding a code job is one file plus one registry line. No scheduler edits.

### 4.9 Prompt bridge (MD job -> user task)

`lib/chron-bridge.ts` subscribes to MD fires and calls the existing store:

```ts
const res = await createTask(stateDir, {
  title: `[chron] ${job.title}`,
  prompt: body,
  context: `source: ${path}\noccurrence: ${iso}`,
  requested_by: "chron",
  dedupe_key: `chron:${job.id}`,
  expires_in_hours: chronCfg.prompt_ttl_hours,
  ...(job.agent ? { agent: job.agent } : {}),
})
if (!res.ok && res.reason.includes("cap")) return { defer: true }
```

- `dedupe_key` gives at-most-one-open per job; once settled, the next occurrence
  writes a new task.
- The bridge is the producer: it checks `autonomy.level > 0` and the user-task
  mission's `enabled`/`min_level` before writing. Chron itself reads nothing.
- `agent` is a new optional field on `UserTask`/`CreateTaskInput`; the handler
  passes `task.agent ?? mission.agent` to `runChild`.

## 5. Intent rail and consumer

### 5.1 Intent schema

`state/inbox/<producer>/<safe-id>.json`, one file per intent:

```json
{
  "version": 1,
  "id": "mission:research",
  "kind": "mission",
  "producer": "chron:missions",
  "enqueued_ms": 1793500000000,
  "priority": 5,
  "expires_ms": 1793586400000,
  "payload": {
    "mission": "research",
    "occurrence_ms": 1793499600000,
    "signals": {},
    "level": 3,
    "quiet": false,
    "sleep_status": "awake"
  }
}
```

- Unique filenames, atomic writes (`atomicWrite`). Producers never **write**
  `work-queue.json`; the consumer stays the sole writer. A read-only snapshot
  is allowed for `queuedIds` dedupe.
- Malformed files move to `state/inbox/bad/` with a log line; they never block
  the merge.
- One open intent per `id`; a new occurrence while the old file exists is
  deduped/skipped.

### 5.2 Merge (consumer, under lease)

1. Read every `state/inbox/*/*.json`.
2. Validate and dedupe by `id` against the queue.
3. Prune expired items first.
4. Accept only up to the free slots
   (`max(0, MAX_QUEUE_DEPTH - queue.length)`) after pruning; leave the rest in
   the inbox and log. `enqueueWork` currently calls
   `cap()` and evicts the oldest (`lib/work-queue.ts:271-282`); replace that
   with an `enqueueWithinCapacity`/`{ queue, rejected }` variant.
5. Save with a **checked** writer that returns `boolean`
   (`saveWorkQueueStateChecked`, or change the existing return type); delete
   only the merged intent files when it returns true. On failure, leave every
   merged file in place and retry next session.
6. Ingest `state/user-tasks/*.md` via the existing `collectUserTasks` (the file
   is the intent; no production decision).
7. Snapshot the queue ids for this session.

Producers may read `work-queue.json` read-only for `queuedIds`; they never
write it. The merge dedupe is authoritative.

### 5.3 Session loop

```text
acquire lease
merge intents + ingest user tasks
prune expired
snapshot ids
loop:
  pick = pickFair(remaining snapshot, scheduler, now, runnable)
  if none -> stop "empty" | "no-runnable"
  dequeue(pick); save queue
  run handler
  apply requeue/mood/backlog; write item ledger line
  accumulate items/tokens/wall
  if lease lost -> stop "lease-lost"
  if cap hit -> stop with the matching reason
save queue; write session ledger line
schedule next wake (0 if backlog remains after a cap, else idle delay)
```

- `seen` set: one attempt per item id per session. A timeout requeue waits for
  the next session, so retries cannot burn out inside one batch.
- The SWRR picker is re-run between every item; no fixed batch order. Credits
  persist in `work-queue.json` across sessions.
- `await lease.refresh()` is checked between items; stop if it returns false.
  `held()` is only an in-memory flag; `refresh()` re-reads the on-disk record,
  so a >90 s suspend/steal is caught before the next dispatch.
- An item is removed before dispatch (current at-most-once behavior); a crash
  mid-item loses that attempt. Do not change this in v1.

### 5.4 Caps (checked between items, never mid-item)

New `consumer:` config block:

| Key | Default | Meaning |
| --- | --- | --- |
| `max_items_per_tick` | `10` | executed items per session; `0` = unlimited |
| `max_wall_minutes` | `60` | wall ceiling; `0` = unlimited |
| `token_budget` | `250000` | summed item tokens; `0` = unlimited |

- The item that crosses a cap completes and settles; the next pick is skipped.
- If the snapshot still has runnable items when a **cap** stops the session,
  schedule the next wake at **0**. `empty` and `no-runnable` sleep to
  `autonomy.heartbeat.frequency` (or the earliest `not_before_ms` if sooner);
  never wake 0 for `no-runnable`, or a gated/disabled item spins the loop.
  Otherwise a 12 h dial would delay leftover work by 12 h and the cap would
  defeat the point.
- Stop reasons: `empty`, `no-runnable`, `max-items`, `max-wall`,
  `token-budget`, `lease-lost`.

### 5.5 Fairness semantics

SWRR no longer rations service across a batch (everything in the snapshot
eventually runs); it decides **order**. Weights remain per kind and are still
hot-read. Within a kind: priority desc, then FIFO (`enqueued_ms`), then id.

### 5.6 Ledger

- One line per executed item, carrying the existing handler ledger fields plus
  `session` and `position`.
- One session line (the tick line) with `items_run`, `items_left`, `wall_ms`,
  `tokens`, and `stopped`.
- The Dashboard keeps reading the tick lines; unknown fields are ignored.
  A session with `items_run > 1` is the new normal.

### 5.7 Wake math

- Remove `effectiveFrequencyMs` / `noop_streak` stretching from the consumer.
  A consumer wake is a file read; backoff only delays queued work.
- Keep the 60 s `HEARTBEAT_WAKE_CAP_MS` so config flips apply within a minute.
- If the queue has items but none runnable, wake at
  `min(earliest not_before_ms, frequency)`; do not wait a full 12 h for a
  one-minute gate.
- `long_silence` still uses the raw `heartbeat.frequency`; no other behavior.

## 6. Mission production

### 6.1 One generic producer

`lib/chron/jobs/missions.ts`, registered as a code job on chron (proposed
`every 1m`, config `chron.mission_scan`).

Algorithm per scan:

1. Load missions (`loadMissions`).
2. Skip `enqueue: item` missions (user-task is consumer-owned).
3. Skip missions whose `producer` is set and is not `generic` (custom owner).
4. Skip missions with no `schedule` (warn once; fail closed).
5. Compute the production context once: now, level, quiet, sleep, signals,
   queued ids, `last_evaluated_ms` per mission (`state/missions.json`).
6. For each mission: due occurrence? Candidacy gate passes? `enabled`, `menus`,
   `min_level` pass? Not already queued?
7. Sort eligible by priority desc -> occurrence asc -> id; take at most
   `chron.mission_max_per_scan` (default 5).
8. Write one intent per selected mission, then mark `last_evaluated_ms` for
   that occurrence. If the intent write fails, do not mark; retry next scan.
9. A failed gate also marks the occurrence consumed (one evaluation per
   occurrence, no retry storm).

`queuedIds` comes from a read-only `loadWorkQueueState` snapshot; the producer
never writes the queue.

`last_evaluated_ms` is producer state, separate from `last_runs` in
`heartbeat.json` (dispatch history). Interval due-ness uses `last_evaluated_ms`,
not `last_run`, so a slow queue cannot stack occurrences. Dedupe by
`mission:<id>` covers the window while an item is queued.

Kind mapping: `candidacy: brain-stale*` emits `kind: "staleness"`; everything
else emits `kind: "mission"`. This preserves the existing SWRR weights and
ledger gates.

### 6.2 `producer:` escape hatch

Mission frontmatter gets an optional `producer: <name>`:

```yaml
producer: generic        # default
# or
producer: nightly-report # registered custom producer
```

- `generic` or absent -> generic scan handles it.
- Any other name -> generic skips it; the registered custom mission producer
  owns it. Unknown name -> warn once and skip (fail closed, never silently
  produce).
- Custom producers register in `lib/production/registry.ts`:

  ```ts
  type MissionProducer = {
    id: string
    produce(mission: Mission, ctx: ProductionCtx): Promise<WorkItem[]>
  }
  registerMissionProducer(producer)
  ```

- One owner per mission; dedupe by id is the safety net, not the routing.
- Non-agent work such as drain is not a mission file: it is a standalone chron
  code job emitting its own intent kind.

### 6.3 Schema and priority migration

Mission frontmatter after migration:

```yaml
id: research
title: Light research into the vault
schedule: every 6h         # new: required for generic
priority: 5                # 0-9, default 5
menus: [day]
min_level: 2
candidacy: always          # or brain-stale:720 | dream-gate | idea-roll | roll:0.1
enqueue: producer
approval: n/a
agent: ""
enabled: true
```

- **`frequency` is deleted.** It is not renamed. Its old value is a one-time
  migration input only: `high -> 8`, `mid -> 5`, `low -> 2`.
- `priority` now drives both producer emission order and within-kind queue
  order. Default `5` (old `mid`); `DEFAULT_MISSION.priority` changes from 3.
- An explicit numeric `priority` already in a file wins over the mapping:
  `dream.md` already has `priority: 0` and keeps it.
- Remove `MissionFrequency`, `MISSION_FREQUENCIES`, `FREQUENCY_WEIGHTS`,
  `frequency_weight`, `DigestCandidate.weight`, and the weighted mission draw.
- `buildCandidates` becomes a filter only (or is split); the producer orders
  by priority. No mood-weighted draw.
- Mood becomes a bounded tie-break only; it never changes the queued priority
  and never touches gates.
- Overlay: drop `frequency`; add `priority` with a restrict-only rule (the
  overlay may only **decrease** priority). `enabled`/`min_level`/`menus` rules
  are unchanged.

Current-file migration table (apply exactly):

| File | Old frequency | New priority | Proposed schedule |
| --- | --- | --- | --- |
| `notify.md` | high | 8 | `every 1h` |
| `research.md` | mid | 5 | `every 6h` |
| `express.md` | low | 2 | `every 12h` |
| `idea-generate.md` | low | 2 | `every 24h` |
| `free-run.md` | low | 2 | `every 6h` |
| `staleness.md` | mid | 5 | `every 6h` |
| `dream.md` | low | 0 (explicit, keeps existing) | `every 1h` |
| `user-task.md` | low | 2 | none (`enqueue: item`) |

- Schedules are policy; review them before applying. `min-gap:research` /
  `min-gap:express` become redundant and are removed; the schedule is the gap.
- The mapping applies only where `priority` is absent. `dream.md` already sets
  `priority: 0`; do not overwrite it.
- `roll:0.1` / `idea-roll` / `dream-gate` / `brain-stale` stay as gates,
  evaluated once per scheduled occurrence.
- If a mission has no `schedule` and is not `enqueue: item`, warn once and skip.

### 6.4 Drain producer

- New code job `lib/chron/jobs/drain.ts`, schedule from
  `drain.producer_interval_minutes` (default 15).
- Each fire calls the existing `drainDue()` (`lib/drain/step.ts:55-96`).
- If due and no `drain-pass` is queued, emit one intent:
  `{ id: "drain-pass", kind: "drain-pass", producer: "chron:drain" }`.
- `drainDue` thresholds stay config: `trigger_pending` (currently 12; the 15 in
  the design conversation was an example, not a required default) and
  `trigger_max_age_hours` (2).
- `producer_interval_minutes` needs reader wiring, not just YAML:
  `DEFAULT_DRAIN` + `INT_KEYS` in `lib/drain/config.ts` and
  `DRAIN_SCALAR_RULES` in `lib/autonomy.ts:485-513`.
- Delete `drainHandler.produce` and the inline `drainDue` call from
  `heartbeat-hook.ts`; keep `runDrainStep` as the run path.

### 6.5 User tasks

- `collectUserTasks` stays as a file ingester in the merge step. It is not a
  cadence decision; the task files are the intents.
- `userTaskEnabled` keeps its `user-task` mission gate.
- Add optional `agent` to the task store, render/parse, and
  `runUserTaskItem` (`task.agent ?? mission.agent`).
- The `user-task.md` body wording changes from "queued with `queue_add`" to
  "queued or scheduled" so the child is not confused by chron jobs.

## 7. Configuration

Add readers first: `lib/chron/config.ts` for the `chron:` block and
`lib/consumer-config.ts` for the `consumer:` block, plus the drain additions in
6.4. A YAML edit alone is a silent no-op because the readers are section-specific.
The target repo tracks only `.opencode/sysop-config.example.yaml`; the live
`sysop-config.yaml` is gitignored, so edit the example here and let the operator
copy it into place.

```yaml
chron:
  enabled: true
  schedule_dir: .opencode/schedule
  state_file: chron.json
  inbox_dir: inbox
  max_sleep_seconds: 60
  prompt_ttl_hours: 24
  default_priority: 5
  mission_scan: every 1m
  mission_max_per_scan: 5
  defer_ttl_hours: 24

consumer:
  max_items_per_tick: 10
  max_wall_minutes: 60
  token_budget: 250000

drain:
  producer_interval_minutes: 15   # new
```

- `0` on the consumer caps means unlimited.
- Keep `scheduler.weights` unchanged; the fair picker still uses them.
- `heartbeat.frequency` remains the idle poll cadence, not the production
  cadence.

## 8. Implementation phases

Progress table (fill in as you go):

| Phase | Status | Evidence |
| --- | --- | --- |
| 0. Branch + baseline | done | `feat/chron-scheduler` was already checked out and clean; `opencode.json` had no local diff; baseline `find … | xargs -0 node --test` = 893 pass, 0 fail |
| 1. Chron schedule core | done | `croner@11.0.0` in `.opencode/package.json` + lock; `node --test .opencode/plugin/lib/chron/schedule.test.ts` = 11 pass, 0 fail (incl. DST) |
| 2. Chron store/timer/registry | done | `node --test …/store.test.ts …/chron.test.ts …/config.test.ts` = 20 pass, 0 fail |
| 3. Prompt bridge + task agent | done | `node --test …/user-tasks.test.ts …/work-kinds/user-task.test.ts …/chron-bridge.test.ts` = 28 pass, 0 fail |
| 4. Intent rail + merge | done | `node --test …/production/intents.test.ts …/work-queue.test.ts` = 23 pass, 0 fail |
| 5. Mission schema/priority | done | `node --test …/missions.test.ts …/autonomy.test.ts` = 45 pass, 0 fail |
| 6. Generic mission producer | done | `node --test …/production/missions.test.ts …/heartbeat-hook.test.ts` = 33 pass, 0 fail; full suite 948 pass, 0 fail; the broad `rg` gate still matches the intentionally kept `heartbeat.frequency` idle cadence, but no mission-frequency/weight symbols remain |
| 7. Drain producer + inline removal | done | `node --test …/chron/jobs/drain.test.ts …/drain/*.test.ts` = 109 pass, 0 fail; `rg -n "drainDue\|collectWork" heartbeat-hook.ts` is clean |
| 8. Consumer session loop + caps | done | `node --test …/heartbeat-hook.test.ts …/heartbeat.test.ts …/consumer-config.test.ts` = 88 pass, 0 fail (12-item burst splits 10/2, wall/token/lease caps, no spin, no backoff) |
| 9. Docs, dashboard, end-to-end | done | full suite 962 pass, 0 fail; `chron-e2e.test.ts` covers the prompt-job -> user-task -> consumer path; example config, config reference, README, CHANGELOG, Dashboard session-line count updated |

### Phase 0 - Branch and baseline

**Do:** inspect the tree first. `opencode.json` is known to be locally modified
on `main` (permission change); inspect `git diff -- opencode.json` and either
commit it on `main` with explicit approval or carry it deliberately onto the
branch. Do not discard or stash it silently. Then create the branch, install
test deps, and record the baseline.

```bash
cd /home/vuszi/Projects/Agents/Kael/projects/Nibble-agent
git status --short
git diff -- opencode.json          # decide; do not discard
git switch -c feat/chron-scheduler
npm --prefix .opencode ci
find .opencode/plugin/lib -name '*.test.ts' -print0 | xargs -0 node --test
```

**Acceptance:** `git branch --show-current` prints `feat/chron-scheduler`; the
baseline suite exits 0; the disposition of the `opencode.json` change is
recorded in the Progress evidence.

### Phase 1 - Chron schedule core

**Do:** install the dependency and commit both manifest and lock:

```bash
npm --prefix .opencode install croner
```

Run this in the target repo only; do not install or copy into the live Kael
tree. The operator installs after merging the branch. Then create
`lib/chron/schedule.ts` and `schedule.test.ts`; implement interval
shorthand, cron, `manual`, `parse`, `occurrence`, `nextDue`, and
invalid-expression handling.

**Acceptance:**

```bash
npm --prefix .opencode ls croner
node --test .opencode/plugin/lib/chron/schedule.test.ts
```

passes with cases for `30m`, `1h`, `12h`, `every 1h`, `0 9 * * *`, `@daily`,
DST skip/repeat, and garbage input.

### Phase 2 - Chron store, timer, registry

**Do:** create `store.ts` (job files + `state/chron.json`), `registry.ts`
(duplicate id first-wins), `config.ts` (the `chron:` reader), `chron.ts`
(`tick`, `start`, `on`, `emit`, `list`, `defer`, `state/chron.lock` via
`lib/ownership.ts`), tests; add `plugin/chron-hook.ts` and
`lib/chron/jobs/index.ts` (empty manifest for now).

**Acceptance:**

```bash
node --test .opencode/plugin/lib/chron/store.test.ts .opencode/plugin/lib/chron/chron.test.ts .opencode/plugin/lib/chron/config.test.ts
```

covers one fire per occurrence, coalesced misses, first-sight seeding, `defer`
retry/drop, duplicate id, `list()`, and two chron instances where only the
lease holder fires.

### Phase 3 - Prompt bridge and task agent

**Do:** add `lib/chron-bridge.ts`; register it in `chron-hook.ts`; add optional
`agent` to `UserTask`, `CreateTaskInput`, render/parse, and
`runUserTaskItem`; update `user-task.md` wording.

**Acceptance:**

```bash
node --test .opencode/plugin/lib/user-tasks.test.ts .opencode/plugin/lib/work-kinds/user-task.test.ts .opencode/plugin/lib/chron-bridge.test.ts
```

covers one fire -> one task, `dedupe_key`, TTL, cap -> `defer`, and the agent
passed through to `runChild`.

### Phase 4 - Intent rail and merge

**Do:** create `lib/production/intents.ts` (schema, read/validate/merge,
bad-file quarantine, delete-after-save); add the merge + `collectUserTasks` in
`heartbeat-hook.ts` **alongside** the existing inline producers (do not remove
them yet); make `saveWorkQueueState` return a boolean (or add
`saveWorkQueueStateChecked`); add an `enqueueWithinCapacity`/`{ queue, rejected }`
merge that accepts up to free slots instead of calling `cap()`.

**Acceptance:**

```bash
node --test .opencode/plugin/lib/production/intents.test.ts .opencode/plugin/lib/work-queue.test.ts
```

covers merge, dedupe, malformed quarantine, delete only after a successful
(boolean) save, save-failure leaving files, and 48 existing + 5 intents
accepting 2 with no eviction.

### Phase 5 - Mission schema support (no behavior switch yet)

**Do:** add `schedule` and `producer` to the parser/type/defaults; add the
overlay `priority` rule (restrict-only: may only decrease); keep `frequency`
accepted as a deprecated alias so the current inline producer keeps running.
Do **not** delete `frequency`, `FREQUENCY_WEIGHTS`, or the weighted draw yet;
the files are migrated in Phase 6 when the generic producer takes over.

**Acceptance:**

```bash
node --test .opencode/plugin/lib/missions.test.ts .opencode/plugin/lib/autonomy.test.ts
```

covers parsing `schedule`/`producer`, the `priority` overlay direction, the
deprecated `frequency` alias, and unchanged production behavior.

### Phase 6 - Generic mission producer and custom registry

**Do:** create `lib/production/missions.ts` and
`lib/production/registry.ts`; implement the algorithm in 6.1 (due, gates,
priority order, `max_per_scan`, `last_evaluated`, dedupe, kind mapping); switch
production to the generic scan; migrate the mission files with the 6.3 table
(remove `frequency`, add `schedule`/`priority`; explicit priority wins);
delete `collectMissions`/`collectStaleness`, `FREQUENCY_WEIGHTS`,
`frequency_weight`, `DigestCandidate.weight`, the weighted draw, and the
`c.weight` ledger line; update `heartbeat-hook.ts:988` and
`work-kinds/mission.ts`; reduce `collectWork` to the still-inline drain
producer (delete it in Phase 7); keep the run handlers; register the scan in
`lib/chron/jobs/index.ts`.

**Acceptance:**

```bash
node --test .opencode/plugin/lib/production/missions.test.ts .opencode/plugin/lib/heartbeat-hook.test.ts
rg -n "frequency|FREQUENCY_WEIGHTS|weightedPick|DigestCandidate.*weight" .opencode/missions .opencode/plugin/lib/missions.ts .opencode/plugin/lib/heartbeat.ts .opencode/plugin/lib/work-kinds/mission.ts
```

covers due/cadence, one evaluation per occurrence, priority order, scan cap,
queued dedupe, `brain-stale` -> `staleness`, `producer: custom` skip, and
unknown producer warn+skip. `rg` returns no matches in the listed sources;
docs may still mention the historical name.

### Phase 7 - Drain producer and inline removal

**Do:** create `lib/chron/jobs/drain.ts`; register it; wire
`drain.producer_interval_minutes` through `DEFAULT_DRAIN`/`INT_KEYS`
(`lib/drain/config.ts`) and `DRAIN_SCALAR_RULES` (`lib/autonomy.ts:485-513`);
delete `drainHandler.produce` and the `drainDue` producer block from
`heartbeat-hook.ts`.

**Acceptance:**

```bash
node --test .opencode/plugin/lib/chron/jobs/drain.test.ts .opencode/plugin/lib/drain/*.test.ts
rg -n "drainDue|collectWork" .opencode/plugin/heartbeat-hook.ts
```

If `collectWork` still exists in `work-producers.ts` after Phase 6, delete it
here; the `rg` gate must be clean for the hook.

The producer test fires at most one `drain-pass` per due window and none below
the trigger; `rg` shows no inline producer call.

### Phase 8 - Consumer session loop and caps

**Do:** implement the snapshot loop, per-item `pickFair`, `seen` set,
`await lease.refresh()` between items, caps, session ledger, and the wake rules;
add `lib/consumer-config.ts`; remove `effectiveFrequencyMs`/`noop_streak` from
the consumer path.

**Acceptance:**

```bash
node --test .opencode/plugin/lib/heartbeat-hook.test.ts .opencode/plugin/lib/heartbeat.test.ts .opencode/plugin/lib/consumer-config.test.ts
```

covers a 12-item burst with `max_items_per_tick: 10` (10 run, 2 left, wake 0),
wall/token stop between items, requeue not retried in the same session, lease
loss stops, `no-runnable` sleeping to frequency (not spinning at 0), and no
backoff stretching.

### Phase 9 - Docs, dashboard, end-to-end

**Do:** update `docs/sysop-config-reference.md`, README, CHANGELOG, the
historical docs index, and any Dashboard reader that assumes one item per tick;
run the full suite; run the manual acceptance in Appendix B.

**Acceptance:**

```bash
find .opencode/plugin/lib -name '*.test.ts' -print0 | xargs -0 node --test
git diff --stat
git status --short
```

The suite exits 0; the diff contains only expected files; the manual checklist
in Appendix B passes.

## 9. Test matrix

| Area | File |
| --- | --- |
| schedule grammar/DST | `lib/chron/schedule.test.ts` |
| state/registry/defer | `lib/chron/store.test.ts`, `lib/chron/chron.test.ts` |
| chron config + lease | `lib/chron/config.test.ts`, `lib/chron/chron.test.ts` |
| MD -> user task | `lib/chron-bridge.test.ts` |
| intent merge/overflow | `lib/production/intents.test.ts` |
| checked queue save/capacity | `lib/work-queue.test.ts`, `lib/production/intents.test.ts` |
| mission schema/migration | `lib/missions.test.ts`, `lib/autonomy.test.ts`, `lib/heartbeat.test.ts` |
| generic producer/custom routing | `lib/production/missions.test.ts` |
| drain producer | `lib/chron/jobs/drain.test.ts`, `lib/drain/*.test.ts` |
| consumer loop/caps/lease | `lib/heartbeat-hook.test.ts`, `lib/work-queue.test.ts` |
| consumer config | `lib/consumer-config.test.ts` |
| user-task agent | `lib/user-tasks.test.ts`, `lib/work-kinds/user-task.test.ts` |

## 10. Rollback

- The branch is isolated; `git switch main` returns to the current behavior.
- `chron.enabled: false` stops all production (no inline fallback exists after
  Phase 7; this is deliberate fail-closed behavior).
- `drain.enabled: false` remains an independent cut.
- The consumer caps can be set to `0` (unlimited) to restore batch behavior, or
  lowered to throttle.
- If a phase breaks the live agent, do not hot-apply it; fix on the branch.

## 11. Decisions and open items

Chosen defaults:

- Consumer caps: 10 items / 60 min / 250k tokens; `0` = unlimited.
- Backlog after a cap: wake 0; idle/`no-runnable` sleep uses
  `heartbeat.frequency` (or the earliest `not_before_ms`).
- Chron runs under its own `state/chron.lock`; the consumer lease is separate,
  so production continues while the consumer drains.
- Producers may read `work-queue.json` read-only for dedupe; only the consumer
  writes it.
- Explicit mission `priority` wins over the migration mapping; default 5.
- The full suite is `find .opencode/plugin/lib -name '*.test.ts' -print0 |
  xargs -0 node --test`; `node --test <directory>` is not valid here.
- Generic scan: `every 1m`, `max_per_scan: 5`.
- Mission default priority: 5; mapping `high 8 / mid 5 / low 2`.
- One attempt per item per session; requeues wait.
- Intent overflow: prune expired, then reject-new (no eviction).
- Drain: `every 15m`, existing `trigger_pending` (12) / `trigger_max_age_hours`
  (2); adjust via config if 15 is preferred.
- Prompt jobs: user-task rail, `dedupe_key: chron:<id>`, TTL 24 h.

Still open (documented, not blocking Phase 1):

- Whether the Dashboard should show `chron.list()` next-run data in v1 or a
  follow-up.
- Whether `at <ISO>` one-shots are in v1 or deferred (grammar already leaves
  room).
- Whether to keep `staleness` as its own kind or fold it into `mission` after
  the migration (this plan keeps it for scheduler/ledger continuity).
- The exact per-mission schedules in 6.3 (policy review).
- Whether `priority` should also be exposed in the autonomy overlay for every
  mission or only a few (the plan allows all, restrict-only).

## 12. Risks

- **Long sessions:** a batch can run for hours. The caps and the lease check
  are the guards; the per-item stall window still bounds a stuck child.
- **Double production:** a code job and an MD file with the same id; first wins
  and logs. Dedupe by id is the second net.
- **Stale chron code:** chron needs its own code-freshness/restart check;
  heartbeat's gate does not cover it.
- **Producer crash between intent and state mark:** write the intent first,
  then the evaluation mark; dedupe by id makes the retry harmless.
- **Queue overflow:** accept-up-to-free-slots preserves existing work; the inbox
  files stay for the next session. Watch `state/inbox` growth if a producer
  outpaces the consumer.
- **Two chron instances:** without `state/chron.lock` both would fire and race
  `state/chron.json`; the lease test is the guard.
- **Queue save failure:** the checked writer must return false; deleting intents
  after a best-effort write would lose work. Test the failure path.
- **`no-runnable` spin:** never wake 0 for a non-empty but unrunnable queue;
  sleep to frequency or the earliest `not_before_ms`.
- **Cron DST:** delegated to `croner`, covered by schedule tests; do not
  hand-roll.

## 13. Alternatives considered

- **Direct enqueue from producers under a lease.** Simpler on paper (no inbox,
  no merge), but it makes every producer a `work-queue.json` writer, needs
  CAS/lease coordination, and reintroduces the partial-write and eviction
  classes the consumer currently owns. The inbox keeps the single-writer
  invariant and lets the consumer reject/leave overflow. Keep the inbox.
- **One mission producer per mission.** Rejected: the generic scan plus the
  `producer:` escape hatch keeps policy in files and reserves code for genuine
  exceptions.
- **Reusing the user-task mission for chron prompt jobs.** Kept: it is the
  existing rail and avoids a new work kind in v1. If prompt jobs later diverge
  (per-job settle semantics, different lifecycle), promote them to a `prompt`
  kind then.

## Appendix A - Worked examples

Chron MD job:

```md
---
id: disk-check
schedule: 0 9 * * *
enabled: true
agent: chat
---
Check disk usage and report anything above 80%. Include the top five directories.
```

Mission intent:

```json
{
  "version": 1,
  "id": "mission:research",
  "kind": "mission",
  "producer": "chron:missions",
  "enqueued_ms": 1793500000000,
  "priority": 5,
  "expires_ms": 1793586400000,
  "payload": { "mission": "research", "occurrence_ms": 1793499600000 }
}
```

Code job:

```ts
chron.register({
  id: "drain",
  schedule: `every ${cfg.producer_interval_minutes}m`,
  handler: async () => {
    if (!(await drainDue(deps)).due) return
    await writeIntent("chron:drain", {
      id: "drain-pass",
      kind: "drain-pass",
      priority: 3,
    })
  },
})
```

## Appendix B - End-to-end acceptance

1. Create `.opencode/schedule/smoke.md` with `schedule: every 1m`, body
   "Write the word smoke to the log."
2. Within ~2 minutes, `state/user-tasks/` contains one pending task with
   `requested_by: chron` and `dedupe_key: chron:smoke`.
3. The next consumer session runs it; the file moves to `done/` (or `blocked/`
   with a reason), and no duplicate task appears while it is pending.
4. Add a test mission with `schedule: every 1m`, `priority: 5`,
   `producer: generic`; within ~2 minutes a `mission:<id>` intent appears, the
   consumer runs it, and `state/missions.json` shows the occurrence evaluated.
5. Add a second mission with `producer: custom`; the generic scan skips it; the
   registered custom producer emits it instead.
6. Queue 12 intents with `max_items_per_tick: 10`; the first session runs 10,
   leaves 2, and the loop wakes immediately for the second session.
7. Set `consumer.max_wall_minutes: 1`; a long item completes, then the session
   stops between items with `stopped: "max-wall"`.
8. `rg -n "frequency" .opencode/missions` returns nothing.
9. Full suite exits 0; `git status --short` lists only intended files; the
   live Kael tree is untouched.
10. Start two chron processes; only the `state/chron.lock` holder fires; the
    other logs `lock-held`.
11. Force a queue-save failure (test seam); merged intent files remain and are
    retried, never deleted.
12. Queue a gated/not-yet-runnable item; the consumer stops `no-runnable` and
    sleeps to frequency instead of spinning at 0.
