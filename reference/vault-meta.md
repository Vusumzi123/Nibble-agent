# Vault Meta Rules

On-demand reference for `rag-brain`. Load when a structural
change touches `Brain/meta/` or when the changelog format is needed.

## Ownership

- `Brain/meta/` is yours to maintain: the contract, overview, `log.md`, and the
  reclassification/hygiene logs. The main agent never edits the vault.
- When your change makes `meta/` stale (new folder, moved notes, convention
  shift), update `meta/contract.md` (Directory Layout section) and
  `meta/overview.md` where relevant in the same pass as the structural change.
- `Journal/` stays read-only regardless.

## Changelog format (`meta/log.md`)

Every entry starts with a parseable header:

```
## [YYYY-MM-DD] op | Short Title
```

`op` is one of `consolidation`, `reclassification`, `hygiene`, `change`, then
1–3 sentences of body. Newest entries go LAST.

- Do NOT write note-count reconciliation prose — the drain ledger tracks counts
  deterministically.
- During consolidation, append one entry for the batch yourself, then report the
  item labels (see `reference/consolidation.md`).
- For interactive structural changes, append the entry the same way.
