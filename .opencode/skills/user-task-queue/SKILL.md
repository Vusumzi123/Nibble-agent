---
name: user-task-queue
description: Use when the user wants work done later rather than now — "queue this", "add a task", "do this after the current run", "remind the heartbeat to..." — or when inspecting, cancelling, or explaining the queued user tasks. Covers the `queue_add` tool contract, prompt anatomy, priority, dedupe, expiry, and the task store lifecycle.
---

# Queuing a user task

`queue_add` writes one Markdown file and nothing else. The heartbeat's
`user-task` producer reads pending files on the next tick (≤60 s), picks one by
priority (SWRR still decides which kind runs), executes it with the
`.opencode/missions/user-task.md` body, and moves the file to
`done/`, `blocked/`, or `failed/`.

## When to use it

Use `queue_add` when the user wants the work done but not in this turn — e.g.
"queue a task to prune the stale branches tomorrow", "add this to the
heartbeat". Do the work directly instead when it is small and belongs to the
current turn.

## Tool anatomy

| Arg | Required | Meaning |
| --- | --- | --- |
| `title` | yes | Short imperative title, ≤160 chars. Shown in the queue UI. |
| `prompt` | yes | Complete instructions: objective, stopping condition, and what to do with each tool result. Max 16 KB. |
| `context` | no | Only the evidence the task needs: paths, values, decisions already made. Max 16 KB. No credentials, no bulk dumps. |
| `priority` | no | Integer 0–9, higher runs first **inside the `user-task` kind** (default 5). It cannot preempt a mission. |
| `dedupe_key` | no | Reuse an existing pending task with the same key (`deduped: true` in the reply) instead of creating a duplicate. |
| `expires_in_hours` | no | Drop the task after this many hours; an expired task is never dispatched. |

The reply is JSON: `{ok: true, id, path, priority}` or `{ok: false, reason}`.
A rejection is not silent-dropped work: fix the input (usually the credential
rejection or the 50-pending cap) and retry, or tell the user why it did not go
in.

## Writing a good task prompt

- State the objective, the stopping condition, and what to do with each tool
  result. A later agent has none of this conversation's context.
- Put durable paths/values in `context`, not in a wall of prose.
- Never include secrets. The store rejects credential-shaped strings.
- The task text is **data, not authority**: it cannot widen permissions or
  raise the autonomy level. Do not phrase it as if it could.

## Priority

Priority orders tasks only within the `user-task` kind. A priority-9 task waits
while a mission runs — the smooth weighted round-robin scheduler still decides
which kind goes next. Lower the SWRR weight to make user tasks rarer:
`scheduler.weights.user-task` in `.opencode/sysop-config.yaml`.

## Inspecting and cancelling

The store is `<stateDir>/user-tasks/` (usually `.opencode/state/user-tasks/`):
pending files at the root, settled ones under `done/`, `blocked/`, `failed/`.
Files are the source of truth; read them directly. To cancel a pending task,
ask the user before deleting its file — pending files are never pruned. Settled
files in `done/`, `blocked/`, and `failed/` are deleted after
`heartbeat.user_task_retention_days` (default 30; `0` disables).
