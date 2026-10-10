---
name: architecture-reference
description: Reference map of which plugin, hook, agent, or MCP tool implements each Nibble feature, its sysop-config.yaml block, and where logs and state files live. Use when debugging hook behavior, changing sysop-config.yaml, or asking where an audit/retrieval/decision log or state file is.
---

# What Runs Where

| Piece | Plugin / Agent | Config block |
| ----- | -------------- | ------------ |
| Per-turn retrieval gate | `retrieval-hook.ts` | `retrieval:` + `decisions:` + `paths:` |
| Turn capture + consolidation | `knowledge-hook.ts` | `knowledge:` + `decisions:` + `paths:` |
| Profile injection + idle updates | `profile-hook.ts` (spawns `profile-writer`) | `profile:` + `decisions:` + `paths:` |
| Web fetch/search (injection-scanned) | `web-scan-hook.ts` + `safe-browser` agent | `browser:` + `paths:` |
| Vault read (hybrid BM25 + embeddings + rerank) | `markdown-vault` MCP (pinned fork cloned by `setup.sh` at `MCP_SHA` into `.opencode/mcp/markdown-vault/`, spawned via `node .opencode/mcp/markdown-vault/dist/index.js` from the project root; Ollama embeddings + cross-encoder rerank) | `VAULT_PATH` in `opencode.json` |
| Recent-turn search | `temporal_search` tool (knowledge-hook) | `knowledge:` |
| Retrieval decisions | `lib/decision-gate.ts` → `lib/decisions.ts` → `openjev` provider | `decisions:` |
| Audit trail (every `bash` command) | `audit-hook.ts` + `lib/audit.ts` | `audit:` + `paths:` |
| Delegation usage ledgers | `telemetry-hook.ts` + `lib/telemetry.ts` (+ `web-scan-hook.ts` for inner fetches) | `telemetry:` + `paths:` |

All hooks read `.opencode/sysop-config.yaml` live (no restart needed for most
toggles). Decision-provider failures are fail-open (retrieval) or
fail-open-to-rules (knowledge drain) — the system degrades, it does not stop.

**Audit trail.** Every `bash` command runs through `audit-hook`, which appends
a redacted NDJSON entry (command, exit code, root/sandbox/dry flags) to
`.opencode/logs/audit.log` on `tool.execute.after` — deterministic, no LLM, no
manual step. Rotation, compression, and retention come from the `audit:` block.

**Project-local roots.** Nothing is written outside the project: channel logs
(audit, telemetry, retrieval, decisions, web-scan, profile, diagnostics) live
under `.opencode/logs/`, and transient state (memory buffer, tag index, per-hook
state JSON) under `.opencode/state/`. Both are gitignored, so two projects on
one machine never share an audit trail or a state file.
