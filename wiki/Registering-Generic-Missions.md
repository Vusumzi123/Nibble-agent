# Registering a generic mission

A generic mission is a markdown file in `.opencode/missions/` that the chron
mission scan owns. Registering one means adding the file. There is no code to
write and no registry entry to add.

Use a generic mission when you want a scheduled child-session task with gates
(menus, autonomy level, candidacy) and a `mission_result` contract. If you only
need a plain prompt that becomes a user task, use a
[scheduled markdown job](Adding-Scheduled-Markdown-Jobs.md) instead.

## The file

Create `.opencode/missions/weekly-review.md`:

```markdown
---
id: weekly-review
title: Weekly review
schedule: weekly fri 17:00
priority: 4
menus: [day]
min_level: 2
candidacy: always
producer: generic
enqueue: producer
agent: ""
enabled: true
---

Review the week. Read the recent ledger entries and the open follow-ups, then
summarize what changed and what still needs a decision. Stop when the summary
is written to the review note.
```

The filename stem is the fallback id. Keep `producer: generic` and
`enqueue: producer`; those are the defaults, and changing either takes the
mission out of the generic scan.

The body is the mission brief. The scan does not run it; the consumer wraps it
with the fixed prompt and context before starting the child session.

## Frontmatter

| Key | Default | Effect |
| --- | --- | --- |
| `schedule` | none | Required for a generic mission. The same grammar as scheduled jobs: `every 6h`, `daily 09:00`, `weekly mon 09:00`, five-field cron, `at <ISO>`, or `manual`. |
| `priority` | `5` | `0`–`9`, higher first. Orders missions inside the mission kind; it does not change the kind's SWRR weight. |
| `producer` | `generic` | `generic` uses the mission scan. Any other value reserves the mission for a registered custom producer. |
| `enqueue` | `producer` | `producer` enters through the scan. `item` skips the scan and hands the mission to a dedicated ingester. |
| `menus` | `[day]` | `day`, `night`, or `both`. `both` expands to day and night. |
| `min_level` | `2` | Lowest autonomy level that may run it. |
| `candidacy` | `always` | Predicate gate. Common values: `always`, `backlog-pending`, `brain-stale`, `brain-stale:<hours>`, `roll:<chance>`, `idea-roll`, `dream-gate`. |
| `agent` | empty | Child agent override. Empty uses the heartbeat agent. |
| `enabled` | `true` | Master switch. |
| `approval` | `writes-follow-dial` | Execution-side approval policy, not a producer gate. |

`id` and `title` default to the filename stem. Unknown keys warn once; invalid
values fall back to the default and warn once. A duplicate mission id keeps the
first file in sorted filename order and reports the later one.

The `autonomy.missions.<id>` overlay is restrict-only: it may disable the
mission, raise `min_level`, lower `priority`, or narrow `menus`. It cannot
enable a file-disabled mission, raise priority, lower `min_level`, or widen
menus. It cannot change `schedule`, `producer`, or `enqueue`.

## What happens after you add it

1. The first scan that sees the mission seeds `last_evaluated_ms = now` and
   moves on. The mission waits for its next occurrence; it does not fire on the
   next scan.
2. On a due occurrence, the scan applies the gates. A failed gate consumes the
   occurrence, so the next chance is the next schedule occurrence, not the next
   scan.
3. Eligible missions are ordered by priority, then occurrence, then id. The
   scan writes at most `chron.mission_max_per_scan` intents (default 5).
4. The intent is merged into the work queue by the consumer. The mission then
   runs as a child session through the normal autonomy gate.
5. A declined mission drops its item; the next occurrence can propose it again.
   A timeout is summarized and resumed up to the normal requeue limit.

Overflow beyond the per-scan cap is not lost. It stays eligible and is
re-evaluated on the next scan. A full work queue leaves the intent in the inbox
until there is room.

## Distinguish the owners

| Frontmatter | Owner |
| --- | --- |
| `enqueue: producer` + `producer: generic` | The chron mission scan. This page. |
| `enqueue: producer` + `producer: <name>` | A registered custom producer; the generic scan skips it. See [How mission producers work](Mission-Producers.md). |
| `enqueue: item` | A dedicated ingester such as the `user-task` rail; the generic scan skips it. See [Registering user tasks](Registering-User-Tasks.md). |

`schedule: manual` is accepted by the parser but never produced by the generic
scan. Use a real schedule, or a custom producer that pushes the occurrence.

## Validate and troubleshoot

Direct check:

```bash
node --test .opencode/plugin/lib/production/missions.test.ts
```

Useful paths:

- `.opencode/state/missions.json` — per-mission `last_evaluated_ms`.
- `.opencode/state/inbox/` — intents waiting for the consumer.
- `.opencode/state/work-queue.json` — merged work.
- `.opencode/logs/chron.log` — scan fires and warn-once issues.
- `.opencode/logs/autonomy-config.log` — mission parse and overlay rejects.

If it never fires:

- `enqueue: item` or a non-`generic` `producer` means another owner has it.
- A missing or invalid `schedule` is skipped with a warning.
- The first scan only seeds; wait for the next occurrence.
- A failed gate (menu, level, candidacy) consumed the occurrence.
- `mission:<id>` was already queued, so the occurrence was consumed.
- The per-scan cap deferred it to the next scan.
- `chron.mission_max_per_scan` is `0`, or `autonomy.level` is `0`.
- The overlay disabled it, raised `min_level`, lowered `priority`, or narrowed
  `menus`.
- `chron.enabled` was false when opencode started; enable it and restart.
- `chron.mission_scan` is read when the code job registers; changing it needs a
  restart. `chron.mission_max_per_scan` is read on each scan.

## Source

- [`missions.ts`](../.opencode/plugin/lib/missions.ts) — frontmatter and the
  restrict-only overlay.
- [`production/missions.ts`](../.opencode/plugin/lib/production/missions.ts) —
  the scan and gates.
- [`production/intents.ts`](../.opencode/plugin/lib/production/intents.ts) —
  intent handoff.
- [`chron/jobs/index.ts`](../.opencode/plugin/lib/chron/jobs/index.ts) — the
  `missions` code job.
- [`How mission producers work`](Mission-Producers.md) — the full producer
  model.
