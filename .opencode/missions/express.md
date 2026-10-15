---
id: express
title: Deliver one stored idea
frequency: low
menus: [day]
min_level: 1
approval: n/a
candidacy: min-gap:express
agent: ""
enabled: false
---

Deliver ONE stored idea from the bucket when the min-gap is due (plan §17.10
— deterministic candidacy: due ⇒ offered; as the sole candidate it dispatches
without a JEV call).

Shipped disabled: the delivery channels (Telegram / email) land with the
comms card (card 10) — until a bridge is enabled there is nothing to send
through, so this mission stays out of the candidate set (the `notify`
precedent). The `min-gap:express` store behind the candidacy is wired and
tested regardless.

When enabled:

1. Respect the quiet window (§17.10): inside the quiet hours defer the
   delivery to window end — a 03:00 idea never lights up a channel. The
   `menus: [day]` frontmatter already keeps the digest honest after dark;
   this covers a dispatch that races the window closing.
2. Parse `<vault>/<idea.bucket_file>`, pick one stored idea, skipping the
   recent-hash history so an idea is not repeated (reset the history once
   everything has been expressed).
3. Send it on every enabled channel — one channel failing never blocks
   another; the idea counts as expressed when at least one accepts.
4. The hook records `lastExpressedAt` (the `min-gap:express` store) after a
   completed run — first sender wins, no double-send.

Record one line: what was sent, or that there was nothing due.
