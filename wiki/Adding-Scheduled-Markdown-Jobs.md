# Adding scheduled markdown jobs

A scheduled markdown job is a file in `.opencode/schedule/`. The frontmatter
holds the schedule; the body is the prompt. When the job is due, chron turns it
into a normal user task and the heartbeat consumer runs it.

This is the smallest way to put a recurring prompt on the clock. It is not a
mission: there is no candidacy gate, no menu window, and no `mission_result`.
Use a mission when you need those. Use a scheduled job when you want a plain
prompt to run on a schedule.

## The file

Create the directory if it does not exist:

```bash
mkdir -p .opencode/schedule
```

Add a file such as `.opencode/schedule/morning-brief.md`:

```markdown
---
title: Morning brief
schedule: daily 09:00
---

Summarize the overnight logs and list anything that needs attention.
```

The job id is the filename without `.md`, so this file is `morning-brief`.
Chron reads every `*.md` file in the schedule directory. The read is not
recursive, so subdirectories are ignored.

## Frontmatter

| Key | Required | Meaning |
| --- | --- | --- |
| `schedule` | yes | When to fire. See the grammar below. |
| `id` | no | Overrides the filename-derived id. Must match `^[A-Za-z0-9][A-Za-z0-9_.:-]*$`. |
| `title` | no | Task title. Defaults to the first non-empty body line, capped at 160 characters. |
| `enabled` | no | Defaults to `true`. `false` keeps the file on disk but stops firing. |
| `agent` | no | Child agent override. Without it, the user-task mission's agent is used. |

The body must be non-empty. A job with a missing or invalid `schedule`, an
invalid id, or an empty body is rejected and never fires. Rejections and parse
errors are written to `chron.log` once per issue.

## Schedule grammar

| Form | Example | Notes |
| --- | --- | --- |
| Interval | `every 1h`, `30m` | Units are `s`, `m`, `h`, `d`. The bare form is shorthand for `every`. |
| Cron | `0 9 * * 1-5` | Five fields. Parsed by `croner`, including DST handling. |
| Cron macro | `@daily`, `@hourly` | `croner` macros are accepted. |
| Daily shorthand | `daily 09:00` | Local time. |
| Weekly shorthand | `weekly mon 09:00` | Weekday names or `0`–`6` (`0` is Sunday). |
| One-shot | `at 2026-11-02T09:00:00-06:00` | Fires once at that instant. |
| Manual | `manual` | Never fires on its own. Use `chron.emit(id)` to push it. |

A schedule is parsed when the file is read. An invalid schedule is reported and
the job is skipped; it does not fall back to a default.

## What happens when it fires

1. Chron wakes on its timer. The default sleep cap is 60 seconds
   (`chron.max_sleep_seconds`), and the next scheduled job can wake it sooner.
2. It reads the job files again, so adding, editing, or removing a file does
   not need an opencode restart.
3. A new job is seeded at the current time and waits for its next occurrence.
   It does not fire the moment you create it. For a one-shot test, set `at` a
   minute or two ahead; the first read seeds the job and the next due time is
   the `at` instant.
4. A due job is handed to the prompt bridge. The bridge writes a user task
   with:
   - title `[chron] <title>`
   - priority `chron.default_priority` (default `5`)
   - TTL `chron.prompt_ttl_hours` (default `24` hours)
   - dedupe key `chron:<id>`, so only one open task exists per job id
   - `requested_by: chron`, the prompt body, a context block with the source
     path and occurrence, and the optional `agent`
5. The task waits in the user-task store. The heartbeat consumer ingests it and
   runs it under the normal autonomy gate. The consumer's next wake decides when
   it actually runs, so the scheduled second is a lower bound, not a guarantee.

The bridge is gated by autonomy level and by the `user-task` mission gate. A
gated occurrence is consumed silently. If the pending-task store is full, the
occurrence is deferred and retried on the next wake, up to
`chron.defer_ttl_hours` (default `24` hours).

## Check it

- Fires, warnings, defers: `.opencode/logs/chron.log`.
- Schedule state: `.opencode/state/chron.json` — look for `last_fired_ms` and
  `next_due_ms`.
- Pending task: `.opencode/state/user-tasks/` (also visible through the
  `queue_add` task rail). Settled tasks move to `done/`, `blocked/`, or
  `failed/`.

To pause a job without deleting it, set `enabled: false`. To resume it, set
`enabled: true`. Both are read on the next tick. `chron.enabled: false` pauses
the whole scheduler; if chron was disabled when opencode started, re-enabling
it needs a restart.

To push a manual job immediately, call `chron.emit("<id>")` from a plugin or a
code job. `emit` uses the job's source, so a file job still goes through the
bridge and becomes a task. See
[Chron fire listeners](Chron-Fire-Listeners.md) for the call site.

## Scheduled job or mission?

| Need | Use |
| --- | --- |
| A plain prompt on a clock | A scheduled markdown job in `.opencode/schedule/`. |
| Candidacy gates, menus, level limits, `mission_result` | A mission in `.opencode/missions/`. |
| Deterministic code on a clock | A chron code job registered from a plugin. |

## Source

- [`chron/store.ts`](../.opencode/plugin/lib/chron/store.ts) — frontmatter
  parsing and job-file reads.
- [`chron/schedule.ts`](../.opencode/plugin/lib/chron/schedule.ts) — grammar
  and occurrence math.
- [`chron-bridge.ts`](../.opencode/plugin/lib/chron-bridge.ts) — job to task.
- [`chron/config.ts`](../.opencode/plugin/lib/chron/config.ts) — defaults.
- [`docs/CHRON-SCHEDULER-PLAN.md`](../docs/CHRON-SCHEDULER-PLAN.md) — design
  and configuration reference.
