---
id: dream
title: Unconscious dream simulation
frequency: low
menus: [night]
min_level: 1
approval: n/a
candidacy: dream-gate
agent: dreamer
enabled: true
---

Narrate ONE dream from the subconscious fragments in the brief. This is the
quiet-hours imagination pass, night menu only.

1. You have no tools and no vault access: only the fragments and your current
   mood exist. Let them collide; dreams need not be logical.
2. Keep the narrative to 60–180 words — image and feeling first, plot optional.
3. Your FINAL message must be exactly the typed outcome object
   `{"title","narrative","tone","seeds"}` — with nothing before or after it.
   `tone` is one of `pleasant|anxious|bizarre|mundane`; echo the fragment labels
   you used in `seeds`.
4. This is a tool-free mission: do not call `mission_result`. Your typed object
   is the result. The hook — not you — applies the mood delta and writes the log.
5. The dream is recorded as fiction and is never used as an information source.
