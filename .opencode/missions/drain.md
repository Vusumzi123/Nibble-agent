---
id: drain
title: Drain conversation backlog into the vault
frequency: high
menus: [day, night]
min_level: 2
approval: writes-follow-dial
candidacy: turns-pending
runner: drain-pipe
lane: side
on_decline: stop
enabled: true
---

Run the `drain_run` tool once.

- If it returns `status: "skipped"`, load the `roll-mission` skill and follow
  it: call `mission_result` with `status: "declined"` and the returned reason,
  then stop. Do not consolidate manually.
- If it returns `outcome: "error"` or `outcome: "dropped"`, call
  `mission_result` with `status: "error"` and the returned summary, then stop.
- Otherwise (`status: "completed"` with `outcome: "completed"`,
  `"degraded"`, or `"nothing"`), call `mission_result` with
  `status: "completed"` and a one-line summary of what was consolidated, then
  stop.

Do not delegate to `rag-brain` yourself, and do not touch the cursor or the
turn store. The tool owns the provider writer, the cursor, and the turn
accounting.
