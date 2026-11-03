# Kanban Boards

On-demand reference for `rag-brain` and `drain-writer`. Load only when creating
or editing an obsidian-kanban board.

The vault has the **Kanban** community plugin (`mgmeyers/obsidian-kanban`,
installed under `.obsidian/plugins/obsidian-kanban`). Boards are plain markdown
files — create and edit them exactly like any other note, but with a stricter
body format. The plugin detects a board purely by frontmatter (the
`kanban-plugin` key); the filename needs no special suffix.

## Required frontmatter

The plugin's own marker. Keep it, never remove it:

```yaml
---

kanban-plugin: board

---
```

You may add the standard vault keys (`title`, `tags`, `created`, `updated`)
alongside it. `type`/`status` are optional for boards (a board is a work view,
not a knowledge note). Optional per-board plugin settings (only set when the
user asks): `date-format` (default `YYYY-MM-DD`), `show-checkboxes`,
`link-date-to`, `archive-with-date`, `show-view-as-markdown`, `lane-width`,
`tag-colors`, note template keys.

## Body format

After the closing `---`:

- One `## Heading` per **column** (lane). Heading level must be exactly `##`.
- One markdown task item per **card**: `- [ ] open card`, `- [x]` (or `- [X]`)
  for done. Cards go directly under their lane heading.
- **Card details / subtasks** = continuation lines indented under the card
  (tab or 4 spaces — match the file's existing style). Nested `- [ ]` items
  inside a card work and stay attached to that card. Blank line ends the card.
- Cards may contain `[[Wikilinks]]`, `#tags`, and dates (`2026-09-28`,
  `2026-09-28 10:00` — recognized via `date-format`).
- A trailing `^block-id` on a card's first line is a block reference — preserve
  it when editing, don't invent new ones.
- A final `## Archive` lane is the plugin-managed archive (its "archive
  completed cards" command appends there). Keep it last; treat its contents as
  user/plugin-owned, don't clear it without being asked.

## Example board

```markdown
---

kanban-plugin: board

---


## To Do

- [ ] Refactor the log-rotation helpers
    - [ ] split out shared parsing
    - [ ] add rotation unit tests
- [ ] Review the security watchlist update #security

## Doing

- [ ] Draft the retrieval-gate tuning notes

## Done

- [x] Vault conventions note
```

## Writing rules for boards

- Follow the normal folder routing (a backlog board belongs at root with the
  other backlogs; a topic board goes in its topic folder). Keep `title` equal
  to the filename without `.md`.
- When creating a board for the first time in a session, append an entry to
  `meta/log.md` (`## [YYYY-MM-DD] change | ...`) and add the board's format to
  `meta/contract.md` if it is not documented yet (you own `meta/`).
- Edit cards with the native `edit` tool (exact-string on the markdown lines),
  same as body edits — NEVER `frontmatter_set` (see
  [[Markdown-Vault MCP Serializer Pitfall]]).
- Preserve lane order, card order within a lane, and any block IDs. Moving a
  card between lanes = removing the item from one lane and adding it under
  another in the same edit.
- `## Related`/wikilink conventions do **not** apply to boards — a board's
  relationships live in its card content.
