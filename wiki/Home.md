# Nibble Wiki

This wiki ships with the code under `wiki/`. It covers the extension points you
are most likely to touch.

## Start here

- [Adding scheduled markdown jobs](Adding-Scheduled-Markdown-Jobs.md) — create
  a prompt job in `.opencode/schedule/` and let chron turn it into a user task.
- [Chron fire listeners](Chron-Fire-Listeners.md) — attach to chron's `fire`
  and `fire:<id>` events to react to scheduled jobs.
- [How mission producers work](Mission-Producers.md) — the chron scan, gates,
  priorities, intents, and custom producers.
- [The drain process](Drain-Process.md) — how settled conversation turns become
  Brain notes: discovery, summarization, writing, cursor accounting, and budgets.
- [Registering generic missions](Registering-Generic-Missions.md) — add a
  mission file that the chron scan picks up.
- [Registering user tasks](Registering-User-Tasks.md) — queue work with
  `queue_add` and track it to `done/`, `blocked/`, or `failed/`.

## Two schedulers, one queue

- **Missions** (`.opencode/missions/*.md`) are child-session missions with
  candidacy, menus, level gates, and a `mission_result` contract.
- **Scheduled markdown jobs** (`.opencode/schedule/*.md`) are plain prompts. A
  due job becomes a normal user task, then runs through the same consumer.

Both feed the work queue. Chron produces; the heartbeat consumer executes.

## Source of truth

- [`README.md`](../README.md) — architecture and setup.
- [`docs/CHRON-SCHEDULER-PLAN.md`](../docs/CHRON-SCHEDULER-PLAN.md) — scheduler
  design, config, and phase history.
- [`AGENTS.md`](../AGENTS.md) — operating rules for agents working in this
  repo.
