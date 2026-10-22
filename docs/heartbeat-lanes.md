# Heartbeat Lane Queues

How a heartbeat tick picks work, and how to add new work sources.

Before this change, every tick dispatched **exactly one** mission. `drain`
(unconsumed turns) and `staleness` (old reference notes) qualified nearly
every tick, so they owned the scheduler and everything else waited. The lane
queues turn a tick from a "do one thing" event into a **drain event**:
producers enqueue work, the dispatcher runs at most one item per lane, and a
tick with nothing queued does nothing at all.

Missed ticks still coalesce (`computeWakeDelayMs` — "coalesce, never
replay"). Work piles up in the queues; ticks never pile up.

> **Drain left the queues** (docs/drain-consumer-plan.md): since
> `drain.consumer: true` (the default), consolidation runs on its own
> demand-driven loop — the `turns-pending` producer stops collecting, the
> side lane carries **staleness only**, and drain work appears in the
> dashboard as `lane: "drain"` runs from `drain.log`. Setting
> `drain.consumer: false` restores the pre-consumer behaviour described below
> (the rollback path, one release of dual support). See
> [docs/drain-consumer.md](drain-consumer.md).

## The model

```
producers ──enqueue──> .opencode/state/lanes.json ──dequeue──> children
  tick                  primary lane: 1/tick, JEV picks           │
  turns-pending         side lane:    1/tick, FIFO                │
  brain-stale           (both empty → silent tick, zero LLM)      │
  (future: telegram, …)
```

A **work item** is a small JSON record — not a mission:

```json
{
  "id": "mission:drain",
  "kind": "mission",
  "lane": "side",
  "producer": "turns-pending",
  "enqueued_ms": 1792537515864,
  "expires_ms": null,
  "requeue_count": 0
}
```

- `id` is the dedupe key. Re-collecting an already-queued item keeps its
  **original** `enqueued_ms` (FIFO fairness depends on it).
- `kind` is how the item executes. Only `"mission"` is dispatched today;
  future sources (telegram replies, email triage) add their own kinds and
  runners without touching the queue.

## The two lanes

| | primary | side |
| --- | --- | --- |
| Producer | `tick` — every eligible primary mission the digest computed | `turns-pending` (drain, legacy only), `brain-stale` (staleness) |
| Selection | JEV digest picks one (`no_reply` is allowed) | none — strict FIFO among runnable items |
| Per tick | one | **one** (the rest wait for the next tick) |
| Expiry | 24 h from enqueue (`PRIMARY_TTL_MS`), then drop | never — waits indefinitely |
| Trigger semantics | judgment / cadence | status: unconsumed turns (legacy), oldest reference note age |

Mission files declare their lane in the frontmatter (default `primary`):

```yaml
lane: side
```

`drain` and `staleness` ship as `lane: side`. Side missions never appear in
the JEV digest — the model cannot see or pick them.

### Ordering and windows

The side lane dequeues the first **runnable** item in enqueue order. A
day-only mission that is queued while the quiet window is open is not
runnable — it stays queued and the next runnable item may pass it. The day
window makes it runnable again. "Strict FIFO" therefore means FIFO among the
items that can actually run right now.

An item is *runnable* when its mission is enabled, the menu window and
autonomy level allow it, and its status predicate still holds. It is *still
due* (i.e. not pruned) as long as its status predicate holds — pruning drops
work that vanished (turns consumed elsewhere, note refreshed), not work that
merely waits for its window.

## The tick, step by step

1. Wake (due math, cross-instance lock — unchanged).
2. Pre-gates (dreaming, all-quiet at ≤ L2 — unchanged).
3. **Producers run.** Deterministic, zero LLM calls. Items merge into
   `state/lanes.json`; stale/undue items prune out.
4. **Both queues empty → silent tick** (`gate: "queues"`, `reason: "empty"`).
   This is also where "not every tick produces an action" lives: the JEV is
   never called on an empty queue.
5. **Side lane**: at most one item dequeues; its child runs to completion.
   The lanes never race on vault writes — the side child always finishes
   before the primary child starts.
6. **Primary lane**: JEV digest over the queued primary items. `no_reply`
   keeps the items (expiry owns their end). Zero primary candidates skips the
   JEV call entirely (`reason: "no-candidates"`).
7. Items settle, queues persist, one NDJSON ledger line records everything.

## Failure policy

| Run outcome | Item fate |
| --- | --- |
| `completed` | dropped (done) |
| `declined` | dropped — "nothing to do". Side declines **never** reroll (`on_decline` is ignored on the side lane). |
| `error` | dropped — the producers re-collect next tick if the work is still due |
| `timeout` | **re-enqueued at the queue tail** with `requeue_reason: "timeout"` and `requeue_count + 1` (fresh `enqueued_ms` = tail; the original wait survives in `payload.original_enqueued_ms`). Past `MAX_REQUEUES` (3) the item drops. |

## Backoff interaction

The B7 identical-digest backoff still stretches the cadence when the JEV
repeatedly says `no_reply` to the same primary candidates (their expiry
re-offers them fresh). It is **bypassed** — the streak resets — whenever side
work ran or side work is still waiting, so status-fed maintenance is never
delayed by a backoff meant for silence.

## Ledger

One NDJSON line per tick (`logs/heartbeat.log`), as before, plus:

| Field | Meaning |
| --- | --- |
| `side_mission`, `side_outcome`, `side_token_cost`, `side_session`, `side_result_status`, `side_requeued` | the side run, when one happened |
| `runs[]` | every dispatched run: `{ mission, lane, outcome, token_cost, over_budget, session, result_status, result_missing, requeued, tool_*? }` |
| `queues` | `{ primary, side }` depth after settlement |

Legacy top-level fields describe the **primary** run (`mission`, `session`,
`result_status`, …); `token_cost` is the tick total (both lanes). The
top-level `tool_*` fields describe whichever run carried the drain tool
(that is the side run today). A tick where only the side lane worked reports
`verdict: "no_reply"` (the JEV said so) with `side_mission` set and
`outcome` from the side run — it is never booked as `silent`.

`heartbeat.current.json` gained `side_mission` / `side_mission_title` /
`side_session` so a running side child is observable beside the primary.

## Hooking a new producer

A producer is one small module plus one registry line. The queue and the
dispatcher do not change.

**1. Implement the producer** (`.opencode/plugin/lib/lanes/producers.ts`, or a
new file beside it):

```ts
export const telegramProducer: Producer = {
  id: "telegram",
  lane: "side",                       // or "primary"
  collect(ctx) {
    // Deterministic and cheap: read your source, return items or [].
    // Never throw — collectItems() is fail-open per producer.
    return pendingTelegramMessages().map((msg) => ({
      id: `telegram:${msg.chatId}:${msg.msgId}`,   // stable dedupe key
      kind: "mission",                // only kind dispatched today
      lane: "side",
      producer: "telegram",
      enqueued_ms: ctx.nowMs,
      requeue_count: 0,
      payload: { chatId: msg.chatId, text: msg.text },  // for the runner
    }))
  },
}
```

**2. Register it** in `PRODUCERS` in the same file. Done — it feeds the
queue on the next tick.

Contract notes:

- `collect` runs at every tick start. If your source is event-driven
  (webhook), have the event handler enqueue directly (`enqueueItems` +
  `saveQueues` on `state/lanes.json`) and optionally wake the heartbeat; the
  queue is writer-agnostic. A purely polled producer is simpler — the tick is
  already the poll clock.
- Pick a stable `id`. Dedupe is by id: re-collecting while queued is a no-op.
- `kind: "mission"` items must have `id: "mission:<mission-id>"` and a
  matching mission file — the dispatcher assembles that mission's brief. For
  a non-mission kind, you also add a runner (today's dispatcher skips unknown
  kinds).
- Side items must be **status-predicate** work. Side missions are collected
  by the shipped status producers via their `candidacy`
  (`turns-pending`, `brain-stale[:hours]`); a side mission with any other
  candidacy is collected by no producer and never runs.
- The primary lane is JEV territory: a primary producer item competes for
  judgment. Status work belongs on the side lane.
- Respect the failure policy: your items inherit timeout-requeue and the
  `MAX_REQUEUES` cap for free.

## Files

| File | Role |
| --- | --- |
| `.opencode/plugin/lib/lanes/queue.ts` | item/queue types, dedupe-enqueue, FIFO dequeue, timeout requeue, prune, `state/lanes.json` persistence |
| `.opencode/plugin/lib/lanes/producers.ts` | producer interface, the shipped producers, the registry, runnability/due checks |
| `.opencode/plugin/heartbeat-hook.ts` | the tick: producers → side dequeue → JEV → settle → ledger |
| `.opencode/plugin/lib/missions.ts` | `lane: primary \| side` frontmatter key |
| `.opencode/plugin/lib/heartbeat.ts` | side filter in `buildCandidates`, `HEARTBEAT_CODE_FILES` guard |
| `.opencode/missions/drain.md`, `staleness.md` | shipped `lane: side` missions |

Both lanes files are in the stale-code guard (`HEARTBEAT_CODE_FILES`): editing
them disables the scheduler of any process started before the edit — restart
opencode. Mission files stay hot-read.

## Verify

```sh
node --test .opencode/plugin/lib/*.test.ts \
  .opencode/plugin/lib/drain/*.test.ts \
  .opencode/plugin/lib/lanes/*.test.ts
```

Then check one live tick in `logs/heartbeat.log`: a drain+primary tick shows
`side_mission: "drain"` with `runs` containing one `side` and one `primary`
entry, and `state/lanes.json` shows what is still waiting.
