---
name: vault-note-curator
description: Brain vault hygiene audits for the Obsidian markdown knowledge base at ./Brain/. Use when the user asks for "vault hygiene", "clean up the vault", "find stale notes", "check for broken links", orphan-note detection, or frontmatter linting. Note conventions (frontmatter schema, naming, wikilinks, template) are enforced by the rag-brain subagent on every write — this skill is for periodic audits only.
---

# Vault Note Curator

The Brain vault (`./Brain/`) is an Obsidian-style markdown knowledge base. Note
conventions — frontmatter schema, naming, wikilinks, note template — live in the
**rag-brain subagent's prompt** (`.opencode/agents/rag-brain.md`, section
"Vault Conventions") and are applied automatically on every vault write. The
authoritative schema is `Brain/meta/contract.md`.

This skill covers what rag-brain does NOT do: **periodic hygiene audits** run
by the main agent with shell tools.

## Exclusions

There are no vault-internal staging directories. The `knowledge-hook` memory
buffer holds un-consumed conversation turns OUTSIDE the vault
(`.opencode/state/memory.json`, gitignored) and is never indexed, so no audit
here needs a directory exclusion.

## Hygiene Audits

Run read-only first, present findings, apply fixes only after user approval
(locks L2/L3). Suggested triggers: "vault hygiene", "clean up the vault",
"find stale notes", "check for broken links".

### Stale notes

1. `grep -r "^updated:" Brain/ --include="*.md"` → extract dates per file.
2. Flag notes with `status: draft|in_progress` whose `updated` is older than
   90 days (or a user-given threshold).
3. Report as a table: note, age, status, suggested action (review/archive/close).

### Link rot

1. `grep -roh "\[\[[^]]*\]\]" Brain/ --include="*.md" | sort -u` → all targets
   (strip `|alias` and `#heading` suffixes before comparing).
2. Glob `Brain/**/*.md` → existing note names.
3. Targets with no matching filename = broken links. Report source note +
   broken target; suggest the closest existing title when obvious.

### Orphan notes

1. Build the wikilink target set as above.
2. Notes appearing in no other note's links AND having an empty/missing
   `## Related` section are orphans.  Use `^## Related$` (exact match, anchored) to avoid false positives from body headings like `## Related Materials`.
3. Suggest where each should be linked from, don't auto-edit.

### Frontmatter lint

For every note, check against the schema (mirrored from rag-brain's
conventions — if the two drift apart, rag-brain's prompt wins):

- Required fields: `title`, `tags`, `type`, `created`, `updated`, `status`
- `type` enum: `note | reference | log | template`
- `status` enum: `draft | in_progress | done`
- Tags: lowercase, hyphen-separated words, `/` for hierarchy
- Dates parse as ISO (YYYY-MM-DD as practiced)

Report violations grouped by note; fix mechanically only after approval,
preserving all body content byte-for-byte. Fixes delegated to rag-brain
inherit the conventions automatically.

## Delegating to rag-brain

rag-brain has the vault conventions built into its prompt — do NOT restate the
frontmatter schema, naming rules, or note template when delegating. Just
specify:

- WHAT to create/update and the content to write
- Which existing notes to cross-link (rag-brain maintains `## Related` sections)
- Instruction to verify writes by re-reading the file afterwards

Never pre-filter relevance for rag-brain — it decides what belongs in the vault.

## Safety Rules

- Vault edits are content edits: preserve existing body text unless the task is
  explicitly to rewrite it.
- Never delete notes — propose `.trash/` candidates to the user instead.
- Keep notes concise and factual; no invented commands, versions, or dates.
- After any convention-affecting change, tell the user if
  `meta/contract.md` or `AGENTS.md` should be updated to match.
