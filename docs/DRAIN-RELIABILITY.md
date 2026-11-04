---
title: Drain Reliability — Per-Pass Coordinator, Event-Independent Consolidation
status: proposed
scope: drain pass only (coordinator, heartbeat wiring, writer report policy, config, tests, docs)
applies-to: every agent working in projects/Nibble-agent
---

# Drain Reliability — Per-Pass Coordinator, Event-Independent Consolidation

## Goal

Make the drain pass a single, state-driven execution: one `DrainCoordinator`
per pass that reads persisted session state (no `session.idle`, no plugin event
hooks), routes summarizer/writer/correction children, isolates a stuck or
timed-out child without aborting the pass, and reports accurate live status.
Child results are reported through schema-validated tools — `summary_items`
for the summarizer and `drain_report` for the writer — never through
LLM-formatted prose. The coordinator is created inside `runDrainPipe` and
disposed in `finally`; it is drain-only, not an application-wide service.

**This document is the plan. No code has been changed by writing it.**

## Evidence (2026-11-03)

Writer session `ses_e60841b3cffeLEqBsH3mGrqVOZ`:

- created `03:37:39.267Z`; last assistant message `finish:"stop"` and a valid
  `consolidated #2-#7 / skipped #1` report at `03:39:05.382Z`;
- `opencode.log`: `exiting loop` at `03:39:05.385Z`, then `cancel` at
  `03:41:39.291Z` — exactly `child_stall_ms` (240 s) after creation;
- `drain.log`: `outcome:"error"`, `run_ms:240000`, `span_ms:85294`,
  `late:true`, `error:"writer timed out"`; the cursor did not advance.

The session was finished the whole time. The pass failed because the idle
wait never observed `session.idle`.

A live SSE capture of `http://127.0.0.1:<serve-port>/event` during the next
pass showed `session.idle` for writer `ses_e604d2cbaffe...` immediately after
its final `finish:"stop"` step at `04:38:24.740Z`, while the drain kept
waiting until the 240 s deadline. The same pass's summarizers finished in 12 s
and 35 s and were also marked `late:true` at exactly 240 s. The event exists;
the plugin waiter missed it.

Two heartbeat loops in one process are visible in the data: tick 21 has two
`free-run` children whose `time_created` values are 5 ms apart
(`ses_e60b4a2e0...` at `02:44:38.810Z`, `ses_e60b4a2e5...` at
`02:44:38.815Z`). One completed at `02:49:26Z`; the other stalled 600 s and
failed its abort confirm at `02:54:48Z`. Tick 23 repeats the pattern (a
`lease-lost` line at `03:14:38Z`, then the mission at `03:19:39Z`). Both
ledger lines carry `pid 617768`.

The cited writer used 11 steps and 85 s, so the 20-step cap was not its
failure; the 240 s value is the missed-idle detector. Larger budgets are a
backstop for slow batches, not the root-cause fix.

## Branch and deployment note

The live instance is the `main` worktree at `/home/vuszi/Projects/Agents/Nemu`.
This plan is written for the `feat/sqlite-work-store` worktree at
`projects/Nibble-agent` (the SQLite work store and the DB lease live there; the
live `main` still uses the older file lease). Implement on the feature branch,
merge to `main`, then update the live Nemu checkout and restart it. The live
checks in Step 9 run in the deployed worktree, not in the clone.

## Root cause

1. **Event-only completion.** `step.ts` binds `child_stall_ms` onto
   `waitForIdle`; `heartbeat-hook.ts` turns it into `{confirmMs}`, and
   `waitForChildIdle` resolves successfully only on the `session.idle` event —
   the timer can only fail. Miss the event, lose the pass.
2. **Valid work is discarded.** On a missed idle, `spawn.ts` reads the late
   reply, aborts, and returns `aborted:true`; `brain.ts` maps any `aborted`
   child to `"writer timed out"` and throws the valid report away. The
   summarizer path accepts late replies; the writer path does not.
3. **Two heartbeat loops in one process.** Two plugin instances load the same
   plugin directory; both start the self-rescheduling heartbeat loop and race
   the DB lease. Polling removes the correctness impact of this (there is no
   event to miss), but the duplicate loop is still wasted work; the DB lease is
   the single ownership authority and the existing per-instance `ticking` flag
   is at most a local assertion.
4. **Late reply race.** `spawn.ts` reads the session before sending the abort;
   a report persisted between that read and the abort is still discarded.

## Target architecture

```
heartbeat tick (DB lease = at most one pass at a time)
  └─ runDrainPipe
       ├─ discover / render                 (SQLite; unchanged)
       ├─ createDrainCoordinator            (per pass)
       ├─ coord.run(summarize jobs)          bounded pool
       ├─ plan / dedupe / chunk              (unchanged)
       ├─ coord.run(write jobs)              serial (writer_concurrency = 1)
       ├─ fold results → advance cursor per completed unit
       └─ finally: coord.dispose()           final status + ledger, abort stragglers
```

Rules:

- **One mechanism: persisted state, polled.** After `promptAsync`, poll
  `client.session.messages`. Completion is `info.time.completed` set and
  `finish !== "tool-calls"`; `tool-calls` means the loop is still going.
  `info.error` / `finish:"error"` is a failed reply, not a report.
- **Anchor the reply to the prompt.** The observer receives `promptUserID` —
  the newest user message id read immediately before `promptAsync`. It ignores
  that row, waits for a newer user message, then for the assistant reply whose
  `parentID` equals that user message. This makes a correction prompt on the
  same session wait for the new reply instead of returning the previous
  `finish:"stop"`.
- **Late is a branch, not a second mechanism.** On the deadline the observer
  reads once more and returns the rows. A valid report is accepted with
  `late: true`; an invalid report is `permanent` (poison); no reply is
  `transient`.
- **Per-pass lifecycle.** The coordinator is created inside `runDrainPipe`
  after the provider/source checks and inside the existing `try`; `dispose()`
  runs in the existing `finally`, so disabled/no-provider/source-error paths
  cannot leak it. There is no daemon and no self-rescheduling.
- **One owner.** The DB lease (`lib/lease.ts`) remains the cross-process and
  in-process exclusion; it self-refreshes every 30 s for the life of the tick.
  Do not add a third `globalThis` guard. With polling, a duplicate loop can no
  longer cause the timeout failure.
- **Isolation.** Every child gets its own abort. A stuck or timed-out child
  costs one unit, never the pass. The cursor advances only for units with a
  valid report; failed units stay at their marks and follow the existing
  backoff/poison path.
- **Idempotency before retry.** Never respawn a writer that may already have
  written. Writer retry is `reuse` (same session); a hard stall ends the unit
  and the next pass retries under poison/backoff. Summarizers may `respawn`
  freely because they write nothing.
- **Status is additive.** `drain.current.json` keeps its pass-level meaning;
  the live task table is an additive field with its own timestamp.
- **Reports are tool calls, not prose.** The writer calls `drain_report` and
  the summarizer calls `summary_items`; the coordinator reads the typed tool
  arguments from the transcript and re-validates them against the real batch.
  There is no fenced or `=== ITEM ===` parser and no format-correction prompt.
- **Timeouts are backstops, not scheduling.** Normal children finish in
  seconds; raise the ceiling, do not rely on it.

## Locked decisions

- **Writer concurrency: 1.** Chunks are serial; the coordinator still tracks
  each chunk as an isolated task.
- **Retry:** summarizer `respawn`; writer report-correction `reuse`; writer hard
  stall/timeout ends the unit (next-pass poison) rather than respawning, to
  avoid duplicate vault writes. A writer `respawn` is allowed only when no work
  could have started (create/prompt failure).
- **Reports:** `drain_report` (writer) and `summary_items` (summarizer) are the
  only report contract. Remove the fenced `consolidated`/`skipped` parser and
  the `=== ITEM ===`/`NO_ITEMS` parser in the same change; no fallback path.
- **Status:** extend `drain.current.json`; `updated_at` is written at pass
  boundaries only, so `drainHealth.last_wake_age_ms` stays meaningful. The live
  task table carries `tasks_updated_at`.
- **Stall detection:** use a progress signal only if Step 0 proves one exists;
  otherwise `stall_ms = 0` and the hard `child_stall_ms` deadline is the only
  watchdog.
- **`child_stall_ms`:** keep the key, redefine it in docs as the hard deadline
  for one child; do not add a `deadline_ms` alias.

## Report contract — structured tools, no LLM formatting

The child agents do not format reports. They call one tool and the coordinator
reads the typed arguments from the session transcript. `parseMissionResult`
(`lib/mission-result.ts:40-54`) is the existing precedent for this pattern.

### `summary_items` (session-summarizer)

```ts
summary_items({
  items: Array<{
    title: string
    tags: string[]
    summary: string
    atoms: string[]
  }>
})
```

- `items: []` is the clean "nothing durable" outcome; it replaces `NO_ITEMS`.
- The tool rejects an empty title and returns a short structured error. The
  coordinator still normalizes (unique titles, lowercase tags, cap, hash).
- The coordinator reads the last `summary_items` call from the child rows. A
  missing call gets one correction prompt ("call `summary_items`"); if the
  child still does not call it, the deterministic per-turn fallback runs, as
  today. `parseSummaryReply`, `stripTextEnvelope`, `TEXT_ITEM_MARKER`, and the
  `NO_ITEMS` branch are deleted.

### `drain_report` (drain-writer / rag-brain in consolidation mode)

```ts
drain_report({
  item_count: number                // N from "### Knowledge item #1..N"
  consolidated: (string | number)[] // "#1" or 1
  skipped: (string | number)[]
  partial?: boolean                 // true only when the step cap stopped the batch
})
```

- Labels normalize `#3` → `3`; duplicates across the two arrays are rejected;
  labels `< 1` or `> item_count` are rejected; every `1..N` must appear exactly
  once unless `partial: true`.
- On failure the tool returns
  `{ok:false, duplicate:[…], unknown:[…], missing:[…], valid_labels:["#1",…]}`
  so the model can correct in the same turn. On success it returns
  `{ok:true, consolidated:[…], skipped:[…], partial}`.
- The coordinator reads the **last** `drain_report` call from the child rows
  and re-validates against the real `items.length`; it is the authority. A
  missing call gets one correction prompt; a still-missing or invalid call is
  classified as today (`transient` for no report, `permanent` for a bad one).
- `parseConsolidationReport`, `FENCE_RE`, `LABEL_RE`, and the `fenceCorrection`
  / `requestReportFences` path (`brain.ts:30-41,210-225`) are deleted. No
  fallback.

### Why not infer the report from the vault

A vault diff cannot map note changes back to item labels without polluting
notes with markers, and a marker is still LLM-authored text. A schema-validated
tool call is the smallest structured surface the coordinator can verify.

### Cleanup list for the old formats

- `brain/report.ts`: add `validateDrainReport` / `parseDrainReport`; remove the
  fence parser.
- `drain/summarize.ts`: add `validateSummaryItems` / `parseSummaryItems`;
  remove the `=== ITEM ===` parser and the `NO_ITEMS` branch.
- `brain.ts`: the correction prompt tells the child to call `drain_report`.
- `brain/prompt.ts`: tell the writer to call `drain_report` when finished.
- `summarize.ts` prompt: tell the summarizer to call `summary_items`; remove
  the block and `NO_ITEMS` instructions.
- Agent/reference files switch to the tool contract: `drain-writer.md:166-192`,
  `session-summarizer.md:20-44`, `reference/consolidation.md:52-82`,
  `rag-brain.md:185-187`. `drain-writer.md` gains `drain_report: true` in its
  `tools:` map; `session-summarizer.md` gains `summary_items: true`.
- Docs: `wiki/Drain-Process.md:94-162` and every other fence / `=== ITEM ===`
  description switches to the tool names.

## Implementation plan

Each step is one diff (Step 0 is an investigation). Run the check before moving
on.

### Step 0 — Probe the progress signal (no repo change)

During a live drain pass, sample `client.session.messages` for one summarizer
and one writer every 1 s. Record `rows.length`, newest assistant `id`,
`time.created`, `time.completed`, `finish`, `parts` count and text length, and
the newest tool-part status.

Check: the capture shows at least one field other than `time.completed`
changing between prompt and completion. If none changes, set `stall_ms = 0`
(deadline-only) and continue; do not build a progress detector on a signal that
does not exist.

### Step 1 — Add the observer

Files: `.opencode/plugin/lib/drain/observe.ts` (new),
`.opencode/plugin/lib/drain/observe.test.ts` (new).

```ts
export type Observation = {
  phase: "running" | "complete" | "failed" | "timeout"
  replies: string[]   // newest first, for the prompt's user message
  rows: unknown[]
  progress: { messages: number; newestId: string | null; newestPartAt: number | null }
}

export async function observeSession(
  client: { session: { messages(args: any): Promise<{ data?: any }> } },
  directory: string,
  sessionID: string,
  opts: { promptUserID?: string | null; timeoutMs: number; pollMs?: number; now?: () => number },
): Promise<Observation>
```

Algorithm: pick the newest `role:"user"` row whose `info.id` is not
`promptUserID`; take the newest assistant row whose `parentID` equals it; done
when `info.time.completed` is set and `finish !== "tool-calls"`; otherwise
sleep `pollMs` (default 1000, timers `unref`'d) and repeat; on timeout read
once more and return `phase:"timeout"` with all replies for that user message.

No event subscription; no `session.abort` inside the observer.

Check: `node --test .opencode/plugin/lib/drain/observe.test.ts` passes. Tests
cover: running → complete; a reused session with an old completed `stop` and a
new prompt whose user row appears on the second poll (must not return the old
reply); `tool-calls` keeps polling; timeout returns the latest replies; a
missing `time.completed` stays `running` until the deadline; a fake clock
drives the timeout; a progress delta is reported.

### Step 2 — Add the report tools

Files: `.opencode/plugin/lib/tools/summary-items.ts` (new),
`.opencode/plugin/lib/tools/drain-report.ts` (new),
`.opencode/plugin/lib/memory/providers/builtin/brain/report.ts`,
`.opencode/plugin/lib/drain/summarize.ts`,
`.opencode/plugin/heartbeat-hook.ts`,
`.opencode/plugin/lib/tools/summary-items.test.ts` (new),
`.opencode/plugin/lib/tools/drain-report.test.ts` (new),
`.opencode/plugin/lib/memory/providers/builtin/brain/report.test.ts`.

- Register `summary_items` and `drain_report` in the plugin `tool:` map
  (`heartbeat-hook.ts:1495-1497`), next to `mission_result` and `queue_add`.
- `drain_report`: normalize string/number labels, reject duplicates, unknown,
  and missing labels (see the Report contract section).
- `summary_items`: validate the item shape; an empty array is the no-items
  case; the coordinator still normalizes and caps.
- Replace `parseConsolidationReport` with `parseDrainReport` + validator; add
  `parseSummaryItems` + validator. Delete the fence and `=== ITEM ===` parsers.
- `SpawnResult` gains `rows` so the writer validator can read tool parts.

Check: `node --test .opencode/plugin/lib/tools/summary-items.test.ts
.opencode/plugin/lib/tools/drain-report.test.ts
.opencode/plugin/lib/memory/providers/builtin/brain/report.test.ts` passes:
valid/duplicate/unknown/missing/partial, `#n` and `n` normalization, empty
items, and the last-call-wins transcript rule.

### Step 3 — Add the coordinator

Files: `.opencode/plugin/lib/drain/coordinator.ts` (new),
`.opencode/plugin/lib/drain/coordinator.test.ts` (new).

```ts
export type TaskPolicy = {
  kind: "summarize" | "write" | "correct"
  agent: string
  model: string
  concurrency: number
  deadlineMs: number
  stallMs: number          // 0 = deadline-only
  maxAttempts: number
  retry: "reuse" | "respawn"
}

export function createDrainCoordinator(deps: {
  client: DrainPipeClient
  directory: string
  ledger?: DrainLedger
  status?: (snapshot: CoordinatorSnapshot) => Promise<void>
  config: DrainConfig
}): {
  run(jobs: ChildJob[]): Promise<ChildOutcome[]>
  executor: ChildExecutor
  dispose(): Promise<void>
}
```

The coordinator owns the bounded pool (generalized from `pipe.ts:409-481`),
the token-budget gate (checked before launch, never mid-task), deterministic
result slots, the per-task state machine, isolated aborts, in-pass retry, and
the final status snapshot. `dispose()` settles in-flight tasks, aborts any past
a short grace, clears timers, unregisters its children, writes the final
snapshot, and is idempotent.

Check: `node --test .opencode/plugin/lib/drain/coordinator.test.ts` passes.
Tests cover: create/dispose idempotent; one stalled child does not abort its
siblings; a partial pass advances only completed units; the retry policy
(summarize respawn, writer reuse, writer stall ends the unit); dispose aborts
stragglers and leaves no timers; a budget stop launches no later child.

### Step 4 — Add the executor seam and convert the adapters

Files: `.opencode/plugin/lib/drain/summarize.ts`,
`.opencode/plugin/lib/memory/types.ts`,
`.opencode/plugin/lib/memory/providers/builtin/brain/spawn.ts`,
`.opencode/plugin/lib/memory/providers/builtin/brain.ts`.

Add a drain-only executor to the provider/deps contracts, keeping
`waitForIdle` for non-drain callers:

```ts
export type ChildExecutor = {
  spawn(job: ChildJob): Promise<ChildOutcome>
  prompt(sessionID: string, job: ChildPrompt): Promise<ChildOutcome>
  abort(sessionID: string): Promise<void>
}

// WriteContext / SummarizeDeps
executor?: ChildExecutor
```

- `summarize.ts`: build the summary job; use `parseSummaryItems(rows)` from
  Step 2 instead of `parseSummaryReply`; delete the `=== ITEM ===` correction
  loop. The deterministic fallback remains for a missing tool call.
- `spawn.ts`: build the writer job; use `executor.spawn` for the first prompt
  and `executor.prompt(sessionID, …)` for the report correction. Delete
  `waitWithin`, `abortConfirmMs`, and the late/abort branches.
- `brain.ts`: delete the early `if (spawned.aborted)` short-circuit; use
  `parseDrainReport(spawned.rows)` and return `ok:true` with `late` telemetry
  when the tool report is valid. Call the correction only when the session is
  still usable; remove `fenceCorrection` / `requestReportFences`.

Check: `node --test .opencode/plugin/lib/drain/summarize.test.ts
.opencode/plugin/lib/memory/providers/builtin/brain/spawn.test.ts
.opencode/plugin/lib/memory/providers/builtin/brain.test.ts` passes;
`brain.test.ts` still asserts one create and two prompts for correction.

### Step 5 — Wire the pipe, step, and heartbeat

Files: `.opencode/plugin/lib/drain/pipe.ts`,
`.opencode/plugin/lib/drain/step.ts`, `.opencode/plugin/heartbeat-hook.ts`.

- Create the coordinator inside the existing `try` (`pipe.ts:327`), after the
  source opens, and call `dispose()` in the existing `finally`
  (`pipe.ts:913-918`) so every early return is covered.
- Replace the summarizer pool (`pipe.ts:409-481`) and the serial writer loop
  (`pipe.ts:612-694`) with `coord.run(...)`; fold results in discovery/chunk
  order; preserve `markWritten`, floor marks, and poison behavior.
- Pass `coord.executor` into `WriteContext` and `SummarizeDeps`.
- Remove `childIdleWait` from `step.ts` and the drain `waitForChildIdle`
  wrapper (`heartbeat-hook.ts:567-568`). Keep `waitForChildIdle` for missions.
- `registerChild`/`automationChildSessions`: the coordinator registers each
  child on spawn and removes only its own ids on dispose.

Check: `node --test .opencode/plugin/lib/drain/pipe.test.ts
.opencode/plugin/lib/drain/step.test.ts` passes;
`rg -n "waitForChildIdle" .opencode/plugin/heartbeat-hook.ts` shows only the
mission use; `rg -n "childIdleWait" .opencode/plugin/lib/drain` returns
nothing.

### Step 6 — Status and ledger

Files: `.opencode/plugin/lib/drain/coordinator.ts`,
`.opencode/plugin/lib/drain/ledger.ts`.

- Write `drain.current.json` atomically (`lib/fsx.ts`). Keep the pass-level
  fields the readers use: `state`, `trigger`, `pass`, `pending`,
  `oldest_pending_age_ms`, `next_due`, `updated_at`. Add `pass_id`, `phase`,
  `started_at`, `finished_at`, `outcome`, `counts`, `tasks`, and
  `tasks_updated_at`.
- `updated_at` changes only at pass start/end; `tasks_updated_at` changes on
  every transition.
- Disabled/no-provider paths write `state:"idle"`.
- Add `"coordinator"` to `DrainLedgerSource` (`ledger.ts:19`); emit one row per
  task transition with `task_id`, `attempt`, `stall_ms`, `timed_out`, `late`.

Check: the coordinator tests assert the status shape; a parsed
`drain.current.json` still satisfies `drainHealth`'s
`{pending, oldest_pending_age_ms, updated_at}`; the dashboard reader tolerates
the additive fields (it ignores unknown keys).

### Step 7 — Config, agent budget, docs

Files: `.opencode/plugin/lib/drain/config.ts`,
`.opencode/sysop-config.example.yaml`, `.opencode/agents/drain-writer.md`,
`.opencode/agents/session-summarizer.md`, `reference/consolidation.md`,
`.opencode/agents/rag-brain.md`,
`.opencode/plugin/lib/memory/providers/builtin/brain/prompt.ts`,
`.opencode/plugin/lib/drain/summarize.ts`,
`.opencode/plugin/lib/drain/config.test.ts`,
`.opencode/plugin/lib/drain/writer-contract.test.ts`,
`docs/drain-consumer.md`, `docs/sysop-config-reference.md`,
`wiki/Drain-Process.md`.

- `child_stall_ms`: `240_000` → `600_000` (the hard deadline). Register any new
  keys in `INT_KEYS`/`KNOWN_KEYS`, or the parser silently drops them.
- Add `max_attempts: 2`; add `stall_ms` only if Step 0 proved a progress
  signal. Do not add `writer_concurrency` or `tool_ceiling_ms` in this change.
- `.opencode/agents/drain-writer.md`: `steps: 20` → `steps: 40`; replace the
  fence instructions (`:166-192`) with "call `drain_report`"; add
  `drain_report: true` to its `tools:` map.
- `.opencode/agents/session-summarizer.md`: replace the `=== ITEM ===` /
  `NO_ITEMS` instructions (`:20-44`) with "call `summary_items`"; add
  `summary_items: true` to its tools/permissions.
- `reference/consolidation.md:52-82` and `rag-brain.md:185-187`: switch the
  report contract to `drain_report`.
- `brain/prompt.ts` and the summarizer prompt in `summarize.ts`: instruct the
  child to call the tool; remove the block and fence instructions.
- Update the docs: "bounded idle wait" becomes "hard deadline"; describe
  completion as message-state polling; describe the tool reports; document the
  per-pass coordinator and the serial writer; update the writer step cap and
  the `child_stall_ms` default (`docs/sysop-config-reference.md:143`,
  `wiki/Drain-Process.md:183,220`); rewrite `wiki/Drain-Process.md:94-162` to
  the tool names.
- The live gitignored `.opencode/sysop-config.yaml` is separate: set
  `child_stall_ms: 600000` and keep `max_items_per_batch` consistent with the
  writer step cap (4 with 40 steps, or 8 with 80).

Check: config tests pass; `rg -n "child_stall_ms: 600000"
.opencode/sysop-config.example.yaml` matches; `rg -n "^steps: 40$"
.opencode/agents/drain-writer.md` matches; `writer-contract.test.ts` passes;
`rg -n "=== ITEM ===|consolidated|skipped|NO_ITEMS" .opencode/agents
reference/consolidation.md wiki/Drain-Process.md docs/drain-consumer.md
docs/sysop-config-reference.md` returns nothing (historical evidence in
`docs/DRAIN-RELIABILITY.md` is exempt).

### Step 8 — Migrate tests and remove the old machinery

Files: `.opencode/plugin/lib/drain/pipe.test.ts`,
`.opencode/plugin/lib/drain/summarize.test.ts`,
`.opencode/plugin/lib/memory/providers/builtin/brain/spawn.test.ts`,
`.opencode/plugin/lib/memory/providers/builtin/brain.test.ts`,
`.opencode/plugin/lib/drain/step.test.ts`.

- Replace the `waitForIdle` fakes (`pipe.test.ts:247,427,502,525,944`;
  `summarize.test.ts`; `spawn.test.ts`; `brain.test.ts:58-69,146-191`;
  `step.test.ts:9-38`) with executor fakes.
- Replace the fence and `=== ITEM ===` fixtures with `drain_report` /
  `summary_items` tool parts in the fake rows.
- Rewrite `brain/report.test.ts` around `validateDrainReport`; add
  `summary-items.test.ts` and `drain-report.test.ts` coverage.
- Flip `brain.test.ts:148` from transient to `ok:true` / `late:true` with the
  consumed labels from a valid `drain_report` tool call.
- Flip `pipe.test.ts:517` ("a late writer reply is telemetry only") to
  `outcome:"completed"`, cursor advance, and `writer.late === true`.
- Update `writer-contract.test.ts:87` to `steps: 40`; assert the agent files
  mention `drain_report` and `summary_items`.
- Remove `childIdleWait` and its deps from `step.ts`.

Check: the test files above pass;
`rg -n "waitForIdle|childIdleWait|abortConfirmMs" .opencode/plugin/lib/drain`
shows only the executor seam and any intentionally retained mission-adjacent
code; `rg -n "parseConsolidationReport|parseSummaryReply|NO_ITEMS|=== ITEM ==="
.opencode/plugin/lib .opencode/agents` returns nothing.

### Step 9 — Full suite, deploy, verify live

1. `npm --prefix .opencode ci` only if dependencies are missing, then
   `node --test '.opencode/plugin/lib/**/*.test.ts'` — all tests pass.
2. Merge the feature branch to `main`, push, update the live Nemu checkout with
   `git -C /home/vuszi/Projects/Agents/Nemu pull --ff-only`, and restart
   `scripts/run.sh` there. A restart is required: plugin code and agent
   frontmatter are not hot-reloaded.
3. Confirm one server process for the project: `pgrep -x opencode`; for each pid
   check `readlink /proc/<pid>/cwd`. Exactly one `opencode` pid must sit in the
   project directory (the MCP child is `node`, not `opencode`).
4. Apply the live config values from Step 7, then confirm with `rg`.
5. If `.opencode/state/drain-cursor.json` still has a `blocked` backoff or
   session failures from the incident, wait out the backoff
   (`poll_seconds * 4`) or back up the file and clear only those keys.
6. Force a pass: temporarily set `drain.trigger_pending: 1` (hot-read) or queue
   one user task.
7. Watch until the pass finishes:
   - `.opencode/logs/drain.log`: the writer row is `outcome:"ok"` and `run_ms`
     is close to `span_ms`; a `late:true` row is acceptable if the report is
     valid, but it must not be an error.
   - `.opencode/state/drain-cursor.json`: `watermark_ts` increases.
   - `.opencode/state/drain.current.json`: `tasks` shows terminal states, then
     the final snapshot is idle.
   - `~/.local/share/opencode/log/opencode.log`: no `cancel` for the writer
     after its `exiting loop` line (search by the writer session id).
   - `.opencode/logs/heartbeat.log`: one line pair per tick number, one
     timestamp.
8. Restore `drain.trigger_pending` to 12.
9. Run a second pass and confirm it reports `outcome:"nothing"` (or only new
   turns), proving the cursor is stable.

Check: all tests pass; the live pass advances the cursor and the writer row is
`ok`; the second pass finds nothing new.

## Rollout and rollback

- Restart is required: plugin code and agent frontmatter are not hot-reloaded
  (the heartbeat's stale-code guard disables itself if code changes under a
  running process). Drain config is hot-read after the restart.
- Rollback: revert the merge and restart. The cursor advances only on a
  complete report, so a rollback is safe; re-run the pass to consume any
  partial batch.

## Non-goals

- Do not change the mission `waitForChildIdle` / `session.idle` path; missions
  keep their watchdog.
- Do not build an application-wide coordinator. The coordinator exists only
  for the duration of one `runDrainPipe` call.
- Do not parallelize writer chunks; the vault write path is serial.
- Do not add a new daemon or a third ownership guard; the DB lease is the
  authority.
- Do not change the vault note format, dashboard rendering, or token budgets.
- Do not make `settle_seconds` a completion mechanism; it remains the
  discovery guard for past sessions.
- Do not reintroduce a free-text report format. `drain_report` and
  `summary_items` are the contract; the coordinator validates their arguments.

## Test migration table

| Test | Change |
| --- | --- |
| `pipe.test.ts:247,427,502,525,944` | `waitForIdle` fake → executor fake; fence fixtures → `drain_report` tool parts |
| `pipe.test.ts:517` | late writer reply: error → completed + cursor advance + `late:true` |
| `summarize.test.ts` | wait/abort fakes → executor; `=== ITEM ===` fixtures → `summary_items` tool parts |
| `spawn.test.ts` | wait/abort fakes → executor; correction uses `prompt` |
| `brain.test.ts:148` | aborted child with valid report → `ok:true` + `late:true` from a tool call |
| `brain/report.test.ts` | rewrite around `validateDrainReport`; fence parser deleted |
| `tools/drain-report.test.ts` (new) | labels, duplicates, unknown, missing, `partial`, normalization |
| `tools/summary-items.test.ts` (new) | item shape, empty items, invalid title |
| `step.test.ts:9-38` | `childIdleWait` removed → coordinator wiring |
| `writer-contract.test.ts:87` | `steps: 40`; assert `drain_report` / `summary_items` in the agent files |
| `config.test.ts` | new keys accepted and clamped |

## File map

| Area | File |
| --- | --- |
| Observer | `.opencode/plugin/lib/drain/observe.ts` (new) |
| Observer tests | `.opencode/plugin/lib/drain/observe.test.ts` (new) |
| Coordinator | `.opencode/plugin/lib/drain/coordinator.ts` (new) |
| Coordinator tests | `.opencode/plugin/lib/drain/coordinator.test.ts` (new) |
| Drain wiring | `.opencode/plugin/lib/drain/pipe.ts`, `step.ts`, `heartbeat-hook.ts` |
| Summarizer | `.opencode/plugin/lib/drain/summarize.ts` |
| Summary tool | `.opencode/plugin/lib/tools/summary-items.ts` (new) |
| Summary tool tests | `.opencode/plugin/lib/tools/summary-items.test.ts` (new) |
| Writer report tool | `.opencode/plugin/lib/tools/drain-report.ts` (new) |
| Writer report tool tests | `.opencode/plugin/lib/tools/drain-report.test.ts` (new) |
| Report parsers | `.opencode/plugin/lib/memory/providers/builtin/brain/report.ts` |
| Wait/executor types | `.opencode/plugin/lib/memory/types.ts` |
| Writer spawn | `.opencode/plugin/lib/memory/providers/builtin/brain/spawn.ts` |
| Writer report | `.opencode/plugin/lib/memory/providers/builtin/brain.ts` |
| Agent contracts | `.opencode/agents/drain-writer.md`, `session-summarizer.md`, `rag-brain.md`, `reference/consolidation.md` |
| Ledger | `.opencode/plugin/lib/drain/ledger.ts` |
| Lease | `.opencode/plugin/lib/lease.ts`, `.opencode/plugin/lib/work-store.ts` |
| Config | `.opencode/plugin/lib/drain/config.ts`, `.opencode/sysop-config.example.yaml`, live `.opencode/sysop-config.yaml` |
| Agent budget | `.opencode/agents/drain-writer.md` |
| Tests to update | `pipe.test.ts`, `summarize.test.ts`, `spawn.test.ts`, `brain.test.ts`, `step.test.ts`, `config.test.ts`, `writer-contract.test.ts` |
| Docs | `docs/drain-consumer.md`, `docs/sysop-config-reference.md`, `wiki/Drain-Process.md` |
