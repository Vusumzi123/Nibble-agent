---
id: idea-generate
title: Draw today's idea for the bucket
frequency: low
menus: [day]
min_level: 1
approval: n/a
candidacy: idea-roll
agent: idea-generator
enabled: true
---

Write ONE original idea for the agent's personal idea log (plan §17.10 — the
day's generation draw, day menu only; the `idea-roll` candidacy already
checked that today's draw still has budget).

1. You have no tools: everything you need is in this brief. Write from what
   the agent already knows — you cannot read the vault or the bucket.
2. Use the `=== REQUESTED CATEGORY ===` block when the hook injected one;
   otherwise pick the category that fits best (`improve-self`, `thought`,
   `business`).
3. Make it concrete and self-contained — someone should be able to act on it
   without further context. Do not invent facts about the user; no secrets,
   no credentials, no personal data.
4. Do not restate or closely paraphrase an idea the agent already has.
5. Your FINAL message must be EXACTLY one block and nothing else:

   ```
   <<<IDEA
   TITLE: <one short title line>
   CATEGORY: <the requested category>
   BODY:
   <a few short paragraphs or bullets of markdown>
   >>>
   ```

6. The hook disposes: after you finish, heartbeat dedupes against the bucket,
   runs the JEV review (fail-closed on fallback/abstain), and appends to
   `<vault>/<idea.bucket_file>` itself. Never claim to have written a file.
