---
id: notify
title: Fan out approvals and notifications
frequency: high
menus: [day]
min_level: 1
approval: n/a
candidacy: digest
agent: ""
enabled: false
---

Notify the user about pending approvals and actionable items on the default
comms channel (plan §6.3).

Shipped disabled: the comms bridges land with the comms card (card 10) —
until `comms.telegram.enabled` (or email) is on, there is nothing to send
through, so this mission must stay out of the candidate set.

When enabled: read the approvals inbox and awaiting-reply windows, group
pending items into one concise message per channel, send via the configured
bridge, and respect the quiet window — never wake the user at night unless
the item is marked urgent.

Record one line: what was sent, or that there was nothing to notify.
