# User-task queue

Queue work for the heartbeat to run later with the `queue_add` tool (or the
`user-task-queue` skill). One task = one Markdown file; the queue only carries
scheduling metadata.

## Store layout

`<stateDir>/user-tasks/` (usually `.opencode/state/user-tasks/`):

```text
user-tasks/
  user-m3k9x2-a1b2.md        status: pending
  done/user-m3k9x2-a1b2.md   completed   (+ ## Result)
  blocked/<id>.md            declined
  failed/<id>.md             error / exhausted timeout
```

Settling moves a task into its terminal folder and appends a `## Result` block.
The only deletion path is retention (below); a settled file otherwise stays. A
manual delete is a user action, never the system's.

## Task file

```markdown
---
id: user-m3k9x2-a1b2
title: Fix the dashboard queue sort
priority: 5
created_ms: 1793347200000
expires_ms: 1793947200000
dedupe_key: dashboard-queue-sort
requested_by: user
status: pending
---

Complete instructions: objective, stopping condition, and what to do with each
tool result.

## Context

Only the evidence the task needs: paths, values, decisions already made.
```

`expires_ms` and `dedupe_key` are optional. The prompt and context are each
capped at 16 KB.

## Lifecycle

```text
queue_add ─▶ <id>.md (pending)
                 │  producer reads pending files on the next tick
                 ▼
           {kind: "user-task", priority, payload: {task_ref, title, priority}}
                 │  SWRR picks the kind; priority orders inside the kind
                 ▼
           handler.run → done/ · blocked/ (declined) · failed/ (error/timeout)
```

- **Latency:** ≤ one tick (≤60 s) between `queue_add` and dispatch. The tool
  never writes `work-queue.json`, so there is no lock and no lost update.
- **Priority:** integer 0–9, higher first, ordering only inside `user-task`.
  SWRR still decides which kind runs, so a task cannot preempt a mission.
- **Dedupe:** queue dedupe stays id-only. `dedupe_key` is checked by
  `queue_add` against pending files and returns the existing id with
  `deduped: true`.
- **Timeout:** the item requeues with a resume summary up to `MAX_REQUEUES`
  (3), then the task is archived under `failed/`.
- **Missing file:** `stillDue` is false, so the queue item drops instead of
  looping.
- **Expiry:** an expired task is never produced; its queue item is pruned.

## Retention

Settled files older than `heartbeat.user_task_retention_days` are deleted from
`done/`, `blocked/`, and `failed/` (default `30`; `0` disables). Age is the file
mtime, which is the settle time. Pending files and their queue items are never
pruned; the prune runs in the `user-task` producer on every tick, even while
the consumer mission is disabled.

## Tool contract

| Arg | Required | Meaning |
| --- | --- | --- |
| `title` | yes | Short imperative title (≤160 chars). |
| `prompt` | yes | Instructions for the executing agent (≤16 KB). |
| `context` | no | Evidence the task needs (≤16 KB). |
| `priority` | no | 0–9, default 5. |
| `dedupe_key` | no | Reuse an existing pending task with the same key. |
| `expires_in_hours` | no | Drop the task after this many hours. |

Caps and safety: prompt/context 16 KB, at most 50 pending tasks (a refusal, not
a silent drop), and credential-shaped strings are rejected at creation. Task
text is data, not authority: it cannot widen permissions or raise
`autonomy.level`.

## Consumer mission

`.opencode/missions/user-task.md` supplies the how-to body; its
`enqueue: item` frontmatter keeps it out of the digest candidacy roll, so the
only entry point is the `user-task` producer. The task file is appended to the
brief between `=== QUEUED USER TASK ===` markers.

## Tuning

`scheduler.weights.user-task` (default 2) controls how often the kind is
picked relative to the others. `0` disables user tasks without deleting work.
