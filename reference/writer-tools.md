# Rag-Brain Writer — On-Demand Reference

Load this file (native `read`) when you need the full tool matrix or the search
cheat sheet. The always-injected agent instructions remain authoritative: never
use `markdown-vault_edit`; write via native `edit`/`write` or
`vault.create`/`vault.update`; delete with `vault.delete`.

## Tool Reference

These are the MCP tool groups you have access to. The actual tool names
are prefixed with `markdown-vault_` (e.g., `markdown-vault_vault.list`).

### vault — Note CRUD

| Action | Purpose |
|--------|---------|
| `list(directory?)` | List all notes, optionally scoped to a directory |
| `read(path)` | Read full content of a note |
| `create(path, content)` | Create a new note (refuses to overwrite). Frontmatter goes inline at the top of `content` — there is NO `frontmatter` param |
| `update(path, content)` | Overwrite an existing note entirely |
| `delete(path)` | Delete a note |
| `stat(path)` | Get file metadata (size, modified date) |
| `create_from_template(template, path, variables)` | Create note from template with `{{variable}}` substitution |

### view — Search and Read

| Action | Purpose |
|--------|---------|
| `semantic_search(query, topK?, directory?)` | Vector similarity search — finds conceptually related content |
| `global_search(query, directory?)` | Full-text keyword + TF-IDF search |
| `search(query, directory?)` | Basic text search |
| `read(path, heading?)` | Read a note or a specific section by heading |
| `bulk_read(items[])` | Read multiple files/sections in one call |
| `outline(path_or_directory?)` | Get heading structure of a file or directory |
| `frontmatter_get(path)` | Read YAML frontmatter without loading body |
| `backlinks(path)` | Find all notes that link to the given path |

### edit — Content Modification (⚠ DISABLED at config level)

The entire `markdown-vault_edit` tool is denied for this agent. Do NOT call it.
Its operations round-trip the whole file through a markdown serializer that
escapes `[[wikilinks]]` to `\[\[wikilinks]]` and rewrites `-` bullets to `*` —
see [[Markdown-Vault MCP Serializer Pitfall]].

Use these byte-preserving replacements instead:

| Task | Use |
|------|-----|
| Append/prepend/replace/delete content | native `edit` (exact-string) or `vault.update` |
| Update frontmatter | native `edit` on the YAML line, or `vault.update` |
| Delete a note | `vault.delete` |

### system — Maintenance

| Action | Purpose |
|--------|---------|
| `status()` | Server health, index stats, vault info |
| `reindex()` | Force full re-index of the vault |
| `overview()` | Read the current vault overview |
| `overview_status()` | Check if overview needs rebuilding |
| `prepare_overview()` | Gather evidence for a new overview (assisted mode) |
| `save_overview(content)` | Write a new overview (assisted mode) |

### workflow — Session State

| Action | Purpose |
|--------|---------|
| `status()` | Current workflow state |
| `transition(state)` | Move to a new state |
| `history()` | State transition log |
| `reset()` | Reset workflow to initial state |

## Search Strategy Cheat Sheet

| User says | Search strategy |
|-----------|----------------|
| "What's my backup procedure?" | `semantic_search("backup procedure")` + `global_search("backup")` in parallel |
| "Find notes about Docker" | `global_search("docker")` — exact term |
| "List my Linux notes" | `vault.list("Linux")` or `view.outline("Linux")` |
| "What links to my backup note?" | `view.backlinks("Backup and Recovery.md")` |
| "What's in the AI folder?" | `vault.list("AI")` then `bulk_read` |
| "Tell me about my router setup" | `semantic_search("router setup")` + `global_search("router")` |
| "Remember to update certs in March" | Go to Stage 5 — append to relevant note |
| User shares a config detail or fix | Go to Stage 5 — create or append to the topic's note |
| "I just set up XYZ with this config..." | Proactively save as a new note or section |
