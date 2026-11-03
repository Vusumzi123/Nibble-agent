# The drain process

Drain turns finished conversation turns into durable notes in the Brain vault.
It is a consolidation pipeline, not a retrieval agent: it never answers the
user, and the main agent never writes the vault itself. One pass discovers
settled session deltas, summarizes them into knowledge items, and hands those
items to a writer child that creates or updates notes.

The pipeline is deterministic where it can be. Discovery, rendering, dedupe,
chunking, and cursor accounting are local code; only summarization and note
writing call a model. Every model child reports back through a fixed contract,
so a bad or truncated reply becomes a typed outcome, never a silent cursor
jump.

```
chron drain producer (every 1 min, cooldown 15 min)
  -> drain-pass intent
  -> SWRR work queue
  -> heartbeat tick
  -> runDrainStep (re-checks enabled, backoff, trigger, provider)
  -> runDrainPipe
       load cursor
       discover sessions above the watermark
       fetch each session from its own mark
       render the delta
       summarize (bounded concurrent children)
       dedupe by content hash
       write in serial chunks (fenced report)
       advance marks only for fully-reported sessions
```

## When a pass runs

`chron` owns production. A one-minute scan calls `drainDue()` and writes at
most one `drain-pass` intent per `drain.producer_interval_minutes` (default
15). It refuses to emit when the kind is already queued, an intent is pending,
the backlog is below the trigger, or the drain is disabled.

The due check is cheap and model-free:

- `pending >= drain.trigger_pending` (default 12), or
- the oldest pending turn is at least `drain.trigger_max_age_hours` old
  (default 2), and
- the cursor is not in a failure backoff.

`drain-pass` is an ordinary SWRR work kind (weight 3, below missions). The
heartbeat runs at most one pass per tick. `runDrainStep` re-reads the config
and re-checks the preconditions, so a config flip or a filled queue applies
without a restart. There is no consumer loop and no drain lock.

## One pass, stage by stage

### 1. Cursor

The cursor lives in `.opencode/state/drain-cursor.json`
(`drain.cursor_file`). Version 2 holds:

- `watermark_ts` — the discovery bound;
- `sessions[sid]` — each session's own mark plus its last continuity summary;
- `blocked` — batch backoff (`attempts`, `blocked_until`);
- `failures[sid]` — per-session poison counters;
- `written` — content hashes already consolidated by earlier passes.

A fresh cursor is seeded to `now - initial_lookback_hours` (default 24) so it
does not replay all history. `0` starts from the beginning of history.
`cursor_migration: recover` repairs unknown marks from `session.time_created`;
the default `carry` stays conservative.

### 2. Discovery and fetch

Discovery asks the local opencode database for top-level sessions with activity
above the watermark, oldest first, capped by `batch_sessions` (default 5).
Mission children and the pipe's own children are excluded:
`drain.exclude_missions` defaults to `[drain, staleness, dream]`, and the
`drain-summarize` / `knowledge-consolidate` titles are always skipped.

A discovered session must pass the settle guard: only a session idle for
`settle_seconds` (default 120) is consumed, so a streaming assistant message is
never read mid-flight. Settle-guarded sessions floor the watermark and are
retried on a later pass.

Fetch uses the session's own mark, not the watermark. That is what makes a
resumed or late-discovered session safe: it is re-read from where it stopped,
and no turn can fall below a global high-water mark.

### 3. Render

The renderer turns the fetched turns into one delta: role-labelled text,
bounded by `max_turns_per_session` (default 40) and `max_session_bytes`
(default 24 000, `0` = unlimited). It also extracts deterministic atoms —
commands, paths, URLs, `KEY=value`, flags — and carries the previous
continuity summary as context.

### 4. Summarize

Each rendered session goes to the tool-free `session-summarizer` agent
(`drain.summarize_model`, empty = the agent default). The prompt asks for
plain-text blocks:

```
=== ITEM ===
TITLE: ...
TAGS: ...
SUMMARY: ...
ATOMS:
- ...
```

The reply is parsed and normalized: unique titles, lowercase tags,
`max_items_per_session` (default 6), stable content hashes, and every
deterministic atom preserved. A malformed reply gets one correction attempt,
then the deterministic per-turn fallback.

Summarizers fan out. `summarize_concurrency` (default 2, clamped to
`1..batch_sessions`) bounds the pool; launches and the result fold stay in
discovery order, so the first degraded/error and the last reply size are
deterministic. The token budget is checked before each launch, never mid-unit.
A budget hit stops new launches and lets in-flight children finish and report.

### 5. Dedupe

Two dedupe layers run before the writer:

- a hash already in `cursor.written` is a replay and counts as reported;
- a duplicate hash inside the same pass is consolidated once.

Both still count toward session advancement, so a retried pass cannot create
the same note twice.

### 6. Write

The fresh items are split into chunks of `max_items_per_batch` (default 4) and
handed serially to the active memory provider's writer. The Brain provider
prefetches candidate notes deterministically, builds a consolidation prompt
labelled `#1..N` per chunk, and spawns the `drain-writer` agent
(`drain.writer_agent`; `rag-brain` remains the interactive writer). The writer
creates or updates byte-preserving vault notes and reports its outcome with two
fences:

````
```consolidated
#1
#3
```
```skipped
#2
```
````

Every item must appear exactly once across the two blocks. The pipe maps the
chunk-local labels back to run-wide labels and advances only the sessions whose
items were all reported.

A completed reply with no fence at all gets one correction turn in the same
child session. Missing, duplicate, or unknown labels are a permanent failure;
a child that timed out and was aborted is a transient failure, and its partial
text is never parsed as a report.

### 7. Advance

Per-session marks advance to the session's newest rendered turn only when
every item in that session was consumed or skipped. Sessions with a partial
report stay at their mark and floor the watermark, so the next pass re-reads
them from the same place. The watermark advances to the minimum of the
consumed bound and all floors.

Failure accounting is layered:

- **transient** (spawn error, timeout, aborted child) — back off for
  `poll_seconds × 4`; nothing is poisoned;
- **permanent** (invalid report, provider error) — count against the affected
  sessions; after `poison_attempts` (default 3) only those sessions are dropped
  and advanced, never the whole batch;
- **budget stop** — unlaunched sessions stay unsummarized and floored; the
  pass reports `degraded` with `stopped: token-budget`.

## Budgets, concurrency, and timeouts

| Control | Default | Effect |
| --- | --- | --- |
| `token_budget` | 80 000 (`0` = unlimited) | Per-pass ceiling, checked between units — never mid-unit. A ceiling, not a target. |
| `summarize_concurrency` | 2 | Concurrent summarizer children, clamped to `1..batch_sessions`. Writer chunks stay serial. |
| `child_stall_ms` | 240 000 | Bounded idle wait for one child, summarizer or writer. A child that outlives it is read once for a late reply, then aborted. |
| `settle_seconds` | 120 | A session idle for less than this is not consumed. |
| `poll_seconds` | 60 | Base for the failure backoff (`× 4`). |

The 240 s child budget replaces the 600 s mission stall for drain children.
Baseline writer spans are 83–118 s, so a healthy writer is never truncated,
while a stuck child can no longer hold a pass for ten minutes.

## Outcomes and stops

A pass resolves with `outcome`:

| Outcome | Meaning |
| --- | --- |
| `completed` | Every planned item was reported and the cursor advanced. |
| `nothing` | Nothing to do (disabled, below trigger, no writer, or every session already consumed). |
| `degraded` | The pass ran but a stage fell back (schema/SDK lane, summarizer fallback, or budget exhaustion). |
| `error` | A writer or provider failure left work unadvanced. |
| `dropped` | Poison threshold reached; the affected sessions were dropped and advanced. |

`stopped: token-budget` marks an early stop between units. It is not an error.

## Configuration

The full key list and validation rules live in
[`docs/sysop-config-reference.md`](../docs/sysop-config-reference.md). The keys
you are most likely to touch:

```yaml
drain:
  enabled: true
  writer_agent: drain-writer       # drain-only; rag-brain stays interactive
  writer_model: ""                 # "" = the agent default
  summarize_model: ""
  batch_sessions: 5
  summarize_concurrency: 2
  max_items_per_batch: 4
  child_stall_ms: 240000
  token_budget: 80000
  trigger_pending: 12
  trigger_max_age_hours: 2
  settle_seconds: 120
  producer_interval_minutes: 15
```

Drain keys are hot-read. Agent files are not: changing or adding
`drain-writer.md` requires an opencode restart, because agent definitions and
their permission scopes are loaded at init.

The memory provider must expose a writer. `memory.provider: rag-brain` (or
`both`) enables drain; `none` and `memory-explorer` make the pipe a no-op with
`memory provider has no writer`.

## Observing a pass

Every pass writes NDJSON to `.opencode/logs/drain.log`, grouped by `pass_id`:

- `source: "pipe"` — outcome, sessions/items, cursor before/after, tokens,
  `phase_ms` (`discover`, `fetch`, `render`, `summarize`, `write`, `save`,
  `count`), overhead, stop reason;
- `source: "summarizer"` — one row per session: item, child session, prompt and
  reply bytes, `spawn_ms`/`queue_ms`/`run_ms`, `steps`, `span_ms`, `model_ms`,
  `tool_ms`, tokens, error, and `late: true` when the reply came after the
  deadline;
- `source: "writer"` — one row per chunk: agent, model, items, prompt bytes,
  wall/steps/span, tokens, error, `late`, and the child session.

Roll them up with:

```bash
node scripts/drain-report.ts .opencode/logs/drain.log
```

The report groups rows by `pass_id` and prints per-pass spans, writer share,
and per-agent latency/token percentiles. Rows without a `pass_id` are ignored,
so a pre-instrumentation pass is invisible — check the raw log for those.

Healthy signals after the parallel fan-out:

- `phase_ms.summarize` is close to the slowest child, not the sum of children;
- no row has `wall_ms >= 600000` or `wall_ms > 2 × span_ms`;
- writer `steps` stays under its 20-step cap;
- `late: true` appears only on a genuinely capped child, and a late writer row
  is followed by a retry, not a cursor jump.

## Related

- [How mission producers work](Mission-Producers.md) — why drain is a dedicated
  `drain-pass` producer rather than a mission producer.
- [Registering user tasks](Registering-User-Tasks.md) — the queue rail drain
  shares with other work.
- [`docs/DRAIN-PRODUCER-PLAN.md`](../docs/DRAIN-PRODUCER-PLAN.md) — producer
  gates and intent shape.
- [`docs/DRAIN-THROUGHPUT-PLAN.md`](../docs/DRAIN-THROUGHPUT-PLAN.md) — the
  parallel fan-out, bounded waits, and writer-lean work.
- [`docs/sysop-config-reference.md`](../docs/sysop-config-reference.md) — every
  `drain:` key and its default.
