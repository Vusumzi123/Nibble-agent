---
name: roll-mission
description: Use when the current heartbeat mission cannot proceed — a precondition is not met, a tool reports "skipped", or the work is already in sync. Tells the agent how to decline cleanly so the orchestrator can roll another mission.
---

# Roll a new mission

A heartbeat mission is allowed to decline. Declining is not a failure: it
tells the orchestrator that this mission has nothing to do right now, so it
can exclude the mission and re-run the digest/JEV once in the same tick.

## When to decline

Decline instead of forcing work when:

- a tool returns `status: "skipped"` (for example `drain_run` when memory is
  in sync, paused, has no provider, or the turn store is unavailable);
- a stated precondition in the mission prompt is not met;
- the work the mission describes is already complete.

Do not use a decline for an error, a timeout, or a partial result. Those are
`status: "error"`.

## How to decline

1. Stop before changing anything. A declined mission must leave no side
   effects: no vault writes, no cursor changes, no backlog entries.
2. Call the `mission_result` tool exactly once:

```json
{
  "status": "declined",
  "summary": "one line explaining why nothing was done",
  "reason": "in-sync"
}
```

3. Do not continue with the mission. The orchestrator reads the result and
   applies the mission's `on_decline` policy (`reroll` or `stop`).

## Notes

- The tool result is telemetry; the decline itself is only recognised through
  `mission_result`. Do not rely on a tool's `skipped` status alone.
- With `on_decline: reroll`, the orchestrator excludes this mission and
  chooses another one once. If there is nothing else to do, the tick ends
  silently.
- With `on_decline: stop`, the tick ends silently even if other missions are
  eligible.
