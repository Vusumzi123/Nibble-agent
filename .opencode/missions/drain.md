---
id: drain
title: Drain conversation backlog into the vault
frequency: high
menus: [day, night]
min_level: 2
approval: writes-follow-dial
candidacy: turns-pending
agent: ""
enabled: true
---

Consolidate unconsumed conversation turns into structured Brain vault notes
(the self-RAG loop, plan §6.3).

1. Check how many unconsumed turns are pending; if zero, stop and record
   "drain: nothing to consolidate".
2. Delegate the consolidation to `rag-brain` with the turn excerpt — follow
   its search-before-write dedupe rules; never create a note that already
   exists in substance.
3. Keep notes tight (a fact and where to find it, not a transcript); link
   related notes with [[wikilinks]]; respect user-write-only zones
   (Journal/) — read freely, never write there.
4. Verify the writes landed (rag-search for one of the new titles).

Record one line: what was written, or that there was nothing to do.
