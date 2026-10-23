# The Drain Consumer

How memory consolidation is scheduled, and how to tune or roll it back.

Before this change, drain rode the heartbeat's side lane as
`candidacy: turns-pending`, so it got at most **one dequeue per tick**: a p50
gap of 30 minutes between passes and a measured starvation stretch of 7.8 h.
The consumer (docs/drain-consumer-plan.md) moves drain off the tick entirely:
its own in-process loop, demand-driven, serialized with every other drain
writer through one lock.

```
tick loop  (frequency) ──> primary lane ──> JEV digest   owns heartbeat.lock
side lane  (slow)      ──> staleness only                (same tick)
drain loop (demand)    ──> one bounded pass ──> summarize + writer
                                                owns drain.lock
```

## The two loops

- the **tick loop** is frequency-driven and owns primary judgment;
- the **drain loop** is demand-driven — it starts because work exists
  (`pending >= trigger_pending` OR `oldest age >= trigger_max_age_hours`) and
  stops because the backlog is below the trigger, a ceiling tripped, or a stop
  condition fired.

They do not share a loop lock: a 15-minute drain pass can never burn a tick,
and the primary lane is untouched. They do share `state/mission.lock` per
child unit when `autonomy.heartbeat.in_progress_lock` is on (the default):
the tick takes it after `heartbeat.lock`, the pipe after `drain.lock` (never
the reverse), so a drain summarizer/writer and a mission child never run at
the same time. A live holder ends the pass with `mission-lock-held`.

## One pass

One pass is `runDrainPipe` (lib/drain/pipe.ts), now bounded four ways:

1. **The writer gate is inside the pipe** (§2.4). Every caller — the consumer,
   the `drain_run` tool (dream, manual, mission) — serializes through
   `.opencode/state/drain.lock`. The record is `{ pid, acquired_ms,
   heartbeat_ms }`; an unref'd 60 s timer refreshes `heartbeat_ms`, so a slow
   summarize unit cannot lose its own lock. Stale means heartbeat older than
   3 × refresh (180 s); a steal requires stale **and** a dead holder
   (`process.kill(pid, 0)` fails) — a hung-but-alive holder is never stolen
   from. Acquisition is try-only: **callers never wait**. The tool returns
   `status: "skipped", reason: "lock-held"` (the mission declines via
   roll-mission); the consumer skips the wake and reschedules. Around each
   **child unit** the pipe also takes `state/mission.lock` (only when
   `autonomy.heartbeat.in_progress_lock` is on), releasing it after that unit
   idles or aborts; a held mission.lock stops the pass at the unit boundary.
2. **Every child is stopped, not abandoned.** A summarizer or writer child
   that exceeds its wait is aborted (`session.abort` plus a bounded idle
   confirm) before the pipe returns, so no child outlives its own timeout and
   a half-open unit cannot keep writing while the lock is released. A failed
   abort is logged; it is never reported as a clean stop.
3. **A per-pass token budget** (`token_budget`, default 80 000, 0 =
   unlimited) is checked *between units* — before each summarizer and before
   each writer chunk — never mid-unit. A budget-stopped pass advances only the
   sessions whose items were fully reported; the rest stay above their marks
   for the next wake. `token_budget` is a **ceiling, not a target**.
4. **Cursor v2** (§2.3): discovery is watermark-based (cheap); fetch uses each
   session's own mark. A resumed or late-discovered session is re-read from
   its mark, so no turn can fall below a global high-water mark and be
   skipped. The watermark never advances past a marked session that still has
   unconsumed work above its mark. A batch whose sessions are all consumed
   (no eligible turns above their marks) advances the watermark over them:
   otherwise the oldest `batch_sessions` would occupy the discovery window on
   every pass and newer turns would never be discovered (head-of-line). The
   `pending` counter applies the same per-session marks, so turns already
   consolidated above the watermark are not reported as pending.

### The settle guard

Only a session idle for `settle_seconds` (default 120 s) is consumed. A
streaming assistant message is never read mid-flight; a resumed long session
is simply a session that stopped being recent.

### v1 → v2 migration

A v1 cursor migrates in place on load: `watermark_ts = v1.last_ts`, and every
`summaries[sid]` becomes `sessions[sid].last_ts = min(v1.last_ts, summary.ts)`
carrying the text — exact where evidence exists. Sessions with no v1 entry get
no mark and fall back to the watermark (conservative: historical skips persist).
`migrated_from: 1` records the conversion. `drain.cursor_migration: "recover"`
repairs the two documented gaps (nothing-to-consolidate sessions and pruned
summaries) by starting unknown marks at `session.time_created`, floored at
`watermark - initial_lookback_hours`. Default: `carry`.

## Stop conditions (§2.2, §2.6)

| Stop | Meaning |
|---|---|
| `backlog-below-trigger` | pending < N AND oldest age < T — normal end |
| `token-budget` | the per-pass budget ran out between units — yield |
| `wake-token-budget` | the wake budget (250 k) is spent — yield |
| `wake-wall` | `max_wall_minutes` reached — yield |
| `max-passes` | `max_passes_per_wake` backstop hit (rare — observable budgets decide first) |
| `lock-held` | another writer holds `drain.lock`; passes: 0, reschedule at poll |
| `mission-lock-held` | another agent holds `state/mission.lock`; the pass stops at a child-unit boundary, completed units stay advanced |
| `no-progress` | a pass consumed nothing and wrote nothing — back off poll × 4 |
| `config-changed` | level/enabled/consumer/provider changed mid-wake — re-read |
| `crash` | an exception escaped the loop — release, reset marker, poll × 4 |

The loop condition, in full:

```
(pending >= N || oldest >= T)
  && wake_tokens < wake_token_budget        # 250_000 ≈ 7-8 median passes
  && wake_wall   < max_wall_minutes         # 15
  && passes      < max_passes_per_wake      # 6 — backstop only
```

## Telemetry

- `logs/drain.log`: every pipe line gains `trigger`, `pass`, `pending_before`,
  `pending_after`, `oldest_pending_age_ms`, `budget_remaining`, and `stopped`;
  one `source: "consumer"` line per wake summarises the loop
  (`passes`, `wall_ms`, `wake_tokens`, `pending_before/after`, `stopped`).
  A lock-held wake writes only the consumer line (`passes: 0`).
- `state/drain.current.json`: the live marker — `state`, `trigger`, `pass`,
  `pending`, `oldest_pending_age_ms`, `next_due`. Separate from
  `heartbeat.current.json` so the two loops never race on one file.
- `logs/heartbeat.log`: each tick line carries
  `drain: { pending, oldest_age_ms, last_wake_age_ms }` read from the marker.

## Dashboard

- `GET /api/drain` — the consumer snapshot (marker + last wake/pass), cached 5 s.
- `GET /api/memory/pending` — gains `consumer`, `trigger_pending`,
  `trigger_max_age_hours`, `next_due`, `oldest_pending_age_ms`.
- `GET /api/runs` — drain pipe lines appear as `lane: "drain"`.
- `GET /api/metrics/tokens?lane=drain` — drain spend chartable beside primary/side.
- `GET /api/queues` — side lane is staleness-only; a `drain` pointer carries
  the loop's live state.

The queues page shows a drain consumer card; metrics a drain panel; flight a
drain loop row beside the tick schedule.

## Configuration (`.opencode/sysop-config.yaml`)

```yaml
drain:
  consumer: true             # false = legacy side-lane drain (rollback)
  trigger_pending: 12
  trigger_max_age_hours: 2
  settle_seconds: 120
  poll_seconds: 60
  max_wall_minutes: 15
  token_budget: 80000        # per pass; 0 = unlimited (ceiling, not a target)
  wake_token_budget: 250000  # per wake
  max_passes_per_wake: 6     # backstop only
  lock_refresh_ms: 60000
  lock_stale_ms: 180000      # 3 × lock_refresh_ms (enforced at load)
  cursor_migration: carry    # carry | recover
```

All dials hot-read: a config flip applies without a restart. `consumer: false`
is the rollback path — drain returns to the side lane (the producers
re-collect it, the queued item prunes back in) and the consumer idles.

`mission.lock` is not a drain dial: it lives in the `heartbeat:` section
(`mission_lock_refresh_ms`, `mission_lock_stale_ms`) and is taken only while
`autonomy.heartbeat.in_progress_lock` is true. Its stale threshold is lifted
to at least 3 × the refresh interval at read time, the same rule as
`drain.lock`.

## Rollback

Set `drain.consumer: false`. Within one poll the consumer idles, the
`turns-pending` producer starts collecting drain again, and any queued drain
item becomes runnable. No restart needed; one release of dual support.

## Failure isolation

The consumer body copies `runTick`'s boundary (§2.7): try/catch/finally, an
unref'd timer, `void loop().catch(…)`. An exception releases `drain.lock` and
any held `mission.lock`, resets
`drain.current.json` to idle, logs `stopped: "crash"`, and backs off
poll × 4 — the tick loop in the same process keeps firing on schedule. The
SQLite reads are synchronous, so a wedged query stalls both loops; the
mitigation is bounded per-wake DB work plus `PRAGMA busy_timeout=5000` on the
read-only handle.

## Verify

```sh
node --test .opencode/plugin/lib/*.test.ts \
  .opencode/plugin/lib/drain/*.test.ts \
  .opencode/plugin/lib/lanes/*.test.ts
```

Then check `logs/drain.log` for a `source: "consumer"` wake line and
`state/drain.current.json` for `next_due`.
