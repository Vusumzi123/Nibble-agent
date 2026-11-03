# SQLite Work Store — Implementation Plan

Status: implemented on `feat/sqlite-work-store` (2026-11-02)
Scope: heartbeat work state only. No vault, mission-file, or config migration.
Decisions taken: SQLite for intents + queue + SWRR scheduler state + heartbeat
lease; at-least-once recovery; files remain the declarative input layer.

> Steps below are ordered; each has exactly one action and one acceptance check.
> Evidence is filled in as steps land. Steps 1-7 pass on Node 24; Step 8's Bun
> runtime probe is the only open acceptance item.

## 1. Goal

Replace the file-based intent inbox, work queue, SWRR scheduler state, and
heartbeat lease with one SQLite database (`state/work.db`) while keeping
missions, configuration, and user-task briefs as human-readable files.

## 2. Why

The current split works at present scale but reimplements storage-engine
invariants in application code:

- The consumer dequeues and saves the item **before** running it
  (`heartbeat-hook.ts:1214-1221`, run at `:1238`). A crash in that window loses
  the item.
- An unparseable `work-queue.json` loads as an empty queue
  (`work-queue.ts:145-166`), and invalid items are silently dropped by
  `sanitize` (`:206-245`). Corruption becomes silent state loss.
- The consumer ignores the boolean from `saveWorkQueueState`
  (`work-queue.ts:249-261`) at `heartbeat-hook.ts:1221` and `:1240`.
- Merge is a hand-rolled save-then-unlink protocol (`production/intents.ts:329-354`).
- `atomicWrite` is write + rename with no `fsync` (`fsx.ts:20-30`): atomic
  visibility, not crash durability.
- Intents and work items are two representations of the same thing
  (`production/intents.ts:247-258`, `work-queue.ts:88-109`).
- The queue is capped at 50 (`work-queue.ts:32`), but overflow stays in an
  unbounded inbox (`production/intents.ts:298-305`, `:340-351`). Every tick
  re-reads every inbox file (`intents.ts:155-205`).

The user-facing requirement is architectural correctness, not execution speed.
The heartbeat's execution throughput (one consumer, bounded items per tick) is
out of scope.

## 3. Target design

### 3.1 Boundary

```
Files (declarative / human)            SQLite: state/work.db (machine)
  .opencode/missions/*.md                work_items
  .opencode/sysop-config.yaml            scheduler_state
  .opencode/state/user-tasks/*.md  ──┐   lease
  .opencode/state/heartbeat.json     │   meta
  logs/*.ndjson                      │
                                     └─ ingested at tick
```

Rule: **producers may only insert `queued` rows through the store API; the
consumer owns every state transition.** Producers never write arbitrary rows
and never touch `work_items.state`.

SQLite is the only runtime driver. The legacy file queue is read once by the
importer and written by the `dump` CLI for backup/rollback; it is not a parallel
runtime implementation.

### 3.2 Schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA user_version = 1;

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE work_items (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN
                   ('mission','user-task','drain-pass','staleness','profile-update','soul-update')),
  producer       TEXT NOT NULL,
  enqueued_ms    INTEGER NOT NULL,
  priority       INTEGER CHECK (priority BETWEEN 0 AND 9),
  not_before_ms  INTEGER,
  expires_ms     INTEGER,
  requeue_count  INTEGER NOT NULL DEFAULT 0,
  requeue_reason TEXT,
  payload        TEXT,                       -- JSON
  state          TEXT NOT NULL DEFAULT 'queued'
                   CHECK (state IN ('queued','running','failed')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  claimed_by     TEXT,
  claimed_ms     INTEGER,
  failed_ms      INTEGER,
  last_error     TEXT
);
CREATE INDEX work_due    ON work_items(state, kind, not_before_ms, enqueued_ms);
CREATE INDEX work_expiry ON work_items(state, expires_ms);

CREATE TABLE scheduler_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  fair       INTEGER NOT NULL DEFAULT 1,
  weights    TEXT NOT NULL,                  -- JSON record
  credits    TEXT NOT NULL,                  -- JSON record
  served     TEXT NOT NULL,                  -- JSON record
  last_kind  TEXT,
  updated_ms INTEGER NOT NULL
);

CREATE TABLE lease (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  owner        TEXT NOT NULL,                -- pid:pid_start:random
  pid          INTEGER NOT NULL,
  pid_start    TEXT,
  acquired_ms  INTEGER NOT NULL,
  heartbeat_ms INTEGER NOT NULL
);
```

No `intents` table. An intent is a `work_items` row with `state='queued'`; this
is the deliberate collapse of the duplicate representation.

`attempts` counts every claim, including crash recovery, and is capped at 3.
`requeue_count` keeps its current meaning: timeout resumes only
(`work-queue.ts:28-29`, `requeueTail`/`stallResumeItem`). The handler owns the
`requeue_count` increment; the store only persists the item it receives.

At the `attempts` cap, `claim` and `recover` mark the row `failed` with
`failed_ms` and `last_error`; the tick writes an `outcome: "error"` ledger line. A `failed` row
is replaced by `enqueue` only after a cooldown (`failed_retry_ms`, default
1 hour), and only if the incoming intent is newer. Before the cooldown,
`enqueue` reports it as a duplicate. `has(id)` ignores `failed` rows, so a
producer's pre-check does not dead-end. `pruneFailed` removes rows past the
retention window (default 30 days).

### 3.3 Store contract

New `lib/work-store.ts` (types), `lib/sqlite/open.ts` (read-write opener), and
`lib/work-store/sqlite.ts`. The pure helpers in `work-queue.ts` (`pickFair`,
`pruneWork`, `requeueTail`, `stallResumeItem`, `normalizeWeights`) stay
unchanged.

| Operation | Behaviour |
| --- | --- |
| `open(stateDir)` | Open DB, apply migrations, run the legacy import once under `BEGIN IMMEDIATE` using the `meta` marker. Lazy import of the SQLite binding; a failure disables the work path (the tick returns `store-unavailable`), never the whole plugin. |
| `enqueue(items)` | One short `BEGIN IMMEDIATE`: capacity check over `state='queued'`; replace a `failed` row past its cooldown; `INSERT OR IGNORE` otherwise. Returns per-id arrays: `{accepted, rejected, duplicates}`. |
| `snapshot()` | Read queued rows + scheduler row for `pickFair`. |
| `claim(id, scheduler, owner)` | One short `BEGIN IMMEDIATE`: verify the `lease` row is held by `owner` and unexpired; a row at `attempts >= 3` is marked `failed` instead of claimed; `UPDATE ... SET state='running', attempts=attempts+1, claimed_by=?, claimed_ms=? WHERE id=? AND state='queued'`; persist the scheduler **only if one row changed**; commit. Returns the claimed row or `null`. A `SQLITE_BUSY` or lease mismatch is `lease-lost`/retry, never a silent success. |
| `settle(id, owner, requeue?)` | Short txn with an owner CAS: `WHERE id=? AND state='running' AND claimed_by=?`. Delete, or reset to `queued` with tail `enqueued_ms` and the merged resume payload. The caller supplies the already-incremented `requeue_count`. Zero rows means the claim was stolen; do not touch the new owner's row. |
| `recover(owner)` | After lease acquisition: reset `running` rows with `claimed_by <> owner` to `queued`; at `attempts >= 3` mark `failed` with `failed_ms`. |
| `prune(now)` | Delete expired `queued` rows; leave `running` rows alone. |
| `dropStale(ids)` | Delete queued rows whose handler `stillDue` is false (the tick computes the ids; the store stays handler-agnostic). |
| `pruneFailed(olderThanMs)` | Delete `failed` rows older than the retention window (CLI). |
| `has(id)` | `EXISTS` for `state IN ('queued','running')` — never `failed`. |
| `dump()` | Serialize `{items, scheduler}` in the legacy v2 shape for backup/rollback. |
| `leaseAcquire/Refresh/Release` | Short txns on `lease`; 90 s TTL, 30 s refresh, steal when expired or the PID is dead (`holderDead`). |

### 3.4 Transaction boundaries

1. Tick start: open store → acquire lease → recover → prune → drop stale →
   ingest user-task files → `enqueue` → `snapshot`. If the store is
   unavailable, return `store-unavailable` and skip the tick.
2. Per item: short `BEGIN IMMEDIATE` lease check + pick + claim + scheduler
   update; commit.
3. `handler.run` executes with no open transaction.
4. Settle: short `BEGIN IMMEDIATE` with `id + claimed_by` CAS; 0 rows means the
   claim was stolen, so the result is discarded; commit.
5. Lease refresh: one short `UPDATE` every 30 s; 0 rows means lost.
6. Producer enqueue: one short transaction; a full queue returns `rejected`
   without writing.

The child run must **never** sit inside a transaction. A DB failure throws a
typed `StoreError`; the tick records an `outcome: "error"` ledger line and
leaves the row `running` for recovery rather than swallowing the failure.

The owner CAS is mandatory: the lease refresh timer is 30 s and the TTL 90 s
(`ownership.ts:28-31`, `:160-163`), but a suspended process can lose the lease
mid-run. A stale owner must never delete or reset a row that a new owner has
claimed.

### 3.5 Recovery semantics

At-least-once. On lease acquisition, rows in `running` owned by a different
owner token are reset to `queued` (or `failed` at the attempt cap). A mission
may therefore execute twice if the process dies after the child completed and
before `settle`.

Consequences that the handlers must accept, and that Step 6 tests:

- `mission` dispatch records `last_mission`/`last_runs` before the child runs
  (`work-kinds/mission.ts:173-175`); a recovery re-runs the same mission and
  overwrites those fields deterministically. Side effects such as backlog rows
  and idea writes (`:203-208`) may appear twice.
- `user-task` settles by moving the task file (`work-kinds/user-task.ts:176-186`).
  A recovered row whose file is already settled is `stillDue = false`, so
  `dropStale` deletes it; a second run cannot re-execute a settled task.
- `drain-pass` is a summary operation; a second pass must be safe to run.

Duplicate execution is recorded in the existing NDJSON item ledger (`verdict`,
`session`, `attempt`) so it is observable. If a handler cannot be made
idempotent, it must opt out of recovery (mark the row `failed` at claim time)
rather than rely on the store.

### 3.6 Lease

The heartbeat lease moves into the `lease` row. `ownership.ts` stays as-is for
chron's separate `state/chron.lock`; only the heartbeat stops importing it.
Owner token: `pid:pid_start:random`. Steal rules: `heartbeat_ms < now - ttl` or
`holderDead(pid, pid_start)`. Acquisition is a short `BEGIN IMMEDIATE`; release
deletes the row only when the owner still matches.

`claim` and `settle` re-check the lease row inside their own transaction, so a
stale owner cannot mutate the queue after a steal even if its refresh timer
still appears to work.

### 3.7 Configuration

New `storage:` section. SQLite is the only runtime driver; `dump` is the
export/rollback path.

```yaml
storage:
  path: work.db           # leaf under .opencode/state
  busy_timeout_ms: 5000
  synchronous: NORMAL     # NORMAL | FULL
  failed_retry_ms: 3600000
  failed_retention_days: 30
```

`chron.inbox_dir` becomes legacy: accepted but unused after the migration; the
importer reads it once to find the old spool.

### 3.8 Legacy import and rollback

First open:

1. Create the schema and set `user_version=1`.
2. In one `BEGIN IMMEDIATE`, check the `meta` marker; if absent, import
   `work-queue.json` items and scheduler and valid `state/inbox` intents
   (respecting `expires_ms`), then set the marker. A second opener waits on the
   write lock and sees the marker.
3. Copy `work-queue.json` and move the inbox tree to
   `.opencode/state/backup/pre-sqlite-<ts>/` after the transaction commits.
4. Do not import `ownership.lock`; it is stale by definition.

Rollback: run `scripts/work-store.mjs dump`, which writes the legacy v2
`work-queue.json` (`running` rows emitted as `queued`), then check out the
previous commit. The DB stays in place for re-entry; `import` restores it.

## 4. Assumptions and evidence

| Assumption | Status | Evidence |
| --- | --- | --- |
| Node 24 `node:sqlite` supports WAL, STRICT, `BEGIN IMMEDIATE` | verified | smoke test on Node v24.19.0, SQLite 3.53.3: `journal_mode=wal`, STRICT table created, insert committed, `integrity_check=ok` |
| Existing test runner works | verified | `node --test .opencode/plugin/lib/work-queue.test.ts`: 15 pass, 0 fail |
| Dashboard server runs Node with `node:sqlite` | verified | `Dashboard/package.json` runs `node --no-warnings server/index.mjs`; Node v24.19.0 |
| `.opencode/state/` is gitignored, so the DB and backups are local-only | verified | `.gitignore:27-28` |
| `ownership.ts` is shared with chron | verified | `chron/chron.ts:14,127`; only the heartbeat import changes |
| Plugins run on Bun, tests on Node | runtime unverified | `drain/sqlite.ts:3-6`; Bun is not installed in this environment. Step 1 adds a read-write startup probe; Step 8 is blocked until it is observed on the real opencode runtime. |
| A read-write SQLite binding exists on the plugin runtime | unverified | `drain/sqlite.ts:43-53` only opens read-only; no `run()` or transaction surface is exercised. |
| Mission `last_evaluated_ms` lives outside the store | verified | `production/missions.ts:46-59`, `:173-175` |
| User-task files remain the human rail | verified | `user-tasks.ts:1-7`; `queue_add` writes Markdown only (`tools/queue-add.ts:1-7`) |

## 5. Steps

Each step is one diff. The acceptance check is a command or a direct
observation. Evidence is appended when the step lands.

### Step 1 — Add the read-write SQLite opener, schema, and store contract

Action: add `lib/work-store.ts` (types), `lib/sqlite/open.ts` (lazy
`bun:sqlite` / `node:sqlite` read-write opener), `lib/work-store/sqlite.ts`
with the schema, `meta`, and `user_version=1`, plus `lib/work-store.test.ts`
for open/schema.

Acceptance: a temp DB opens with WAL, the four tables, `integrity_check = ok`,
and `user_version = 1`; the plugin startup logs `sqlite: ok` from a read-write
probe on the real opencode runtime (Bun). If the probe fails, the work path
stays disabled and Step 8 is blocked.

Evidence: `node --test .opencode/plugin/lib/work-store.test.ts` (open/schema) passes on Node v24.19.0. The startup probe logs `sqlite: ok (node)`; the Bun branch is compiled but unobserved because Bun is not installed in this environment.

### Step 2 — Implement SQLite queue semantics

Action: implement `enqueue`, `snapshot`, `claim`, `settle`, `prune`,
`dropStale`, `recover`, `has`, and `dump` with the transaction boundaries in
§3.4.

Acceptance: the conformance suite passes; a crash/reopen test resets `running`
to `queued`; a capacity test rejects item 51 without writing; a duplicate-id
test is a no-op; `enqueue` returns per-id outcomes; a `failed` id is replaceable
only after the cooldown; `has` ignores `failed`; two connections enqueue/claim
without lost updates.

Evidence: 13 store tests pass, including crash/reopen recovery, capacity-51 rejection, duplicate no-op, failed-cooldown replacement, `has` ignoring failed rows, and two-connection claim.

### Step 3 — Move scheduler state and the heartbeat lease

Action: persist `scheduler_state` in the claim transaction and add the
DB-backed lease in `lib/lease.ts`. Leave `ownership.ts` untouched for chron.

Acceptance: lease tests cover acquire, refresh, steal after TTL, dead-PID
steal, and owner-only release; a scheduler test proves credits and the claim
commit together and survive a reopen; a stale-owner `settle` after a steal
returns zero rows and leaves the new owner's row intact; a claim by a stale
owner is rejected.

Evidence: `node --test .opencode/plugin/lib/lease.test.ts` — 7 pass; claim persists the scheduler in the same transaction; a stale-owner settle returns zero rows and leaves the new owner's row intact.

### Step 4 — Add config, migration, backup, and rollback

Action: add `lib/storage-config.ts`, the `storage:` block, the transactional
one-time importer, the `meta` marker, the backup directory, and the `dump`
export.

Acceptance: a config parse test; a migration test seeds a v2 queue and inbox
files, opens the DB, and asserts rows, scheduler, backups, and a no-op second
open; a concurrent-first-open test leaves exactly one import; `dump`
round-trips DB → legacy JSON.

Evidence: storage-config + migrate tests pass (7); a concurrent first open imports once; a v2 queue and inbox seed import rows, scheduler, and backups with a no-op second open; `dump` → `restore` round-trips ids and scheduler state.

### Step 5 — Switch producers to the store

Action: change `production/missions.ts` to `store.enqueue` (dropping the
`queuedIds` snapshot and `writeIntent`); change `chron/jobs/drain.ts` to
`store.has("drain-pass")` for both the queued check and the intent check, and
replace its `writeIntent` call (`drain.ts:249-272`) with `store.enqueue`;
retire the write path in `production/intents.ts` and convert
`production/intents.test.ts` to importer coverage. On `rejected` (full), do not
advance `last_evaluated_ms` or `last_emitted_ms`, so the occurrence retries; a
`duplicates` result advances the occurrence as already handled.

Acceptance: updated `production/missions.test.ts`, `chron/jobs/drain.test.ts`,
and importer coverage in `production/intents.test.ts` pass; a full-capacity
test proves the mission occurrence is retried; a duplicate-id enqueue advances
the occurrence and creates no second row; a duplicate `drain-pass` enqueue is a
no-op; no run writes under `state/inbox/`.

Evidence: `node --test .opencode/plugin/lib/production/missions.test.ts .opencode/plugin/lib/chron/jobs/drain.test.ts` — 38 pass; a full store rejects the occurrence and the next scan retries it; a duplicate advances the occurrence; producers write no inbox files.

### Step 6 — Switch the tick consumer to the store

Action: route `heartbeat-hook.ts` open/merge/claim/settle/lease through the
store; update `work-producers.ts` and `work-kinds/user-task.ts` for `store.has`
dedupe; ingest user-task files at tick; call `dropStale` with the
handler-computed ids; record DB failures and `attempt` in the ledger.

Acceptance: `heartbeat-hook.test.ts` passes with the store seam (its
`writeIntent` seeds move to the store); an end-to-end test seeds the DB, runs
one item, and asserts the settle; a recovery test runs a mission twice and
asserts the second attempt is ledgered; a crash-after-user-task-settle test
drops the stale row instead of leaking a slot; `rg` shows no
`loadWorkQueueState`, `saveWorkQueueState`, or `mergeIntents` in
`heartbeat-hook.ts`.

Evidence: `node --test .opencode/plugin/lib/heartbeat-hook.test.ts` — 30 pass with store seeding; crash recovery re-runs and ledgers `attempt`; a crash-after-user-task-settle drops the stale row; `rg` shows no `loadWorkQueueState`, `saveWorkQueueState`, or `mergeIntents` in `heartbeat-hook.ts`.

### Step 7 — Update Dashboard, CLI, stale guard, and docs

Action: read the DB read-only in `Dashboard/server/data.mjs`; add
`scripts/work-store.mjs` with `dump`, `import`, `integrity`, and `prune-failed`;
add every new store/lease file to `HEARTBEAT_CODE_FILES` and `CHRON_CODE_FILES`;
update `docs/sysop-config-reference.md`, `docs/user-task-queue.md`,
`wiki/Mission-Producers.md`, `Dashboard/SPEC.md`, and amend
`docs/CHRON-SCHEDULER-PLAN.md` §1/§5.1/§13 so "no producer writes the queue"
becomes "producers insert `queued` rows only; the consumer owns transitions".

Acceptance: the dashboard queue endpoint returns a seeded DB row; the CLI
`dump` → `import` round-trip preserves ids and scheduler state; `prune-failed`
removes only rows past retention; the stale-code test passes; `rg -n
"work-queue.json|loadWorkQueueState|saveWorkQueueState|mergeIntents"` matches
only the importer/dump, tests, and historical docs.

Evidence: `readQueue` returns a seeded row from `work.db` with its scheduler; `node scripts/work-store.mjs dump` and `integrity` pass; the widened `rg` gate matches only the importer/dump, tests, and historical docs.

### Step 8 — Cutover and rollback drill

Action: make SQLite the default (and only) runtime store and run the rollback
drill.

Acceptance: the Step 1 Bun probe is green and logged on the real runtime; the
full suite passes; a simulated crash between claim and settle recovers the row;
`dump` produces a valid legacy `work-queue.json` that the previous commit can
read; a final scan shows no inbox writes.

Evidence: the full suite passes (1032 tests); a simulated crash between claim and settle recovers the row; `dump` produces a legacy v2 file the previous reader parses; the Bun probe is the one blocked item (Bun is not installed here).

## 6. Verification matrix

| Step | Check command / observation | Result |
| --- | --- | --- |
| 1 | `node --test .opencode/plugin/lib/work-store.test.ts` + Bun probe log | pass (Node); Bun branch pending |
| 2 | `node --test .opencode/plugin/lib/work-store.test.ts` (sqlite) | pass |
| 3 | `node --test .opencode/plugin/lib/lease.test.ts` | pass |
| 4 | `node --test .opencode/plugin/lib/storage-config.test.ts .opencode/plugin/lib/work-store/migrate.test.ts` | pass |
| 5 | `node --test .opencode/plugin/lib/production/missions.test.ts .opencode/plugin/lib/chron/jobs/drain.test.ts` | pass |
| 6 | `node --test .opencode/plugin/lib/heartbeat-hook.test.ts` | pass |
| 7 | dashboard queue read + `node scripts/work-store.mjs dump` + `rg` gate | pass |
| 8 | `find .opencode/plugin/lib -name '*.test.ts' -print0 \| xargs -0 node --test` | pass (1032); Bun probe pending |

Full-suite command (repo convention):
`find .opencode/plugin/lib -name '*.test.ts' -print0 | xargs -0 node --test`.

## 7. Critique log

Round 1 (fresh subagent, 2026-11-02). Findings and resolutions:

- Blocking — no step proved `bun:sqlite` read-write on the real plugin
  runtime. Resolved: Step 1 adds a startup probe; Step 8 is gated on it.
- Blocking — Step 6 only named the mission producer; drain still emitted via
  `writeIntent` (`drain.ts:249-272`). Resolved: Step 5 rewires both producers
  and their tests.
- Blocking — the plan reversed the documented producer boundary without
  updating it. Resolved: Step 7 amends `CHRON-SCHEDULER-PLAN.md`
  §1/§5.1/§13.
- Blocking — at-least-once had no duplicate-safety test. Resolved: §3.5 lists
  the handler consequences; Step 6 adds the recovery test.
- Important — failed stable ids could never be re-enqueued. Resolved:
  `failed_ms` + cooldown replacement; `has` ignores failed.
- Important — `settle` had no owner CAS. Resolved: `settle(id, owner, ...)`
  and Step 3 test it.
- Important — `attempts` and `requeue_count` were conflated. Resolved: §3.2
  defines them separately; the handler owns the `requeue_count` increment.
- Important — failed-row cleanup was promised but not scheduled. Resolved:
  `pruneFailed` in Step 7.

Round 2 (fresh subagent, 2026-11-02). Findings and resolutions:

- Blocking — `prune` did not drop work whose backing entity is gone, so a
  recovered `user-task` row could leak a queue slot. Resolved: `dropStale(ids)`
  plus a Step 6 crash-after-settle test.
- Blocking — the files adapter could not pass the same conformance suite as
  SQLite (no `running` state, no owner CAS). Resolved by adopting the simpler
  path: SQLite is the only runtime driver; the file queue is importer/dump
  only. This removes the dual-driver parity requirement.
- Important — `has()` matched `failed` rows, dead-ending stable ids. Resolved:
  `has` is `state IN ('queued','running')`; `enqueue` replaces `failed` rows
  after a cooldown.
- Important — `enqueue` returned counts, which cannot drive per-mission
  `last_evaluated_ms`. Resolved: per-id arrays.
- Important — the migration marker had no table and the first open was not
  transactional across the two plugin openers. Resolved: `meta` table and one
  `BEGIN IMMEDIATE`; a concurrent-first-open test.
- Important — `claim` was not lease-fenced and could persist the scheduler on a
  failed claim. Resolved: lease check inside the claim txn; scheduler persisted
  only on a one-row change; busy is lost/retry.
- Important — a failed `open()` left the heartbeat running without a lease.
  Resolved: `store-unavailable` skips the tick.
- Minor — the ledger `attempt` field was mentioned but not scheduled; the `rg`
  gate missed `loadWorkQueueState` and matched `wiki/`/`SPEC.md`. Resolved:
  Step 6 adds `attempt`; Step 7 widens the gate and updates those docs.

Simpler path adopted in round 2: no dual runtime driver. Rollback is `dump` +
the previous commit, which keeps the recovery semantics honest and removes a
second store implementation.

## 8. Risks

- **Bun runtime not exercised here.** The plugin path needs `bun:sqlite` for
  read-write. Step 1 adds a startup probe; the store stays off until it is
  green. The opener must be lazily imported so a missing binding cannot drop
  the whole plugin (`drain/sqlite.ts:3-6`).
- **Stable ids and failed rows.** `mission:<id>` and `drain-pass` are reused;
  `enqueue` replaces `failed` rows only after the cooldown, and `has` ignores
  them, so work kinds do not dead-end or tight-loop.
- **Stale owner after a steal.** `claim` and `settle` re-check the lease owner;
  never mutate another owner's row.
- **STRICT support on Bun's bundled SQLite.** Node 3.53.3 supports it; if the
  Bun probe rejects `STRICT`, drop `STRICT` (the CHECK constraints remain)
  rather than changing schema semantics.
- **Write contention.** WAL + `busy_timeout=5000`; transactions are short. A
  lease refresh that cannot write for >60 s risks a stale lease; log and retry
  before the 90 s TTL.
- **At-least-once duplicates and side effects.** Explicit. Handlers must
  tolerate a second run; `attempts` caps at 3; §3.5 names the side effects.
- **Migration import is the one irreversible-ish moment.** Copy, never delete,
  the legacy queue and inbox; require the `meta` marker before normal operation.
- **Observability.** JSON was `cat`-able; the ops CLI and Dashboard replace
  that. `PRAGMA integrity_check` runs on open as a diagnostic.
- **Scope creep.** `heartbeat.json` (`last_tick`, `last_runs`),
  `heartbeat.current.json`, chron state, mood/sleep/idea, and drain producer
  state stay files in this pass.
- **Chron's lock stays a file.** Only the heartbeat lease moves; `ownership.ts`
  remains for `state/chron.lock`.
