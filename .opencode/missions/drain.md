---
id: drain
title: Drain conversation backlog into the vault
frequency: high
menus: [day, night]
min_level: 2
approval: writes-follow-dial
candidacy: turns-pending
runner: drain-pipe
enabled: true
---

The in-process `drain-pipe` runner owns this mission. It selects the active
memory provider's writer (`BrainProvider` → `rag-brain` consolidation mode,
§8), hands it labelled `#1..N` items, and advances the cursor only when the
writer's `WriteReport` accounts for every item.

Do not consolidate manually, do not delegate to `rag-brain` yourself, and do
not touch the cursor or the turn store. If the runner is unavailable, record a
one-line misconfiguration entry and stop.
