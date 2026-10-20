---
id: staleness
title: Refresh the oldest reference note
frequency: mid
menus: [day]
min_level: 2
approval: writes-follow-dial
candidacy: brain-stale:720
on_decline: reroll
agent: ""
enabled: true
---

Refresh the oldest `type: reference` note in the vault (plan §6.3).

The heartbeat computed this before dispatch and the brief names it:
`brain_oldest=<path> (updated <date>, <n>d old)`. The note was chosen
deterministically from its `updated:` frontmatter, not by file mtime. Do not
recompute the age and do not choose a different note. If the signal is absent
(which should not happen with `brain-stale:720`), load the `roll-mission` skill
and follow it with reason `no-reference-notes`.

1. Read the named note with `rag-search` (the path is vault-relative).
2. Verify each time-drifting fact on the machine first — read-only commands
   only (`pacman -Q`, `ls`, config reads); never refresh from memory. Leave
   anything you cannot verify untouched.
3. Hand verified corrections to `rag-brain`: update in place, keep the note's
   existing voice and structure, and bump `updated:` to today. If the note is
   still accurate, bump `updated:` after verification so the age reflects the
   check — do not leave a verified note looking stale.
4. Never touch `Journal/` or any note outside the reference type. Do not
   create new notes for this mission.
5. Call `mission_result` once: `completed` with one line naming the note path
   and what changed (or `verified unchanged`).
