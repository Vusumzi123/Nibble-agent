# Changelog

Notable changes to Nibble, newest first. Sections follow
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions
(`Added` / `Changed` / `Fixed` / `Removed`).

## 2026-10-09

### Changed

- **AGENTS.md compressed + skills split** — always-loaded instructions cut
  from 302 lines (15.4 KB) to 114 lines (6.0 KB) by moving task-scoped
  procedures into on-demand Agent Skills (`.opencode/skills/<name>/SKILL.md`,
  auto-discovered; body loads only via the `skill` tool) and by making the
  hooks own what they inject:
  - `os-security` — root-need checklist, pkexec→kdialog→zenity→askpass
    escalation ladder, dry-run→confirm→live workflow, worked example
    (former AGENTS.md §7 ladder + §8 workflow/example).
  - `architecture-reference` — plugin/hook/agent ↔ config-block map, audit
    format, project-local logs/state layout (former §5).
  - `web-delegation` — safe-browser briefing rules and scan-log layout
    (former §3 detail).
  - AGENTS.md keeps only the always-on invariants (NEVER-rules, L1–L7 locks
    table) plus a skill index (§7); the whole former §0 Brain-First block is
    gone — the directive is self-describing ("authoritative for this turn"
    + template + result handling inline), explicit vault queries stay in §1,
    and with the hook disabled auto-retrieval should be off anyway; the §0
    delegation template, budget, and result-handling rules now ride inside
    the injected `[brain-first: RETRIEVE]` directive itself
    (`lib/retrieval.ts buildRetrievalDirective`) — paid only on search
    turns; the per-search limits stay enforced by `rag-search.md`'s hard
    rules; the `[profile]` block already carries its own usage line
    (`lib/profile.ts`); `safe-browser`
    moved into the §2 delegation table; §3 web-browsing section and the
    root-need checklist dropped (checklist lives in `os-security`); old
    §7/§8 merged into a single §6 "OS Security — Escalation & Locks";
    sections renumbered; README pointer updated.

## 2026-10-08

### Added

- **Autonomy gate (kanban card 2, plan §4.1/§4.3)** — the autonomy dial is
  live. New pure core `lib/autonomy-gate.ts` + runtime `plugin/autonomy-gate.ts`:
  - **`[autonomy]` prompt line** — `experimental.chat.system.transform` pushes
    `[autonomy] level N (Name) — <envelope>; irreversibility floor always
    applies`, hot-read every turn (flipping `autonomy.level` needs no restart).
  - **Level-matrix enforcement** in `tool.execute.before` — `classifyCall`
    yields allow|ask|deny per the card-2 matrix: reads pass at every level;
    read-only bash from L1; vault writes and sub-agent spawns from L2;
    project writes from L3; destructive and self-improve ask until the JEV
    edge; root at L4 iff `root_classes` match; unclassifiable = borderline.
  - **Irreversibility floor** — hard-coded deny checked *before* any
    allowlist: `mkfs*`, `dd`→block devices, `rm -rf` on system roots,
    `shred`/`wipe`, `fdisk`/`parted`/`lvremove`, and audit/permission
    tampering (`.opencode/plugin/**` audit machinery, shell mutation of
    `opencode.json`). Denied at every level, never approvable — not by a
    user confirm, not via `root_classes`.
  - **`autonomy.gate_mode: shadow|gate`** (default `gate`; invalid values
    fall back to `gate`) — the misbehaviour kill switch: `shadow` logs
    without blocking, `gate` enforces.
  - **Pending-ask approval flow** — ask records `{session, sha1 fingerprint,
    ts}` (TTL 10m, latest-only); the user's strict confirm in `chat.message`
    (`^(?:yes|y|proceed|go ahead|approve|--execute|--live)\b`) approves it;
    the exact retry then passes once. Floor verdicts never record; the store
    lives on the plugin (restart clears it — fail-closed); any other user
    text does not consume.
  - **JEV borderline escalation** — matrix `jev` rows (borderline at L1–L3,
    destructive non-floor at L4, self-improve at L4) consult
    `openDecisionGate` with fallback **closed** and an 8s overlay: error /
    abstain / timeout / decisions-disabled → ask, never allow. Criteria text
    lives in `.opencode/decision-prompts.yaml` (`autonomy:` section, built-in
    default in `lib/autonomy-gate.ts`). The user's confirm outranks the
    model and skips the JEV on the approved retry.
  - **Audit `autonomy_level`** — every bash audit line stamps the level that
    was live when the command ran (`lib/audit.ts` + `audit-hook.ts`);
    missing/legacy/out-of-range values coerce to `null`; redaction unchanged.
  - **Verdict log** — `<log>/autonomy-gate.log` (NDJSON, shared engine): one
    `verdict` line per gated call (level, tool, class, reason, fingerprint,
    mode) plus `jev` outcome lines; `automationChildSessions` bypass the gate
    entirely (their JEV gates already cover them).
  - **Dial-aware security-locks prompt** — new "Autonomy dial awareness"
    section in `agents/security-locks.md`: the brief must quote the live
    `[autonomy]` line (missing ⇒ treat as L0); L0–L2 always require the
    human `yes`, L3+ whitelisted classes skip it; floor, dry-run→live,
    self-improve L0–L3 always-asks, and mood-never-gates are restated as
    level-invariant.
  - **Interpretations recorded:** (1) *reads pass at every level, including
    L0* — deliberate reading of §4.1's literal "everything asks" as
    plan-agent-mode semantics; only state-changing actions ask at L0.
    (2) `automationChildSessions` are exempt from the gate; human sessions
    and their Task sub-agents stay gated. (3) Shell mutation of
    `opencode.json` is floor (permission-block tampering); the sanctioned
    edit-tool path on `.opencode/plugin/**` / `opencode.json` is the
    self-improve row (ask at L0–L3, JEV at L4) pending card 12's apply
    pipeline.
  - Tests: +53 across `autonomy-gate.test.ts` (floor × L0–L4, every matrix
    row × level, fingerprint, pending-ask lifecycle/TTL/one-shot, JEV
    helpers), `autonomy-gate-hook.test.ts` (prompt line, verdict log,
    enforcement, exemption, kill switch, approval flow, JEV fail-closed
    paths), `audit.test.ts` / `audit-hook.test.ts` (level coercion +
    stamping), `autonomy.test.ts` (`gate_mode` schema), and
    `decision-prompts.test.ts` (autonomy section). Suite: **382/382**.
- **Autonomy-harness config plumbing (kanban card 1, plan §11)** — four new
  `sysop-config.yaml` sections: `autonomy:` (level dial 0–4 + `heartbeat` /
  `chatter` / `quiet` sub-blocks), `mood:`, `comms:`, and `dashboard:`.
  Readers live in the new `lib/autonomy.ts` (`readAutonomyConfig`,
  `readMoodConfig`, `readCommsConfig`, `readDashboardConfig`): hot-read per
  call — flipping a value needs no restart — and never throw. Schema
  validation falls back to code defaults on invalid values (level 1 by
  default; the live config ships 2) and warns once per process in
  `<log>/autonomy-config.log` (NDJSON, shared logging engine). Nothing
  consumes the blocks yet — the gate (card 2), mood (card 5), dashboard
  (cards 8/11), and comms bridges (card 10) are the future readers.
- `lib/config.ts` nested-section support for the harness blocks:
  `parseNestedSection` / `overlayNestedSection` / `readNestedSection` handle
  flat scalars plus one level of sub-blocks, inline (`[a, b]`) and block-form
  lists, and return coercion failures as `rejects` (the flat parser keeps
  silently dropping). `parseInlineList` + `isDuration` helpers. `extractBlock`
  now tolerates a trailing comment on the section line itself
  (`mood:   # …`), which previously made the whole section unparseable.
- Tests: `lib/autonomy.test.ts` (8 cases — full §11 shape, per-section
  rejects, live-config overlay, warning-log dedupe, hot-read) plus 8
  nested-parser cases in `lib/config.test.ts`. Suite: 329/329.
- `scripts/run.sh` — recommended entry point: starts the Ollama embedding
  server if it is not already up, waits for readiness, verifies the
  `OLLAMA_MODEL` is pulled, runs `opencode "$@"`, and stops Ollama **only if
  this script started it** (a pre-existing server is left alone).
- `decisions.structured_max_tokens` (default `512`) — output budget for the
  openjev JSON tier. Reasoning models spent the old 64-token cap entirely on
  `reasoning_content`, returned an empty `content`, and the gate aborted to the
  deterministic `rules` fallback. Wired through `lib/decisions.ts` (type,
  default, validation), `openjevserver.py` (`OpenAICompatBackend`, CLI flag,
  `make_backend`) and `sysop-config.example.yaml`.
- `experimental.mcp_timeout: 60000` in `opencode.json` — the embedding + rerank
  MCP needs longer than the default handshake budget on first index.
- `CHANGELOG.md` (this file).

### Changed

- **Autonomy gate scope — `autonomy.gate_scope: main | all` (default `main`).**
  A Task sub-agent child session (parentID set) now skips every `ask` row
  under `main`: the dial drives only the top-level human session. Rationale —
  an ask in a child is unapprovable anyway (the user's confirm arrives keyed
  to the human session), so gating children produced a permanent approval
  loop. The **irreversibility floor still denies children** at every level
  (scope never weakens the floor), verdicts keep logging with `scope` +
  `child` stamps, and children get no `[autonomy]` prompt line under `main`.
  `gate_scope: all` restores the previous gate-everything behaviour; a failed
  child lookup fails closed (the session is gated). This amends the Phase 1
  interpretation that "human sessions and their Task sub-agents stay gated".
  Config is hot-read — no restart. Tests: +5; suite **387/387**.
- **The markdown-vault MCP is now a pinned fork installed by `setup.sh`
  instead of an `npx` git-spec at launch.** Step 1b clones
  `https://github.com/Vusumzi123/mcp-markdown-vault.git` (https, no SSH key)
  into `.opencode/mcp/markdown-vault/`, checks out `MCP_SHA`, and runs
  `npm ci`, which builds `dist/` through the fork's `prepare` hook (`tsc`).
  Bump the pin by editing `MCP_SHA` in `scripts/setup.sh` and re-running it;
  a checkout newer than the installed lock triggers the reinstall.
- `opencode.json` spawns `node .opencode/mcp/markdown-vault/dist/index.js`
  **relative to the project root** — no hardcoded home path, so the repo works
  wherever it is cloned.
- MCP environment now configures the hybrid retrieval path: Ollama embeddings
  (`qwen3-embedding:0.6b`, 1024 dims), cross-encoder rerank
  (`ms-marco-MiniLM-L-6-v2`, 10 candidates), `meta/` index exclusions, and
  512-token chunks with 64-token overlap.
- `README.md` / `AGENTS.md` — quick start uses `run.sh`, requirements describe
  the pinned clone, the tracked-vs-local table lists `.opencode/mcp/`.
- `scripts/reset.sh` — also clears `.opencode/mcp/` (regenerated by setup).

### Removed

- The wrapper `package.json` / `package-lock.json` that pinned the fork via
  `github:…#<sha>` (that lock resolved to `git+ssh://`, requiring a GitHub SSH
  key). The pin now lives once, in `scripts/setup.sh`.
- The `npx -y @wirux/mcp-markdown-vault@2.3.0` launch path — no network or npm
  cache access at startup.

### Notes

- `.opencode/mcp/` is gitignored in full: source, `node_modules/` and `dist/`
  are regenerated by `setup.sh` (~17 s from the npm cache), never vendored.

## 2026-10-06

### Added

- `scripts/reset.sh` — return the project to a fresh-clone state by removing
  only the gitignored local layer (config, `Brain/`, `SETUP.md`, state, logs);
  `--dry-run`, `--yes`, `--dev`.
- Optional setup step that pins every subagent to one model via
  `.opencode/agents/*.md` frontmatter.
- `scripts/tests/test_provider_resolve.py` — decision-provider resolver tests.
- openjev resolves its endpoint and credential from opencode's
  `models.json`/`auth.json` for a `provider/model` spec, so no separate
  `base_url`/`api_key_file` is needed.

### Fixed

- The decision-gate wizard now actually writes `provider: rules` when rules is
  chosen (the config's provider was left untouched) and is offered again when
  a config already exists.

## 2026-10-05

### Added

- Initial commit: self-RAG knowledge harness migrated from the internal
  milestones — M1 (Brain-First retrieval gate), M2 (vault guards), M3
  (profile injection + idle writes), M4 (safe-browser + injection scan),
  M8 (audit/telemetry), M9 (OS agents). De-branded, tests green.
