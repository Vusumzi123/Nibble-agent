---
name: roll-mission
description: Use when the current heartbeat mission cannot proceed — a precondition is not met, a tool reports "skipped", or the work is already in sync. Tells the agent how to decline cleanly so the orchestrator can roll another mission.
---

# Roll a new mission

A heartbeat mission is allowed to decline. Declining is not a failure: it
tells the orchestrator that this mission has nothing to do right now. The
queue item is dropped; the producer re-proposes it next tick if its gate still
passes.

## When to decline

Decline instead of forcing work when:

- a tool returns `status: "skipped"` (for example a capability that reports
  memory is in sync, paused, has no provider, or the store is unavailable);
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
   drops the queue item.

## Notes

- The tool result is telemetry; the decline itself is only recognised through
  `mission_result`. Do not rely on a tool's `skipped` status alone.
- The queue item is dropped. There is no same-tick reroll; the producer may
  re-propose the mission on a later tick if its gate still passes. Other
  eligible pool items are not dispatched in the same tick.
