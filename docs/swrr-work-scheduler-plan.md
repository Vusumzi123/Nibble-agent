# SWRR Work Scheduler — Starvation-Free Heartbeat Plan

Status: **implemented (core)** — SWRR picker, fair heartbeat path, persisted
credits, Dashboard panels and the `fair: false` rollback are live as of
2026-10-27. Background step kinds and mission-level bounded candidacy remain
follow-ups (see §7.4 and §9.2).
Date: 2026-10-27
Scope: Kael heartbeat scheduler + Dashboard v2
Supersedes the scheduling assumptions in `docs/heartbeat-lanes.md` and the
consumer-era assumptions in `docs/drain-consumer.md`.

Related: [Dashboard SPEC](../Dashboard/SPEC.md) ·
[historical lane queues](heartbeat-lanes.md) ·
[historical drain consumer](drain-consumer.md) ·
[sysop config reference](sysop-config-reference.md).

## Implementation status

Landed:

- `lib/work-queue.ts` — SWRR state, `pickFair`, `refundFairPick`, v2 queue file.
- `lib/scheduler-config.ts` — `scheduler.fair` + per-kind weights, hot-read.
- `heartbeat-hook.ts` — fair picker, no staleness side lane on the fair path,
  persisted credits, scheduler ledger fields, `fair: false` legacy rollback.
- `Dashboard/` — QUEUE scheduler panel, FLIGHT next-kind, METRICS service
  share, SETTINGS schema, `/api/queues` scheduler payload.
- Tests — proportional service, no-starvation gaps, zero-weight disable,
  refund, state persistence, config parsing, and a fair staleness integration.

Deferred, explicitly:

- `quiet-hours` / `profile-update` / `soul-update` still run as self-gating
  maintenance after the tick; they are not yet queue items (§7.4).
- Mission-definition fairness (`idea-generate` unbounded candidacy) is still
  the bounded-candidacy follow-up (§9.2).

## 1. Why this exists

Before this change, the single heartbeat loop used a **strict priority gate**:

```text
mission > drain-pass > quiet-hours > staleness > profile-update > soul-update
```

`pickNext()` always takes the lowest-priority number. Missions are re-collected
on every tick; `drain-pass` is one long-lived queue item. A mission candidate
therefore outranks drain every tick, forever.

Observed in live Kael on 2026-10-27:

- a `drain-pass` item sat queued from 17:02 while ticks 5–13 ran missions;
- backlog grew to 81 pending turns / 12 sessions;
- the pending oldest turn was over 3 hours old;
- two successful drain passes later reduced pending 81 → 63 → 40, proving the
  pipeline works when it actually gets a slot.

This is **starvation**, not a lock, crash, or deadlock. The work is healthy;
the scheduler never selects it.

There is a second bug that makes the priority table misleading: staleness
does not go through `pickNext()` at all. `heartbeat-hook.ts` only honors a
`drain-pass` result, then falls through to a separate side lane that runs
staleness in addition to the mission. In practice:

```text
mission exists  -> mission + staleness run; drain waits
no mission      -> drain runs; staleness waits
```

So the documented order `drain > staleness` is false in the common case.
The fix must remove the bypass, not just change numbers.

## 2. Goals

1. No runnable work kind can starve while another kind runs.
2. Drain gets a guaranteed, predictable share; when a pass succeeds and
   service outpaces arrivals, the backlog falls.
3. New work kinds are safe by default: adding one cannot silently starve
   existing kinds.
4. The rule is structural, not reactive: no “waited too long, boost it”
   timers or starvation counters.
5. The guarantee is testable, observable in the ledger, and visible in the
   Dashboard.
6. One scheduler, one executor, no new locks or daemons.

## 3. Non-goals

- Reintroducing the drain consumer loop or concurrent executors.
- Replacing JEV mission judgment.
- Guaranteeing every individual mission definition runs (that needs a
  second-level policy; see §9).
- Fixing drain summarizer/writer quality. The writer report bug is a
  prerequisite for *consumption*, not for scheduling.
- Making config weights a substitute for correct queue semantics.

## 4. Current-state accuracy notes

These are the facts the plan is built on; several older docs are stale.

| Area | Current reality |
| --- | --- |
| Queue | One `work-queue.json`; `WORK_PRIORITY` and `pickNext()` are a static priority gate. |
| Mission collection | `collectMissions()` re-enqueues every digest candidate each tick; dedupe preserves the first enqueue time. |
| Drain | A `drain-pass` work item, enqueued by the heartbeat when `drainDue()` is true. There is no consumer loop. |
| Staleness | A side mission that bypasses the priority picker and runs beside the mission. |
| `drain.consumer` | Still present in config (`true`) but no longer starts a loop. Phase 1 deleted the loop in commit `466d440`; `true` now means “enqueue a `drain-pass` work item”, while `false` falls back to the legacy side-mission collection path. |
| Locks | No `drain.lock` or `mission.lock` in the work path; the ownership lease is the only exclusion. |
| Docs | `docs/heartbeat-lanes.md` describes removed two-lane queues; `docs/drain-consumer.md` describes a removed consumer loop and `drain.lock`. They are historical. |
| Mission candidacy | `idea-generate` can remain a candidate every tick after a `review-reject` because `generatedToday` stays 0. This is unbounded work pressure, not starvation by itself. |
| Dashboard | Dashboard v2 reads live state from a separate local Node server on `127.0.0.1:4097`; it is not wired into the harness service. |

## 5. Design: smooth weighted round-robin

Replace the priority gate with **smooth weighted round-robin (SWRR)** over
**work kinds**.

SWRR is not a timeout boost. It is a proportional-share algorithm: every
runnable kind accrues credit at a fixed rate and the highest-credit kind runs.
No kind can be skipped indefinitely while it remains runnable.

### 5.1 Default weights

Initial proposal (tunable; see §11):

```yaml
scheduler:
  weights:
    mission: 4
    drain-pass: 3
    staleness: 1
    quiet-hours: 1
    profile-update: 1
    soul-update: 1
```

With only mission and drain runnable, drain gets 3/7 of picks. With all six
kinds runnable, drain gets 3/11. At a 15-minute tick, that is roughly one
drain slot every 3–4 ticks under full contention and every ~2–3 ticks under
mission/drain contention.

Weights are relative, not durations. A weight of 0 disables a kind. Unknown
future kinds default to 1 unless the config says otherwise.

### 5.2 Scheduler state

Persist fairness beside the queue, in the same file to avoid a second
read-modify-write owner:

```json
{
  "version": 2,
  "items": [],
  "scheduler": {
    "weights": {
      "mission": 4,
      "drain-pass": 3,
      "staleness": 1
    },
    "credits": {
      "mission": -1,
      "drain-pass": 2
    },
    "served": {
      "mission": 120,
      "drain-pass": 41
    },
    "last_kind": "drain-pass",
    "updated_ms": 1793121760995
  }
}
```

Backward compatibility:

- an old array `work-queue.json` still loads;
- missing `scheduler` starts with zero credits;
- corrupt scheduler state resets credits but keeps items;
- one atomic writer.

### 5.3 Pick algorithm

After producers run and prunable work is removed:

1. Build the **runnable set**: kinds with at least one due item that passes
   `itemRunnable()` / `drainDue()`.
2. If the set is empty: silent tick, zero LLM calls, no credit spent.
3. For every runnable kind: `credit[k] += weight[k]`.
4. Pick `k = argmax(credit)`. Tie-break by fixed kind order for determinism.
5. `credit[k] -= sum(weight[j] for j in runnable)`.
6. Pick one item from `k`:
   - `mission`: JEV chooses the mission (the class slot is already reserved).
   - `drain-pass`: run the drain step.
   - `staleness`: run that side mission.
   - `quiet-hours`, `profile-update`, `soul-update`: run their step.
7. If the selected item becomes un-runnable before execution, refund the
   credit and re-pick once. If no item remains, silent tick.
8. Persist queue + scheduler atomically before dispatch.

Within a kind, keep FIFO by `enqueued_ms` and honor `not_before_ms` / TTL.
SWRR decides **which kind**; it does not override item-level due checks.

### 5.4 Guarantee

For a kind that remains continuously runnable with weight `w` and total
runnable weight `W`:

```text
max consecutive picks without kind k <= ceil(W / w)
```

No special-case drain rule is needed. The guarantee holds for every positive
weight, including future kinds.

### 5.5 JEV `no_reply`

A mission slot that the JEV answers with `no_reply` should **spend** the slot.
Silence is a valid decision, and the next tick’s credits then favor background
work. Refunding would let repeated `no_reply` starve background work again.

If the mission class was selected but no candidate exists, that is a
producer/runnable-set bug, not a JEV outcome; do not spend credit for a class
that was not actually runnable.

### 5.6 Failure and retry

- Drain failures keep the cursor/backoff behavior in `drain/step.ts`.
- A failed drain does not refund its scheduling credit; it got its slot.
- The next drain selection happens when its credit comes around again.
- A poisoned drain batch still obeys the existing cursor/backoff rules; SWRR
  does not override them.

## 6. Consumption fix (landed)

SWRR guarantees drain is **selected**. It does not guarantee the pass
succeeds.

Known live failure before the successful passes (the all-replies parser fix
has since landed in `brain.ts`):

```text
invalid report: no report fence
```

The writer spawn used to take only the newest assistant reply (`replies[0]`).
If the writer emitted a valid report and then a trailing acknowledgement, the
parser saw only the ack and rejected the pass. The landed fix:

1. Select the newest reply containing a valid `consolidated`/`skipped` fence.
2. Keep the newest reply for telemetry if desired.
3. Add a test with replies `["report", "ack"]`.
4. Never advance the cursor on an invalid report.

Acceptance for “drain consumed” is therefore:

- scheduler test: drain gets a slot within the SWRR bound;
- pipeline test: a fake drain step advances a cursor/pending counter;
- live test: pending turns drop after a successful pass.

## 7. Integration points

### 7.1 `work-queue.ts`

- Replace `WORK_PRIORITY` + `pickNext()` with:
  - `WorkWeights` / `DEFAULT_WEIGHTS`;
  - `emptyScheduler()`;
  - `pickFair(queue, scheduler, nowMs, isRunnable)`;
  - `spendCredit(scheduler, kind, runnableKinds)`;
  - `loadWorkQueueState()` / `saveWorkQueueState()`.
- Keep `enqueueWork`, `pruneWork`, `requeueTail`, `stallResumeItem`.
- Keep `WORK_PRIORITY` only as a deterministic tie-break or remove it after
  migration; do not use it as the execution rule.

### 7.2 `heartbeat-hook.ts`

- Delete the `if (nextWork?.kind === "drain-pass")` special case.
- Delete the side-lane staleness pick at the later dispatch step.
- Build the runnable set once; call `pickFair()`; execute the selected kind.
- Keep the mission JEV path unchanged after a mission slot is selected.
- Record `scheduled_kind`, `scheduler_credit_before/after`, and
  `scheduler_runnable` in the tick ledger.
- Keep one work unit per tick.

### 7.3 Producers

- `collectMissions()` and `collectStaleness()` stay deterministic and
  enqueue-only.
- The heartbeat remains responsible for enqueuing `drain-pass` when
  `drainDue()` is true.
- No producer may execute or schedule; it only states intent.

### 7.4 `step-registry.ts` (follow-up)

`quiet-hours`, `profile-update`, and `soul-update` are still self-gating
maintenance steps executed after the tick; they are not enqueued as fair work
kinds yet. `quiet-hours` also owns window transitions, so it cannot be gated
solely on “due” without a separate transition pass. Until then their weights
are reserved and unused. The fair path already dispatches a queued step kind
if one appears, so wiring the producer later does not change the scheduler core.

### 7.5 Configuration

Recommended shape:

```yaml
scheduler:
  weights:
    mission: 4
    drain-pass: 3
    staleness: 1
    quiet-hours: 1
    profile-update: 1
    soul-update: 1
  fair: true   # false = legacy static-priority rollback
```

- Hot-read at tick start.
- Validate positive integers; 0 disables; unknown kind defaults to 1.
- `fair: false` restores the static priority order for one release, then is
  removed.
- Expose the section in Dashboard Settings as `scheduler` (writable weights,
  `fair` toggle with a restart/hot-read marker).
- Implementation touches `.opencode/plugin`; that is approval-gated under the
  agent operating contract, even after this plan is accepted.

## 8. Dashboard v2 integration

Dashboard v2 is a separate live-data UI at `Dashboard/`; it is not part of
the harness process. It reads the same state/log/database sources and serves
the built SPA plus `/api` from `127.0.0.1:4097`.

Current relevant surface:

- `GET /api/queues` — unified queue + running + drain summary.
- `GET /api/drain` — pending, oldest age, `queued` / `queued_since` /
  `queued_age_ms`, passes, cursor.
- `GET /api/runs` — mission and drain run history; drain pipe lines are now
  projected as `kind: "drain"`.
- `GET /api/metrics/*` — token/cost/error/throughput; drain runs now flow
  through the same `readRuns()` projection.
- Pages: FLIGHT, METRICS, QUEUE, MISSIONS, LOGS, SETTINGS.

### 8.1 API additions

`GET /api/queues` gains:

```json
{
  "scheduler": {
    "fair": true,
    "weights": { "mission": 4, "drain-pass": 3 },
    "credits": { "mission": -1, "drain-pass": 2 },
    "served": { "mission": 120, "drain-pass": 41 },
    "next_kind": "drain-pass",
    "max_gap": { "mission": 2, "drain-pass": 3 },
    "runnable": ["mission", "drain-pass"]
  }
}
```

`/api/runs` already includes drain fields:

- `kind: "drain"`;
- `trigger` (`tick` / `tool`);
- `pending_before` / `pending_after`;
- `batch_sessions` / `batch_items`;
- `cost` and `session` enriched from writer ledger lines.

Optional: add `scheduled_kind` and `scheduler_credit` to mission run rows from
`heartbeat.log` so the UI can show why a tick chose a kind.

### 8.2 QUEUE page

Add a **scheduler** panel above the work queue:

- current runnable kinds;
- each kind’s weight, credit, served count;
- next kind;
- observed max gap vs the SWRR bound;
- drain queued age and whether a pass is due.

Run history:

- `kind` filter includes `drain`;
- drain rows show tokens, cost, duration, trigger, pending before → after,
  batch sessions/items;
- drain error rows are visible with the same error tone;
- no double counting: only `drain.log` `source: "pipe"` is a run; writer lines
  are enrichment.

### 8.3 FLIGHT page and status strip

- Keep `mission / lease` and `drain backlog` labels.
- Add the next scheduled kind to the queue cell or drain cell once the
  scheduler state exists.
- Do not show a stale side mission while idle; the backend already sanitizes
  side fields when `state !== "in-flight"`.
- Drain cell should distinguish `queued`, `idle`, `disabled`, and
  `in-flight`.

### 8.4 METRICS page

- Drain runs already contribute to run history and token/cost/error metrics
  because `readRuns()` is shared. Keep that behavior; it is the honest total.
- Add a small **service share** widget when scheduler state is available:
  served counts vs weights, with drain’s max gap highlighted.
- Keep the drain backlog panel and the current queue age panel; do not present
  current queue age as historical wait.

### 8.5 SETTINGS page

Add a `scheduler` section:

- `fair` toggle (hot-read; rollback only);
- per-kind weight inputs (`mission`, `drain-pass`, `staleness`,
  `quiet-hours`, `profile-update`, `soul-update`);
- validation: positive integers, 0 disables, at least one enabled kind;
- warning that changing weights changes mission cadence;
- read-only “observed service” summary from the last 24 h.

### 8.6 Dashboard data and build contract

The scheduler additions do not change Dashboard transport:

```text
Dashboard/server/data.mjs   -> read queue/scheduler/runs/drain/metrics
Dashboard/server/index.mjs  -> expose /api/queues and existing routes
Dashboard/src/app/pages     -> QUEUE, FLIGHT, METRICS, SETTINGS
```

Build/run:

```sh
cd Dashboard
npm run build
npm run server     # 127.0.0.1:4097, serves dist + API
```

There is no demo fallback. If the scheduler state is missing, the UI shows
`not available` rather than inventing weights or credits.

## 9. Scaling: more work kinds vs more missions

This is the part that most needs to be explicit.

### 9.1 New work kinds — SWRR handles them

Examples: `notify`, `telegram-triage`, or a future quiet-hours variant.

- Add a weight; SWRR includes the kind automatically.
- The no-starvation guarantee still holds.
- **But latency grows with total weight.** Adding ten kinds at weight 1
  dilutes drain’s share. If drain’s max gap becomes unacceptable, rebalance
  weights or move to hierarchical SWRR.

### 9.2 New mission definitions — SWRR does not handle them by itself

Adding files under `.opencode/missions/` creates more candidates inside the
single `mission` kind. SWRR only guarantees the mission *class* gets slots.
JEV/FIFO can still ignore one mission definition indefinitely.

Options, in order of preference:

1. **Bounded candidacy (recommended now).** Every mission has a finite
   attempt/cooldown budget. A mission that cannot make progress stops being
   re-offered every tick. Fix `idea-generate` first: a `review-reject` should
   consume the draw or enter a bounded retry.
2. **Mission-level SWRR.** A second fair queue over mission ids inside the
   mission class. More machinery; only add when mission definitions actually
   contend.
3. **One work kind per mission type.** Scales poorly; weights multiply and
   every new mission changes the global denominator.

### 9.3 Many kinds — hierarchical SWRR

If the kind count grows, use two levels:

```text
level 1: mission (4) vs maintenance (2)
level 2: maintenance -> drain (3), staleness (1), quiet-hours (1), ...
```

This keeps the mission/background split stable as maintenance kinds are added.
Drain’s share is set inside the maintenance class instead of being diluted by
every new top-level kind.

## 10. Tests and observability

### 10.1 Pure scheduler tests

- 2 kinds, weights 4:3 → expected interleaving.
- 3+ kinds; tie-breaking; absent/reappearing kinds.
- Credit persistence across restart.
- Corrupt scheduler state keeps items, resets credits.
- `not_before` and TTL items do not accrue credit while not runnable.

### 10.2 Property/invariant test

For 10,000 random runnable-set sequences:

- every continuously runnable kind’s max gap ≤ `ceil(W / w)`;
- no kind with positive weight is skipped while runnable;
- total picks equal the simulation length.

### 10.3 Heartbeat integration

- Perpetual mission candidate + due drain: drain is selected within the bound.
- Mission `no_reply`: mission slot spent; drain still gets its next slot.
- Staleness enabled: it goes through the same picker; no side-lane bypass.
- Empty runnable set: silent tick, zero LLM calls.
- Drain disabled: no drain credit, no drain item.
- New synthetic kind with weight 1 gets served while drain stays bounded.

### 10.4 Dashboard tests

- `/api/queues` returns scheduler state with weights/credits/next kind.
- `/api/runs?kind=drain` returns drain rows, no writer/tick duplicates.
- Run history drawer shows trigger/pending/batch for drain.
- Metrics totals equal the sum of mission + drain runs.
- Missing scheduler state renders “not available”, not fake numbers.

### 10.5 Ledger fields

Add to each tick line:

```json
{
  "scheduled_kind": "drain-pass",
  "scheduler_runnable": ["mission", "drain-pass"],
  "scheduler_credit_before": { "mission": 1, "drain-pass": 4 },
  "scheduler_credit_after": { "mission": 1, "drain-pass": -3 }
}
```

This makes fairness auditable without re-running the scheduler.

## 11. Rollout

### Phase 0 — measure and document

- Land this plan.
- Mark `docs/heartbeat-lanes.md` and `docs/drain-consumer.md` historical.
- Add a read-only scheduler snapshot to `/api/queues` even before fairness
  ships, so the current starvation is visible.

### Phase 1 — pure scheduler

- Add SWRR types, weights, persistence, and tests.
- Do not wire it into `runTick` yet. No behavior change.

### Phase 2 — wire the heartbeat

- Replace the static picker and the side-lane bypass.
- One work unit per tick.
- Add `fair: false` rollback.
- Run the simulation suite and a temp-state dry run.

### Phase 3 — Dashboard

- Expose scheduler state.
- Add QUEUE scheduler panel, drain run filter/drawer (already partly done),
  FLIGHT next-kind, METRICS service share, SETTINGS weights.
- Verify no double counting in metrics.

### Phase 4 — live validation

- Start with `fair: true` and the proposed weights.
- Measure: drain max gap, pending trend, mission cadence, tokens/cost.
- Tune weights once; do not add a reactive boost.

### Rollback

`Scheduler.fair: false` restores the static priority order for one release.
If the scheduler state is corrupt, items remain and credits reset; the next
tick starts fair service from zero.

## 12. Risks and open decisions

### Risks

- **Mission cadence drops.** Fairness is a trade. Weights decide the split.
- **Long drain pass occupies a whole tick.** One unit per tick preserves the
  single-loop model; it does not make the pass shorter.
- **Drain success is separate.** SWRR cannot fix a writer that never emits a
  report fence.
- **Weights can be misconfigured.** Validate and surface the effective share.
- **Hierarchy adds complexity.** Use flat SWRR until kind count justifies it.
- **Dashboard is separate.** It reads the same state and logs from a local
  `127.0.0.1:4097` process; wiring it into the harness service is outside this
  plan and remains board-held.

### Open decisions

1. **Weights:** mission 4 / drain 3 / others 1, or a different drain cadence?
2. **Tick shape:** one unit per tick (recommended), or mission + one
   maintenance unit per tick with overrun risk?
3. **Mission-level fairness:** bounded candidacy only, or mission-id SWRR now?
4. **Config source:** `scheduler.weights` in `sysop-config.yaml` (recommended)
   or code constants first?
5. **`no_reply`:** spend the mission slot (recommended) or fall through to
   background in the same tick?
6. **Staleness:** fold it into the same fair queue (recommended) or preserve a
   deliberate side lane with an explicit weight?

## 13. Definition of done

- [x] No runnable kind can exceed its SWRR gap bound in the property test.
- [x] A perpetual mission candidate cannot prevent drain from running.
- [x] Staleness no longer bypasses the scheduler.
- [x] Drain selected, pass succeeds, cursor advances, pending falls.
- [x] New work kind test passes without changing the scheduler core.
- [x] Queue/scheduler state persists across restart.
- [x] Tick ledger records scheduled kind and credits.
- [x] Dashboard QUEUE shows scheduler state and drain run history.
- [x] Dashboard METRICS totals include drain exactly once.
- [x] `fair: false` rollback works.
- [x] Stale scheduler docs point to this plan and describe reality.

## 14. File map

| File | Change |
| --- | --- |
| `.opencode/plugin/lib/work-queue.ts` | SWRR types, weights, credits, `pickFair`, persisted state, migration. |
| `.opencode/plugin/lib/scheduler-config.ts` | `scheduler.fair` + per-kind weights parser. |
| `.opencode/plugin/lib/scheduler-config.test.ts` | Config parsing/defaults. |
| `.opencode/plugin/lib/work-queue.test.ts` | SWRR unit + property tests. |
| `.opencode/plugin/heartbeat-hook.ts` | Remove static picker and side-lane bypass; dispatch selected kind; ledger fields. |
| `.opencode/plugin/lib/work-producers.ts` | Keep enqueue-only; no scheduling. |
| `.opencode/plugin/lib/step-registry.ts` | Follow-up: route profile/soul/quiet-hours through selected kind. |
| `.opencode/plugin/lib/drain/step.ts` | Keep trigger/backoff; verify failure retry. |
| `.opencode/plugin/lib/memory/providers/builtin/brain/spawn.ts` | Pick newest reply with a valid report fence. |
| `docs/sysop-config-reference.md` | `scheduler.weights` / `scheduler.fair`. |
| `Dashboard/server/data.mjs` | Scheduler snapshot; drain run projection already added. |
| `Dashboard/server/index.mjs` | `/api/queues` scheduler payload. |
| `Dashboard/src/app/pages/queues.ts` | Scheduler panel, drain run filter/drawer. |
| `Dashboard/src/app/pages/flight.ts` | Next kind / drain state. |
| `Dashboard/src/app/pages/metrics.ts` | Service share widget. |
| `Dashboard/src/app/pages/setup.ts` | Scheduler weights section (schema-driven). |
| `Dashboard/server/settings.mjs` | `scheduler` schema + validation. |
| `Dashboard/src/app/core/models.ts` | Scheduler/RunRow fields. |
| `Dashboard/SPEC.md` | Scheduler surface + run history contract. |
| `docs/heartbeat-lanes.md` | Historical note + link to this plan. |
| `docs/drain-consumer.md` | Historical note: consumer loop removed in Phase 1. |

## 15. Final note

The important change is not “drain gets a higher number.” It is that **priority
stops being a gate**. Every runnable kind receives service in proportion to
its weight, and the scheduler proves it by construction. That is what prevents
starvation when drain, staleness, dreams, or future mission kinds are added.
