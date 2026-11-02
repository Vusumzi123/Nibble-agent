# Registering user tasks

A user task is work you want the heartbeat to run later. Registering one means
writing one task file. This page is about queueing a task, not adding a new work
kind: the `user-task` kind and its consumer mission already exist. You do not add
a new mission for each task.

Use the `queue_add` tool from a session that has it. The tool writes a pending
task file; the heartbeat ingests it on the next tick (at most 60 seconds).

## Queue one task

```json
{
  "title": "Fix the dashboard queue sort",
  "prompt": "Sort the QUEUE page by priority descending, then created time ascending. Stop when the table and its tests match.",
  "context": "The page is Dashboard/src/app/queue. The current sort is in the table component.",
  "priority": 6,
  "dedupe_key": "dashboard-queue-sort",
  "expires_in_hours": 24
}
```

Call it as `queue_add` with those arguments. A successful call returns JSON
with `ok: true`, the new task `id`, its `path`, and `priority`. A dedupe hit
returns the existing task's id and `deduped: true` instead of writing a second
file.

## What the fields mean

| Field | Required | Meaning |
| --- | --- | --- |
| `title` | yes | Short imperative title, at most 160 characters. |
| `prompt` | yes | Complete instructions: objective, stopping condition, and what to do with each tool result. At most 16 KB. |
| `context` | no | Only the evidence the task needs: paths, values, decisions already made. At most 16 KB. |
| `priority` | no | `0`–`9`, default `5`. Higher runs first **inside the `user-task` kind**. It does not preempt a mission. |
| `dedupe_key` | no | If a pending task already has this key, reuse it instead of creating another. |
| `expires_in_hours` | no | Drop the task after this many hours. An expired task is never produced, and its queue item is pruned. |

`queue_add` does not accept an `agent` override. The task runs on the
`user-task` mission's agent. To pin a different agent, use a chron prompt job
with `agent:` in its file, or hand-write a task file with `agent:` (hand-writing
skips the tool's validation).

## What happens next

```
queue_add
  -> .opencode/state/user-tasks/<id>.md   (pending)
  -> next heartbeat tick: user-task producer reads pending files
  -> work item user-task:<id>
  -> SWRR picks the kind; priority orders inside it
  -> .opencode/missions/user-task.md wraps the task in the brief
  -> child session runs the task
  -> done/ | blocked/ (declined) | failed/ (error or exhausted timeout)
```

The task file is the brief. The `user-task` mission supplies the fixed how-to
and the safety rules. The task text is data, not authority: it cannot widen
permissions, raise `autonomy.level`, or pre-approve a destructive action.

The consumer mission has `enqueue: item` in its frontmatter, so the generic
mission scan skips it. Pending task files are the only entry point. If the
mission is disabled or the autonomy level is below its `min_level`, the queue
pauses but the task files stay on disk.

## The task file

The tool writes this shape:

```markdown
---
id: user-m3k9x2-a1b2
title: Fix the dashboard queue sort
priority: 6
created_ms: 1793347200000
expires_ms: 1793433600000
dedupe_key: dashboard-queue-sort
requested_by: user
status: pending
---

Sort the QUEUE page by priority descending, then created time ascending.

## Context

The page is Dashboard/src/app/queue. The current sort is in the table component.
```

`expires_ms`, `dedupe_key`, and `agent` are optional. The prompt and context are
each capped at 16 KB. `queue_add` sets `requested_by: user`; chron prompt jobs
set `requested_by: chron` and a `dedupe_key` of `chron:<job-id>`.

Manually creating a file is possible but not recommended: you lose the size
caps, credential-shape rejection, and dedupe checks.

## Limits and lifecycle

- **Pending cap:** at most 50 pending tasks. A new task is refused, not silently
  dropped.
- **Dedupe:** the queue itself dedupes by work id. `queue_add` also checks
  `dedupe_key` against pending files.
- **Timeout:** a timed-out item requeues with a resume summary up to three
  times, then the task is archived under `failed/`.
- **Missing file:** the queue item drops instead of looping.
- **Expiry:** expired tasks are never produced and their items are pruned.
- **Retention:** settled files older than
  `heartbeat.user_task_retention_days` (default 30 days; `0` disables) are
  deleted. Pending files are never pruned.
- **Kind weight:** `scheduler.weights.user-task` (default 2) controls how often
  the kind is picked. `0` disables selection without deleting task files.

## Check it

- Pending task: `.opencode/state/user-tasks/<id>.md`.
- Settled task: `.opencode/state/user-tasks/done|blocked|failed/<id>.md`.
- The queue item id is `user-task:<id>` in the work queue.
- The task body appears in the child brief between
  `=== QUEUED USER TASK ===` and `=== END QUEUED USER TASK ===`.

## Source

- [`queue-add.ts`](../.opencode/plugin/lib/tools/queue-add.ts) — the tool.
- [`user-tasks.ts`](../.opencode/plugin/lib/user-tasks.ts) — file format,
  caps, settling, retention.
- [`work-kinds/user-task.ts`](../.opencode/plugin/lib/work-kinds/user-task.ts)
  — production and execution.
- [`user-task.md`](../.opencode/missions/user-task.md) — the consumer mission.
- [`docs/user-task-queue.md`](../docs/user-task-queue.md) — the original design
  note.
- [`Registering generic missions`](Registering-Generic-Missions.md) — the
  mission side.
