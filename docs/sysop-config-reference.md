# sysop-config.yaml reference

Authoritative description of every key, block, and optional (unset) setting in
the Nibble harness configuration. The YAML files themselves carry only short
indicator comments (≤ 3 lines per block) — the prose lives here.

| File | Role |
| ---- | ---- |
| `.opencode/sysop-config.yaml` | Live local config, **gitignored**. Your values. |
| `.opencode/sysop-config.example.yaml` | Tracked safe-to-share template. `setup.sh` copies it to the live file on first run. |
| `.opencode/decision-prompts.yaml` | JEV question texts, pointed at by `retrieval.prompts_file` / `decisions`. |
| `.opencode/profile-prompts.json` | Profile choice criteria + reviewer assertion, pointed at by `profile.prompts_file`. |

Every hook reads the config **live** — most toggles take effect without a
restart. Exceptions are called out per block below (`browser:` and the autonomy
config warn-once behaviour).

---

## Readers map

| Config block | Read by |
| ------------ | ------- |
| `paths:` | every reader below (via `lib/paths.ts`), plus `scoped-permissions.ts` |
| `vault:` | `vault-readonly-guard.ts`, `wikilink-guard.ts` |
| `audit:` | `audit-hook.ts` → `lib/audit.ts` |
| `drain:` | `heartbeat-hook.ts` / `dream-hook.ts` → `lib/drain/*` (drain-pipe); `lib/heartbeat.ts` (candidacy) |
| `memory:` | `lib/memory/*` — `retrieval-hook.ts`, `memory-hook.ts`, `memory-guard.ts`, `heartbeat-hook.ts`, `dream-hook.ts`, `lib/heartbeat.ts`, `lib/drain/pipe.ts` |
| `backlog:` | `heartbeat-hook.ts` / `dream-hook.ts` (mission + drain-fallback records) → `lib/backlog.ts` |
| `decisions:` | `lib/decisions.ts` + `lib/decision-gate.ts`, loaded by the retrieval / profile hooks and the drain config reader, by `autonomy-gate.ts`, and by `heartbeat-hook.ts` (**hard dependency** — no JEV, no mission dispatch) |
| `retrieval:` | `retrieval-hook.ts` → `lib/retrieval.ts` |
| `browser:` | `web-scan-hook.ts` → `lib/browser.ts` (scanner: `lib/injection.ts`) |
| `profile:` | `profile-hook.ts` (spawns `profile-writer`) |
| `telemetry:` | `telemetry-hook.ts` → `lib/telemetry.ts`; also `web-scan-hook.ts` for inner fetches |
| `autonomy:` | `lib/autonomy.ts` + `autonomy-gate.ts` |
| `mood:` | `mood-hook.ts` → `lib/mood.ts` |
| `heartbeat:` | `heartbeat-hook.ts` → `lib/heartbeat.ts` (in-process scheduler + per-tick ledger) |
| `idea:` | `heartbeat-hook.ts` → `lib/idea.ts` (day draw, dedupe/review/append, express gap) |
| `soul:` | `soul-hook.ts` (spawns `self-writer`) |
| `comms:` | `lib/autonomy.ts` (config plumbing only) |
| `dashboard:` | `lib/autonomy.ts` (config plumbing only) |

Sections a reader does not know about are ignored by it.

---

## Shared conventions

### `paths:` — canonical path roots

The **only** place the vault and log directory names live. Every other path in
the config is a **leaf** stored relative to one of these roots; absolute paths
and `~/` paths are honored as overrides.

| Key | Resolves against | Holds |
| --- | ---------------- | ----- |
| `vault:` | repo root | the Obsidian vault, e.g. `<repo>/Brain` |
| `diagrams:` | repo root | diagram-developer write scope |
| `log:` | repo root | every NDJSON channel log (audit, telemetry, hook ledgers) — gitignored |
| `state:` | repo root | project-local transient state: drain cursor, hook state JSON — gitignored |

Everything is project-scoped; there is no home-wide directory, so two projects
on one machine never share an audit trail or a state file.

### Log keys — the shared logging engine

All structured hook logs are written through `lib/logfile.ts` + `lib/logging.ts`.
Each block configures one normalized shape. Blocks that already have a `log_`
prefix on their keys use `log_*`; blocks following the `audit:` pattern use the
**bare** keys.

| Key | Meaning |
| --- | ------- |
| `rotate_bytes` | size trigger in bytes; `<= 0` disables rotation |
| `keep_generations` | rotated generations kept (`log.1` .. `log.N`), shift-and-rename |
| `retention_days` | delete rotated files older than this; `<= 0` disables |
| `compress` | gzip rotated generations |
| `compress_after` | newest N rotated generations stay uncompressed |
| `compress_level` | zlib level 1–9 |
| `rotate_by` | `size` \| `daily` \| `weekly` (UTC) |

---

## `vault:`

| Key | Meaning |
| --- | ------- |
| `readonly` | Comma-separated, vault-relative folder names that are **agent-forbidden, user-write-only**. |

The agent may **read** these folders but must never create, update, or delete
inside them — the user owns the content and edits it in Obsidian. Enforced
deterministically at the tool boundary by `vault-readonly-guard.ts` (native
edit/write/apply_patch plus the markdown-vault MCP `vault` tool), and honored by
`wikilink-guard.ts`, whose repair/idle sweeps skip these folders.

---

## `audit:`

L5 audit trail. Every `bash` command the agents execute is appended on
`tool.execute.after` — deterministic, no LLM — after secret redaction
(`lib/audit.ts` `redact`). An entry carries the command, exit code, timestamp,
and root/sandbox/dry flags.

| Key | Notes |
| --- | ----- |
| `log` | leaf under `<log>` → `.opencode/logs/audit.log` |
| `rotate_bytes` | 10 MB default in the example |
| `keep_generations` | `audit.log.1` .. `audit.log.N` |
| rotation keys | **bare** keys (no `log_` prefix) |

---

## `drain:`

Cursor-backed conversation consolidation (`lib/drain/*`, design:
`docs/knowledge-pipeline-redesign.md`). The drain mission discovers top-level
sessions newer than the cursor, renders and summarizes each delta, and hands
labelled `#1..N` items to `rag-brain`. The writer reports a
`consolidated`/`skipped` fence; the cursor advances only when every item is
reported exactly once.

| Key | Meaning |
| --- | ------- |
| `enabled` | Master switch for the runner (`false` = the mission is a no-op). |
| `cursor_file` | Leaf under `<state>` → `.opencode/state/drain-cursor.json`. Holds the activity-time cursor (`last_ts`), the blocked counter, and per-session continuity summaries. |
| `writer_model` | `rag-brain` writer model; `""` = the agent default. |
| `summarize_model` | `session-summarizer` model; `""` = the agent default. |
| `batch_sessions` | Max top-level sessions per run. |
| `initial_lookback_hours` | Fresh-cursor start: only consolidate sessions active in the last N hours (`0` = whole history). |
| `max_turns_per_session` | Cap on fetched text parts per session. |
| `max_session_bytes` | Rendered-delta byte cap; `0` = unlimited. |
| `max_items_per_session` | Cap on summarizer output items. |
| `max_items_per_batch` | Items handed to one writer spawn; larger batches are chunked (default 8). |
| `prefetch_candidates` | Candidate notes scored deterministically per batch. |
| `continuity_turns` | Reserved for continuity tuning (currently unused). |
| `continuity_sessions` | Prior per-session summaries kept for long-lived sessions. |
| `poison_attempts` | Failed runs at one boundary before the batch is dropped (`0` = never). |
| `drain_prompt_max_bytes` | Consolidation-prompt byte cap; candidates are dropped first, then summaries are shortened. |

The cursor is **activity time**, never an id. A partial, duplicate, or unknown
writer report blocks the advance; after `poison_attempts` the pipe advances
past the batch and records a `dropped` run.

---

## `memory:`

One active, toggleable memory provider (`lib/memory/*`, design:
`docs/knowledge-memory-modularization.md`). Retrieval, drain, heartbeat
candidacy, the `memory_search` tool, and the dynamic guard all talk to this
provider instead of naming `rag-search` / `rag-brain` / `memory-explorer`.

| Key | Meaning |
| --- | ------- |
| `provider` | `both` (default) \| `rag-brain` \| `memory-explorer` \| `none`. One active provider at a time. |

- `both` — Brain read (`rag-search`) + drain write (`rag-brain`) + the
  un-consolidated recency lane (`memory-explorer`).
- `rag-brain` — Brain read + drain write; no recency lane, no `memory_search`.
- `memory-explorer` — un-consolidated read only; no consolidation writer.
- `none` — complete disable: the retrieval hook injects a SKIP that forbids
  every memory agent, the drain pipe returns `nothing` before opening the DB,
  no tool is registered, and `memory-guard` blocks manual `task` delegation to
  `rag-search`/`rag-brain`/`memory-explorer`.

An unknown value fails closed to `none` and warns once. `retrieval-hook` and
`memory-hook` read the provider at init (restart opencode after changing it);
the drain, heartbeat, and guard read per call. `drain.enabled` remains the
fine-grained kill switch for consolidation only.

The `staleness` and `research` missions still name `rag-search`/`rag-brain` in
their bodies. When the active provider does not own those agents, the
`memory-guard` hook blocks the call; skip the mission for that run rather than
retrying.

---

## `backlog:`

Machine-readable action queue (plan §5). Canonical store at
`<state>/backlog.ndjson` — one JSON object per line. The derived human view at
`<vault>/Backlog.md` is regenerated one-way from it and must never be
hand-edited. Owned by `lib/backlog.ts`; producers are the heartbeat/dream mission
runs.

| Key | Meaning |
| --- | ------- |
| `file` | leaf under `<state>` → `.opencode/state/backlog.ndjson`. |
| `view_file` | leaf under `<vault>` → `Brain/Backlog.md`. |
| `dedupe` | skip appending a duplicate OPEN entry (matched on source + title). |
| `max_view` | max entries rendered per status section in the view. |

---

## `decisions:`

Typed-decision "System 1" provider (JEV).

**Backend.** `.opencode/scripts/openjevserver.py` + `decisions_bridge.py`, a
stateless stdin/stdout subprocess. The TypeScript side (`lib/decisions.ts`,
loaded by retrieval-hook, profile-hook, `heartbeat-hook.ts`
and the autonomy-gate plugin through `lib/decision-gate.ts`) reads this block
live.

> **Disclaimer — the heartbeat mission system is directly dependent on this
> module.** The JEV digest choice is the only path that can dispatch a mission;
> with `enabled: false` the heartbeat keeps ticking and journaling
> (`reason: decisions-disabled`, `token_cost: 0`) but never runs one. A
> `rules` provider still counts as enabled — it is the model-backed
> `openjev` that is optional, not the gate itself.

**Modes.**

| `mode` | Behaviour |
| ------ | --------- |
| `shadow` | verdicts are recorded to the ledger, never gate. |
| `gate` | retrieval-hook suppresses a turn's Brain-First search when judged self-contained; the profile/soul idle gates apply/withhold their updates. |

Fail-open / fail-closed semantics are per-hook — see the `retrieval:` block.

**Providers.**

| `provider` | Notes |
| ---------- | ----- |
| `rules` (default in the template) | deterministic TypeScript heuristics, no external process, works out of the box. |
| `openjev` | model-backed. Pick a model from `opencode models`; endpoint and API key are resolved from opencode's own `models.json` / `auth.json`, so no `base_url` / `api_key_file` is needed. `setup.sh` prompts for the model. |

### Optional keys (not set by default)

`model` is the only provider setting needed in the common case. The provider id
is the prefix before the first `/` in `model`.

| Key | Meaning |
| --- | ------- |
| `api_provider` | provider id when `model` has no `<provider>/` prefix. |
| `backend` | `llamacpp` forces the local llama.cpp backend; `ollama` uses Ollama native `/api/chat` first-token logprobs; `clef` uses Ollama's System One decision API (`/v1/systemone`) with a Clef decision model. |
| `base_url` | pin an endpoint (no `/v1` suffix). Default `http://127.0.0.1:11434` for Ollama. |
| `transport` | `chat` \| `completion` (llama.cpp only). |
| `api_key_file` | chmod-600 key file instead of opencode `auth.json`. |
| `auth_file` | override path to opencode `auth.json`. |
| `models_file` | override path to opencode `models.json`. |

**Local backends** (`setup.sh` options 3/4; `model` is the bare Ollama tag):

- `backend: ollama` — first-token logprobs from Ollama's native `/api/chat`. Use
  a small instruct model (e.g. `qwen2.5:3b`). `think: false` (the default) is
  required: a thinking model burns the only sampled token on its reasoning
  trace.
- `backend: clef` — Ollama's System One decision API with a Clef decision model
  (`setup.sh` creates the lean `clef-flash-2k` variant). Answers arrive as
  native per-option probabilities — the calibrated choice, ~0.2–0.6 s local.

### Tuning keys

| Key | Meaning |
| --- | ------- |
| `temperature_scaling` | must stay `1.0`. Identity for `clef` (native probabilities); for the self-reported confidence tiers it is a no-op because they are uncalibrated. |
| `abstain_threshold` | below this confidence the provider abstains. |
| `noul_threshold` | gates skip only when model `p >=` this. |
| `timeout_ms` | per-call subprocess timeout. |
| `n_probs` | candidate token depth (unused by the structured tier). |
| `structured_max_tokens` | JSON-mode output budget for openjev. Must cover the reasoning trace **and** the answer — a smaller cap starves reasoning models (empty content → abstain). |
| `fallback` | on error / abstain / timeout → deterministic `rules`. |
| `ledger` | shadow ledger, one NDJSON line per decision, leaf under `<log>`. |

---

## `retrieval:`

Per-turn "self-RAG" retrieval gate (`retrieval-hook.ts`). On **every** user turn
a `noul` decision asks whether the message is self-contained and needs no vault
search.

**This gate is FAIL-CLOSED**, unlike the drain gate: an error, a timeout, or an
abstain means NO retrieval (economy-first). The prose prior (the assertion in
`prompts_file`) is deliberately weighted toward "do not retrieve" unless the
message clearly refers to stored knowledge.

| `gate` | Behaviour |
| ------ | --------- |
| `true` | a confident skip suppresses the Brain-First `rag-search` for that turn and injects an authoritative `[brain-first]` block. |
| `false` | shadow mode: verdicts are logged, but every turn retrieves. |

Explicit retrieval intent ("search my notes", "do you remember…") always wins
over the model when `force_intent` is true, protecting accuracy where it counts.

| Key | Meaning |
| --- | ------- |
| `noul_threshold` | skip only when model `p("no retrieval needed") >=` this. |
| `timeout_ms` | per-turn decision subprocess timeout. |
| `max_bytes` | only the head of the user message is judged. |
| `summary_words` | target length of the rag-search content synthesis (answer-first). |
| `force_intent` | deterministic explicit-intent override → retrieve. |
| `inject` | push the `[brain-first]` directive into the system prompt. |
| `prompts_file` | JEV question texts (`retrieval.assertion`); `~`/absolute honored. |
| `log` | per-turn NDJSON ledger, one line per decision with the eventual gate action, leaf under `<log>`. |

---

## `browser:`

Deterministic web injection scan for `webfetch`/`websearch` (`web-scan-hook`).

**Read once at plugin startup — changing these values takes effect on restart.**
The scanner itself is `lib/injection.ts` (shared with the future mail hook);
`lib/browser.ts` owns this block plus the web-specific policy transform.

| Key | Meaning |
| --- | ------- |
| `injection_policy` | `flag` = annotate + fence; `block` = additionally withhold instruction-family hits. |
| `max_scan_bytes` | cap on bytes scanned per tool result (larger output is scanned only up to this head). |
| `scan_log` | full scan findings (family/severity/snippet) go here, **not** into the agent's context. Leaf under `<log>`. |

---

## `profile:`

Persona + user context as prompt-style instructions (`profile-hook.ts`). Two
jobs, both gated by `enabled`.

**1. `inject`** — on the first turn of each top-level session, the two vault
instruction notes (`agent_file`, `user_file`) are appended to the system prompt
as directives: agent persona/behavior + user working context. Injected
throughout the first turn, then cached/disabled until the session ends.
`inject_max_bytes` is the per-note cap (frontmatter/Related already stripped).
`refresh_every_turns` re-injects the full block every N turns to fight persona
fade; it is rebuilt from disk, `0` disables.

**2. `decide`** — at `session.idle`, a JEV `choice` decision (profile-hook →
`lib/decision-gate.ts` → `lib/decisions.ts`) asks whether the latest turn
carries durable new info for either profile note. Only a confident,
non-fallback verdict that **names** a note triggers an update; the update body
is drafted by a short-lived `profile-writer` child (small model) and written
directly by the plugin (atomic rename). **Fail-open:** a fallback/abstain never
writes.

| Key | Meaning |
| --- | ------- |
| `cooldown_turns` | min top-level idle turns between profile decisions. |
| `decision_turns` | last N session turns handed to the decision + writer. |
| `decision_max_bytes` | cap on that transcript. |
| `skip_triage` / `skip_triage_max_bytes` | skip the decision on trivial-chatter turns. |
| `writer_agent` | generation child, see `.opencode/agents/profile-writer.md`. |
| `writer_model` *(optional)* | profile-writer child model; when omitted the writer agent's own default model applies. |
| `child_timeout_ms` | max wait for the writer child to reply. |
| `note_max_bytes` | writer hard budget; a draft above this is rejected (the note is injected, so it must stay lean). |
| `prompts_file` | choice instructions/criteria + reviewer assertion (JSON), so update frequency and precision are tunable without touching TypeScript. Project-relative; `~` or absolute honored. |
| `review` | post-draft durability/globalness gate before write. |
| `review_threshold` | `noul` pTrue needed to accept a drafted update. |

### Visibility log

`log` is an NDJSON log with one line per event:

- Below-threshold turns log `profile-cooldown`.
- A pass that clears the gate emits one terminal `profile-pass` line whose
  `result` answers "did it update?":

  `updated` / `no-op` / `no-update` / `update-failed` / `prefilter-skip` /
  `no-transcript` / `decision-fallback` / `decision-abstain`

- Every event from one pass shares a `pass` id (`p<N>`), so a full pass can be
  grouped.

Human view:

```sh
jq -c 'select(.event=="profile-pass")' .opencode/logs/profile-hook.log
```

### Reviewer

After the writer drafts a note, a second JEV `noul` gate (`review`) checks the
additions are **durable** and **globally applicable**, rejecting
session-specific or one-off task decisions before any write; a date-only draft
is a `no-op`.

---

## `telemetry:`

Retrieval/comms usage telemetry (`telemetry-hook.ts` + `lib/telemetry.ts`; also
read by `web-scan-hook.ts`). Deterministic NDJSON usage records for the
expensive delegation paths. **Contract: logging only, zero behavior change, no
LLM, no prompt text or full URLs in the ledger.**

| Source | Ledger | Event |
| ------ | ------ | ----- |
| `rag-search` delegations | `brain_log` | one line per Brain-First turn |
| browser delegations | `web_log` | `web-task` |
| inner `webfetch`/`websearch` | `web_log` | `web-fetch` |

Both channels share one rotation policy via the **bare** keys (the `audit:`
pattern). Leaves are relative to `<log>`; absolute or `~` paths are honored.

| Key | Meaning |
| --- | ------- |
| `watch_agents` | comma-separated `task` delegates that are measured. |

---

## `autonomy:`

Autonomy harness config plumbing (`docs/autonomy-harness-plan.md` §11). The
autonomy-gate plugin reads `level` + `gate_mode` + `gate_scope` **hot on every
turn** and enforces the level matrix at `tool.execute.before`; the JEV
borderline escalation also reads `decisions:` and
`.opencode/decision-prompts.yaml`.

**Every value is hot-read per call** — flipping one takes effect immediately,
no restart. An invalid value falls back to its code default and warns once per
process in `<log>/autonomy-config.log` (NDJSON).

| Key | Meaning |
| --- | ------- |
| `level` | 0..4 capability dial (§4.1); code default 1. |
| `gate_mode` | `shadow` logs without blocking; `gate` enforces. Kill switch. |
| `gate_scope` | `main` = Task sub-agents face only the floor; `all` = gate everyone. |
| `heartbeat.frequency` | `off` \| `<n>m` \| `<n>h` — manual only (§4.2). |
| `heartbeat.in_progress_lock` | hold heartbeats while work is in flight. |
| `mission_token_budget` | K-tokens per mission turn, or `unlimited` (§6.4). |
| `root_classes` | L4 root allowlist; the irreversibility floor applies first. |
| `class_overrides` | `kind:name:class` triples mapping external tools/sub-agents into the level matrix; `tool:` names may end in `*` (prefix glob). |
| `batch.max_actions` | grant budget per confirmed `autonomy-batch` manifest; `0` = one-shot approvals only. |
| `session_grant` | `off` \| `target` \| `class` — session-wide approval on "allow session". The floor, root, and self-improve actions are never covered. |
| `session_grant_ttl` | minutes until a session grant expires; `0` = session lifetime (cleared on restart). |
| `enforcement` | `per-command` \| `per-task` (default): ONE JEV task classification per user turn, the agent asks to proceed, opencode natively governs the commands (the floor still applies). |

### `class_overrides` classes

`pure-read`, `readonly-bash`, `vault-write`, `project-write`, `subagent-read`,
`subagent-web`, `subagent-web-deep`, `subagent-write`, `destructive`, `root`,
`self-improve`, `borderline`. Anything **not** listed stays outside the schema.

Example: `[tool:my-mcp_*:vault-write, subagent:my-agent:subagent-write]`

### `chatter:` — idle chatter mission (§16)

Off until card 7b.

| Key | Meaning |
| --- | ------- |
| `max_pokes` | max pokes per conversation. |
| `daily_budget` | conversation openers per day. |
| `cooldown` | gap between conversations. |
| `reply_window` | await window before JEV poke/close triage. |

### `quiet:` — quiet-hours dream system (§17.9)

Nested under `autonomy:`, **not** top-level.

| Key | Meaning |
| --- | ------- |
| `window` | the `isQuietNow()` predicate source. |
| `dream_cadence` | how often a dream tick is considered. |
| `resume_cooldown` | woken → dreaming after this much silence. |
| `dream_chance` | pre-JEV roll for the dream candidate. |
| `dream_token_budget` | hard per-tick cap (K tokens). |
| `nightly_dream_cap` | max dreams per night. |
| `backoff` | 30 → 60 → 120 m on consecutive no-ops. |

The night menu is **per-mission `menus:` frontmatter** (`.opencode/missions/*.md`)
only — `dream_missions` was removed with the mission loader (missions-plan §5,
D-M4). Shipped set after dark: `drain` + `dream` (card 6).

### `missions:` — restrict-only mission overlay (missions-plan §6)

Nested under `autonomy:`, one block per mission id (`.opencode/missions/<id>.md`).
Config may only RESTRICT what the mission file declares (D-M5):

| Key | Rule |
| --- | ---- |
| `enabled` | `false` always honoured; `true` can never re-enable a file-disabled mission. |
| `min_level` | may only be **raised** above the file's value; lower → rejected + logged, file stands. |
| `frequency` | may only move toward `low` (rarer); higher → rejected + logged, file stands. |
| `menus` | may only be **narrowed**; adding a window → rejected + logged, file stands. |

Rejected keys are logged once per process to `<log>/autonomy-config.log`.

---

## `heartbeat:`

In-process scheduler + per-tick outcome ledger (`heartbeat-hook.ts`,
missions-plan §7/§12 — cards D+E). Distinct from the nested
`autonomy.heartbeat:` dial (frequency / in-progress lock) — `extractBlock`
anchors at column 0, so the two never collide.

| Key | Meaning |
| --- | ------- |
| `enabled` | kill switch. `false` → the loop sleeps on the 60 s wake cap (hot; no restart). Also parks the dream timer — one lock, one engine (card G shares `heartbeat.lock` and this switch). |
| `long_silence_factor` | a tick whose gap since the previous tick is ≥ factor × frequency feeds the `long_silence` mood event; `0` disables the feed. |
| `log` | NDJSON ledger leaf under `<log>` — one line per tick: `ts, tick, digest_hash, level, quiet, candidates, bias, verdict, mission, outcome, token_cost, mood_event` (+ `gate`/`reason` disambiguating every `no_reply`). The dream timer journals `event: "dream-tick"`, `source: "dream"` lines here too (card G, plan §17.8). |
| `log_*` | shared rotation keys (`rotate_bytes`, `keep_generations`, `retention_days`, `compress`, `compress_after`, `compress_level`, `rotate_by`) — same shape as `audit:`. Read once at plugin init. |

Behavioural dials (`enabled`, `long_silence_factor`) are hot-read on every
tick. A mission run also appends `source: "heartbeat"` to `<state>/backlog.ndjson`
with `result.token_cost` filled and refreshes the derived view one-way.
B7 day-side backoff (missions-plan §7): consecutive `no_reply` ticks on an
identical `digest_hash` stretch the day cadence ×2 at streak 2 and ×4 at 3+
(`noop_hash`/`noop_streak` in `<state>/heartbeat.json`); a mission execution or
a changed digest resets it — the day twin of the `quiet.backoff` ladder.

---

## `idea:`

Idea generation/expression pipeline (`heartbeat-hook.ts` → `lib/idea.ts`,
plan §17.10 / D18 — card 7a). The old idea-hook scheduler does not exist in
Nibble: generation and expression are heartbeat missions, and this hook owns
the deterministic half (day draw, bucket write, gap store).

| Key | Meaning |
| --- | ------- |
| `enabled` | pipeline kill switch. `false` → no day draw (`idea-roll` fails closed), no post-run processing; the express gap store stays empty. |
| `bucket_file` | bucket note leaf under `<vault>` (absolute honored). Default `Kael Ideas.md`. |
| `daily_weights` | day-rollover draw: the index IS the day's idea count (`"25,55,20"` → 0/1/2 with 25/55/20%). Feeds the `idea-roll` candidacy target. |
| `category_weights` | per-dispatch category draw (improve-self, thought, business); injected into the brief as `=== REQUESTED CATEGORY ===`. |
| `dedupe_threshold` | keyword-Jaccard reject vs. existing bucket bodies (0..1). |
| `review` | JEV `noul` review before the bucket write. Fail-closed: gate missing, fallback, abstain, or sub-threshold `pTrue` all reject. |
| `review_threshold` | acceptance threshold on the reviewer's `pTrue` (0..1). |
| `express_min_gap_hours` | the `min-gap:express` candidacy gap; `lastExpressedAt` lives in `<state>/idea.json` (stamped after a completed express run). |
| `log` | NDJSON event leaf under `<log>` — `idea-generated`, `idea-review`, `idea-skipped`, `idea-review-reject`. `log_*` = shared rotation keys, read once at init. |

Behavioural dials are hot-read on every tick. Day rollover persists only on a
real day change; the mission ledger line gains an `idea:` tag
(`stored` / `duplicate` / `review-reject` / `no-block` / `expressed` / `error`).
The express mission ships `enabled: false` until the comms card (10) lands.

---

## `mood:`

Feeling system (`lib/mood.ts`, §15).

| Key | Meaning |
| --- | ------- |
| `dispatch_influence` | bounded + ledger-journaled; `false` = expression only. |
| `decay_half_life` | exponential decay toward baseline. |

Hard rule: mood colours tone and selection only. It never touches the autonomy
gate, the security locks, the irreversibility floor, or approval logic.

---

## `soul:`

First-person identity + journal (`soul-hook`, spawns `self-writer`).

| Key | Meaning |
| --- | ------- |
| `soul_file` | leaf under `<vault>` (absolute paths honored). |
| `journal_file` | leaf under `<vault>`. |
| `inject` | first-turn `[soul]` injection: identity + journal tail. |
| `inject_max_bytes` | shares the profile injection budget philosophy. |
| `decide` | idle JEV `noul` fold-down decision. |
| `cooldown_turns` | min top-level idle turns between soul fold-downs. |
| `journal_tail_bytes` | recent journal bytes handed to the self-writer. |
| `writer_agent` | generation child, see `.opencode/agents/self-writer.md`. |
| `note_max_bytes` | `Soul.md` hard budget. |
| `review` | post-draft honesty/durability gate before write. |
| `review_threshold` | `noul` pTrue needed to accept a drafted note. |

---

## `comms:`

Notification/approval channels (§7).

| Key | Meaning |
| --- | ------- |
| `default_channel` | `telegram` \| `email`. |
| `session_ttl` | lazy chat-session expiry (D15). |
| `telegram.enabled` | M5 not ported yet; card 10 turns this on. |
| `telegram.bot_token_file` | chmod-600 credential file — **never inline the secret**. |
| `telegram.chat_id_file` | chmod-600 credential file. |
| `email.enabled` | M5 not ported yet; card 10 turns this on. |
| `email.account` | himalaya account name. |
| `email.reply_window_hours` | how long a reply is awaited. |

---

## `dashboard:`

Local web UI (§9), read by cards 8/11.

| Key | Meaning |
| --- | ------- |
| `bind_address` | loopback only. |
| `auth.mode` | `off` \| `login` \| `login+2fa` (§10). |
| `auth.require_tls` | TLS requirement for the dashboard. |
