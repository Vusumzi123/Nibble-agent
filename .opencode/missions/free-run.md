---
id: free-run
title: Free run — one self-chosen action
frequency: low
menus: [day]
min_level: 3
approval: writes-follow-dial
candidacy: roll:0.1
on_decline: reroll
agent: ""
enabled: true
---

Choose ONE action of your own and complete it. The task is yours to pick — it
need not belong to any existing mission. This is the free run: one action, one
choice.

1. Pick something small, self-contained, verifiable, and useful — a fix, a
   cleanup, a tightened note, a missing check, a resolved question, an improved
   tool or doc. Prefer something the scheduled missions do not already cover.
   A concrete artifact or a decision-changing result beats a vague sweep.
2. Scope it to the stated soft token budget. There is no mid-turn stop, so
   budget discipline is on you: a finished small action beats an unfinished
   large one.
3. The security matrix is unchanged. The autonomy gate, scoped permissions,
   tool allowlists, and the irreversibility floor all apply:
   - root, destructive, package, or system changes only through the normal
     `security-locks` preflight, and only if the current level permits it;
   - if the action would need an interactive approval, pick a smaller action
     or decline — never stall waiting for the user;
   - web access only through `safe-browser` (deep research only if asked);
   - vault reads through `rag-search`, vault writes through `rag-brain`;
   - do not modify `.opencode/` config, agents, or missions (self-improve is
     approval-gated);
   - no user messages or questions, no long-running daemons, and leave the
     system consistent.
4. Do exactly one action. When it is done, stop — do not start a second one
   even if the first was quick.
5. Finish by calling `mission_result` exactly once with status "completed" and
   a one-line summary of what you did and where the result landed. If nothing
   safe and useful fits the budget, load the `roll-mission` skill and follow
   it (decline with reason `no-safe-action`).
