---
name: architecture-reference
description: Reference map of which plugin, hook, agent, or MCP tool implements each Nibble feature, its sysop-config.yaml block, and where logs and state files live. Use when debugging hook behavior, changing sysop-config.yaml, or asking where an audit/retrieval/decision log or state file is.
---

# What Runs Where

| Piece | Plugin / Agent | Config block |
| ----- | -------------- | ------------ |
| Per-turn retrieval gate | `retrieval-hook.ts` | `retrieval:` + `decisions:` + `paths:` |
| Turn capture + consolidation | `knowledge-hook.ts` | `knowledge:` + `decisions:` + `paths:` |
| Backlog action queue + derived view | `knowledge-hook.ts` (drain fallback) + `lib/backlog.ts` | `backlog:` + `paths:` |
| Profile injection + idle updates | `profile-hook.ts` (spawns `profile-writer`) | `profile:` + `decisions:` + `paths:` |
| Web fetch/search (injection-scanned) | `web-scan-hook.ts` + `safe-browser` agent | `browser:` + `paths:` |
| Vault read (hybrid BM25 + embeddings + rerank) | `markdown-vault` MCP (pinned fork cloned by `setup.sh` at `MCP_SHA` into `.opencode/mcp/markdown-vault/`, spawned via `node .opencode/mcp/markdown-vault/dist/index.js` from the project root; Ollama embeddings + cross-encoder rerank) | `VAULT_PATH` in `opencode.json` |
| Recent-turn search | `temporal_search` tool (knowledge-hook) | `knowledge:` |
| Retrieval decisions | `lib/decision-gate.ts` → `lib/decisions.ts` → `openjev` provider | `decisions:` |
| Audit trail (every `bash` command) | `audit-hook.ts` + `lib/audit.ts` | `audit:` + `paths:` |
| Delegation usage ledgers | `telemetry-hook.ts` + `lib/telemetry.ts` (+ `web-scan-hook.ts` for inner fetches) | `telemetry:` + `paths:` |
| Heartbeat scheduler + per-tick ledger (`<log>/heartbeat.log`, `heartbeat.lock`, `heartbeat.json`) | `heartbeat-hook.ts` → `lib/heartbeat.ts` | `heartbeat:` + `autonomy:` + `paths:` |

All hooks read `.opencode/sysop-config.yaml` live (no restart needed for most
toggles). Decision-provider failures are fail-open (retrieval) or
fail-open-to-rules (knowledge drain) — the system degrades, it does not stop.

**Audit trail.** Every `bash` command runs through `audit-hook`, which appends
a redacted NDJSON entry (command, exit code, root/sandbox/dry flags) to
`.opencode/logs/audit.log` on `tool.execute.after` — deterministic, no LLM, no
manual step. Rotation, compression, and retention come from the `audit:` block.

**Project-local roots.** Nothing is written outside the project: channel logs
(audit, telemetry, retrieval, decisions, web-scan, profile, heartbeat,
diagnostics) live
under `.opencode/logs/`, and transient state (memory buffer, tag index, backlog
queue, per-hook state JSON) under `.opencode/state/`. Both are gitignored, so two
projects on one machine never share an audit trail or a state file.

**Error / troubleshooting logging.**

- `.opencode/logs/diagnostics.log` — every hook's `createDiagnostics()` bridge:
  one NDJSON line per `error`/`warn`/`info` with `{ts, event:"diagnostic",
  level, msg, hook, errName, stack, code, cause}` (stacks truncated ~2KB).
  A process-level `uncaughtException`/`unhandledRejection` handler (log-only)
  is installed with the first `createDiagnostics()` call.
- `.opencode/logs/logging-fallback.log` — persisted log-write failures
  (rate-limited ≤5/min), so a broken channel still leaves a trail even when
  the console scrollback is gone.
- Shared engine errors (`lib/logfile.ts`) are phase-tagged
  (`rotate`/`compress`/`retention`/`marker`/`append`/`unlink`/`rename`) on the
  channel's `onError`; a throwing `onError` is surfaced to the console
  (double fault), never swallowed.
- Heartbeat tick errors: failing ticks record
  `error: {phase ∈ pre-gate|digest|dispatch|mission|post, name, message,
  stack, code}` on the `heartbeat.log` tick line (`heartbeatErrorFields()` in
  `lib/heartbeat.ts`); a whole-tick failure writes a best-effort
  `outcome: "error"`, `reason: "tick-error"` line instead of vanishing.
