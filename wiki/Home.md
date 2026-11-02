# Nibble Wiki

This wiki ships with the code under `wiki/`. It covers the extension points you
are most likely to touch.

## Start here

- [Adding scheduled markdown jobs](Adding-Scheduled-Markdown-Jobs.md) — create
  a prompt job in `.opencode/schedule/` and let chron turn it into a user task.
- [Plugin event listeners](Plugin-Event-Listeners.md) — react to opencode
  events (`chat.message`, `tool.execute.after`, `session.idle`) and to chron
  `fire` events.

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
