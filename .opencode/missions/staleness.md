---
id: staleness
title: Refresh stale notes
frequency: mid
menus: [day]
min_level: 2
approval: writes-follow-dial
candidacy: digest
agent: ""
enabled: true
---

Refresh profile notes and other reference material that has gone stale
(plan §6.3).

1. Ask `rag-search` for profile and procedure notes whose facts drift with
   time (setup details, versions, paths, contact data).
2. For each candidate, verify the current fact on the machine first (read-only
   commands only — `pacman -Q`, `ls`, config reads); never refresh from memory.
3. Hand verified corrections to `rag-brain` — update in place, keep the note's
   existing voice and structure, bump the `updated:` frontmatter date.
4. Skip anything you cannot verify; stale-but-honest beats wrong.

Record one line per note touched: what changed, or that nothing was stale.
