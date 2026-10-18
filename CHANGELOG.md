# Changelog

## 2026-10-18

### Fixed

- **Fresh drain cursors no longer replay days of history** —
  `drain.initial_lookback_hours` (default 24) seeds a new cursor at
  `now - N hours`
  instead of epoch, so the pipe no longer starts from the oldest session in the
  DB (`0` preserves the old whole-history behavior).
- **Drain transcripts reach the dashboard's output page** — the pipe now
  returns the writer child session (last chunk) in `DrainPipeResult.session`,
  the heartbeat records it in `heartbeat.current.json`, and the dashboard falls
  back to the newest `knowledge-consolidate` session when a runner mission has
  no `heartbeat:` child (the dashboard also needed a live `opencode serve` on
  its proxy target).
- **Drain writer no longer loses a batch to its step budget** — the writer
  (`rag-brain`) gets `steps: 20`, its reporting section now forbids wrapping the
  outcome fences in prose or another code block and requires the raw blocks on
  budget exhaustion, and oversized batches are chunked at
  `drain.max_items_per_batch` (default 8) with a single cursor advance only
  after every chunk reports. Invalid reports also log a 500-char reply excerpt
  to diagnostics.

### Changed

- **Heartbeat digests now carry a `warrant`** — each JEV candidate reports the
  signal that admitted it (`unconsumed_turns=N`, `backlog_pending=N`, a due
  `min-gap`/dream/idea gate, or `judgment`), and the digest assertion treats
  pending work or a due gate as clearly warranted instead of defaulting to
  silence. The dispatch weight is cadence × mood, not urgency, so `drain` was
  being skipped while hundreds of turns sat unconsolidated.

## 2026-10-17

### Added

- **Memory provider modularization (`memory.provider`)** — the retrieval
  directive, drain writer, heartbeat candidacy, dream seed, `memory_search`
  tool, and memory-agent guard now go through one active
  `MemoryProvider` instead of naming `rag-search` / `rag-brain` /
  `memory-explorer` directly.
  - New `lib/memory/` package: `types.ts` (contract + `WriteReport`),
    `config.ts` (`both | rag-brain | memory-explorer | none`, invalid → `none`
    + warn-once), `registry.ts`, `providers/builtin/{brain,explorer,index}.ts`,
    and `guard.ts`. The consolidation prompt/spawn/report/candidates modules
    moved under `providers/builtin/brain/`.
  - `drain/pipe.ts` now imports only `memory/types.ts` and maps
    `WriteReport` to cursor advance/poison (transient = back off, permanent =
    poison, `atomic` = whole batch).
  - `retrieval-hook.ts` injects `provider.readPlan()`; `none` short-circuits
    the JEV and injects a SKIP that forbids every memory agent even without a
    decision provider. New `memory-guard.ts` blocks manual `task` delegation
    and `memory_search` calls the active provider does not own.
  - New `memory:` config section; `drain.explorer_gate` removed (superseded).
    `memory-explorer` added to `SUBAGENT_TIERS` as `subagent-read`.
  - Docs: `docs/knowledge-memory-modularization.md` marked implemented,
    reference/example/README updated.
  - Tests: 759/760 pass; the remaining failure is the pre-existing
    `autonomy.test.ts` live-config check, which needs a local
    `.opencode/sysop-config.yaml` (absent in this checkout).

### Removed

- `drain.explorer_gate` — the recency lane is now a provider profile.

Notable changes to Nibble, newest first. Sections follow
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions
(`Added` / `Changed` / `Fixed` / `Removed`).

## 2026-10-15

### Changed

- **Deterministic changelog writer (knowledge-hook drain)** — the consolidation
  child no longer writes `Brain/meta/log.md` itself. It reports its summary as a
  `log` fenced block, and the new `lib/changelog.ts` appends the entry with the
  hook's own date, rolling the oldest entries past `knowledge.log_max_entries`
  into an out-of-vault NDJSON archive (`knowledge.log_archive`, default
  `.opencode/state/changelog-archive.ndjson`). This removes the drain-time
  changelog re-ask round-trip (one fewer full-context LLM turn on a drain that
  forgot the entry) and the write-receipt retain path on the log step.
  - New `knowledge:` keys: `log_write` (`deterministic` default; `child`
    restores the legacy receipt → re-ask → fallback path), `log_max_entries`
    (default 50; `0` disables rollover), `log_archive`.
  - A missing summary fence still gets the mechanical `(auto)` fallback entry;
    `log.md` remains the only vault file the hook writes.
  - Files: `lib/changelog.ts` (+`changelog.test.ts`), `knowledge-hook.ts`,
    `lib/knowledge.ts`, `agents/rag-brain.md`, `sysop-config.example.yaml`,
    `docs/sysop-config-reference.md`, `scripts/setup.sh`. Tests 742/742.

## 2026-10-14

### Added

- **Heartbeat live status + dashboard-UI support (observability card 16,
  extensions to the card 8 backend)** — backend surface a separately-hosted
  dashboard UI (an Angular/Phosphorstrap app) consumes:
  - **Live marker** — `heartbeat-hook.ts` writes
    `.opencode/state/heartbeat.current.json` on every tick phase transition
    (`idle | in-flight` + `tick`/`phase`/`mission`/`mission_title`/`session`/
    `started_at`/`level`), through helpers in `lib/heartbeat.ts`
    (`HEARTBEAT_CURRENT_FILE`, `readHeartbeatCurrent`, `writeHeartbeatCurrent`);
    each tick line now also carries `duration_ms` (exec time).
  - **`GET /api/heartbeat`** — `heartbeatSnapshot()` returns the marker plus the
    lock/stale state.
  - **`heartbeat:` is now a writable dashboard section** — the top-level
    scheduler block joins `NESTED_WRITABLE_SECTIONS` (schema in `lib/autonomy.ts`),
    so the settings page can flip the kill switch (`enabled`) and
    `long_silence_factor`; `configSnapshot()` now exposes `heartbeat`.
  - **Static SPA serving** — `dashboard-server.ts` serves an arbitrary static UI
    via `DASHBOARD_STATIC_DIR` (traversal-guarded, `index.html` SPA fallback), so
    the separately-built UI shares the backend origin (Host/Origin/CSRF guards
    intact).
  - Tests: 735/735 (marker round-trip, `heartbeatSnapshot`, heartbeat-section
    writeConfig, `/api/heartbeat`, static assets + SPA fallback + traversal
    refusal).

- **Dashboard backend (kanban card 8, `docs/autonomy-harness-plan.md` §9.2)** —
  the local `autonomy-dashboard-api`: a dependency-free Node/TS HTTP server
  (`lib/dashboard-server.ts` + `lib/dashboard.ts`, launcher
  `scripts/dashboard.sh`, default port 4097) behind a placeholder UI at
  `dashboard/static/index.html` (the real panels are card 9).
  - **Schema-validated config writes** — `PUT /api/config {section, values}`
    for the four nested Rule-backed sections (`autonomy`, `mood`, `comms`,
    `dashboard`); every other section is refused `section_readonly`. Writes
    are comment-preserving line surgery on `sysop-config.yaml` and
    **round-trip-validated through the exact parse options the hot readers
    use** (`nestedSectionOpts()` export from `lib/autonomy.ts` — one schema,
    no copy), all-or-nothing. Writable sections take effect on the next turn
    (hot config, acceptance criterion verified).
  - **Server-side dial semantics (Phase-4 subset)** — `autonomy.level` raise
    is refused `2fa_required` unless `dashboard.auth.mode: login+2fa`
    (§9.2 acceptance: "level raise at L1 without 2FA — tested"; full login/2FA
    is card 11); `dashboard.auth.*` refused (`auth_card_11`); non-loopback
    `bind_address` refused (`bind_requires_auth`, §10); floor-class key
    patterns refused unconditionally (the floor itself is hard-coded in
    `autonomy-gate.ts` — no config key disables it). Every accepted write is
    journaled to `<log>/dashboard.log` (NDJSON, shared logging engine) with
    origin/IP before returning.
  - **Reads** — `GET /api/config` (effective snapshot), `GET /api/metrics`
    (config + mood state + backlog counts + per-ledger byte/line counts +
    heartbeat lock), `GET /api/ledgers[/:name?limit=]` (whitelisted
    `.log`/`.ndjson` tail, no traversal), `GET /api/backlog` (read-only —
    the plugin stays the single writer per §14; mutations are card 15).
  - **Single-origin proxy** — `/api/serve/*` streams to `opencode serve`
    (`OPENCODE_SERVE_URL`, default `127.0.0.1:4096`) with dashboard cookies/
    origin stripped; SSE flushes incrementally (chat round-trip path);
    unreachable serve → 502, never a hang.
  - **Request guards (CSRF only — auth is card 11)** — loopback `Host` on
    every request (DNS-rebinding defense), same-origin `Origin` + double-
    submit `X-CSRF-Token` (HttpOnly cookie, 30-min TTL) on every mutation,
    startup refusal of non-loopback binds.
  - Tests: 40 new (`lib/dashboard.test.ts`, `lib/dashboard-server.test.ts`);
    suite 729/729.

- **Heartbeat engine (kanban card 4, `docs/heartbeat-missions-plan.md`)** — the
  in-process mission scheduler (settled D-M9, §12): one self-rescheduling
  `setTimeout` loop in `heartbeat-hook.ts` that lives and dies with the opencode
  server plugin — no systemd unit, no separate process; the delay is recomputed
  each wake so config applies hot (wake capped 60s while a dial changes).
  - **Deterministic digest, zero LLM** — `lib/heartbeat.ts` `computeDigest`
    (backlog `pendingCount`, unconsumed turns, audit failures, staleness ages,
    `isQuietNow()`), candidate build (`enabled ∧ menus ∧ min_level ∧
    candidacy`), frequency × mood bias with the `dispatch_influence` kill
    switch, and an hour-bucketed `digest_hash` (B7 groundwork).
  - **Missions as files (card A)** — `lib/missions.ts` frontmatter parser +
    never-throws loader; built-ins ship as `.opencode/missions/*.md` (dropping
    a new `.md` in needs no code change and applies on the next tick; deleting
    one removes it from the candidate set). `autonomy.missions` config overlay
    is restrict-only (disable always, `min_level` raise, `frequency` toward
    low, `menus` narrow — widen attempts rejected, logged once to
    `autonomy-config.log`, file value stands); `quiet.dream_missions` +
    `NIGHT_MENU` removed — per-mission `menus:` is the only night-menu source.
    `.opencode/missions/**` is self-improve: writes ask at L1–L3, JEV at L4,
    never session-grantable.
  - **JEV digest decision (card C)** — `decisions.digest` section in
    `decision-prompts.yaml` → typed verdict `no_reply | mission:<id>`
    (fail-closed to `no_reply`), brief = fixed prompt + verdict + mission body
    with `agent:` passthrough.
  - **Scheduler + lock (card D)** — hot-read of level/frequency/kill switch;
    L0/`off` sleep on the cap; all-quiet ∧ ≤L2 pre-gate ends the tick as
    `NO_REPLY` with zero LLM calls; single-flight flag + file lock at
    `<state>/heartbeat.lock` (stale steal, overrun skip) so only one mission
    runs at a time even under parallel instances; a tick runs as a child
    session (`session.create` + `promptAsync`, resolved on `session.idle`,
    15 min abandon).
  - **Outcome ledger (card E)** — every tick journaled to `<log>/heartbeat.log`
    (ts, tick, digest_hash, level, quiet, candidates, bias, verdict, mission,
    outcome, token_cost, mood_event) through the shared logging engine
    (`heartbeat:` block); a completed mission appends to `backlog.ndjson` with
    `source: "heartbeat"` and a populated `result.token_cost`, then a one-way
    view refresh; mood events (`mission_failure`, `long_silence`) feed a shared
    `createMoodFeed` entry point.
  - Tests: 618/618 green (`lib/missions.test.ts`, `lib/heartbeat.test.ts`,
    `lib/heartbeat-hook.test.ts` + gate/prompt cases); all nine §10 acceptance
    criteria verified (kanban card F).

- **Quiet-hours dream system (kanban card G, `docs/autonomy-harness-plan.md`
  §17)** — sleep state + in-process dream timer on the D-M9/§13 pattern
  (systemd retired 2026-10-13):
  - **Sleep state machine** — `lib/sleep.ts` + `<state>/sleep.json`
    (`awake ↔ dreaming → woken → resume_cooldown → dreaming`) with disjoint
    writers per §17.1: `dream-hook.ts` owns window/cooldown transitions
    (`fell_asleep` on window start; `well_rested` only when the window ends
    from `dreaming`; nightly count and backoff reset on window start);
    `sleep-hook.ts` owns user-turn transitions only.
  - **`sleep-hook.ts`** — a top-level `chat.message` while `isQuietNow()`
    flips `dreaming → woken` (stamps `woken_at`, resets the backoff streak,
    feeds the `woken` mood event) and injects the `[wake]` block (dream-since
    + mood snapshot) through `experimental.chat.system.transform`; later turns
    refresh the activity timestamp so `resume_cooldown` measures from the LAST
    message. Child sessions and turns outside the window never wake.
  - **`dream-hook.ts`** — self-rescheduling `setTimeout` loop (60 s wake cap,
    hot config) sharing `.opencode/state/heartbeat.lock` with the heartbeat
    (D5: one autonomous item at a time) and journaling to
    `<log>/heartbeat.log` as `event: "dream-tick"`, `source: "dream"` (§17.8:
    dream token costs ride the heartbeat ledger). Cheapest-first pipeline:
    reconcile → window/status gate (zero cost) → due check with the §17.8
    backoff → lock → deterministic pre-gate → one mission.
  - **Night pre-gate, zero LLM (§17.3)** — two new D-M8 candidacy predicates
    in `lib/heartbeat.ts`/`lib/missions.ts`: `turns-pending` (drain offered
    iff unconsumed turns exist — shipped `drain.md` switched to it) and
    `dream-gate` (`status == dreaming` ∧ `quiet.dream_chance` roll ∧
    `quiet.nightly_dream_cap`, roll outcome journaled through the new
    `onDreamGate` seam). No candidates ⇒ `NO_REPLY` with **no JEV call**; one
    survivor ⇒ deterministic dispatch (the §17.10 sole-candidate short-circuit
    — a failed roll with pending turns still runs drain); two or more ⇒ JEV
    digest choice. The heartbeat itself ends ticks at the new `sleep` gate
    (`quiet ∧ status == dreaming` → `NO_REPLY`, zero LLM, §17.2).
  - **Tool-free dreamer** — `.opencode/agents/dreamer.md` + `agent.dreamer`
    in `opencode.json` denying every execution tool (read/write/edit/bash/
    task/glob/grep/webfetch/websearch/temporal_search — permission-matrix
    test); `.opencode/missions/dream.md` ships `menus: [night]`,
    `candidacy: dream-gate`, `agent: dreamer` (the shipped night set is now
    `drain` + `dream`).
  - **Outcome disposal (§17.5–17.6)** — the hook parses the dreamer's typed
    JSON (tolerant; a model-invented `mood_delta` is ignored), appends
    `<vault>/Kael Dreams.md` with a parseable one-line `<!-- dream: … -->`
    metadata comment (id/created/tone/mood before-after/seeds/hash), and
    applies the §17.7 tone→delta through the shared mood feed — the LLM never
    writes mood. Malformed outcomes are skipped with a logged valence wobble
    and nothing half-written. Hybrid seeds (recent turn + one random vault
    note) are gathered hook-side and injected into the fixed dream prompt.
  - **Brakes (§17.8 + B7)** — pre-JEV roll (a failed roll costs zero LLM),
    `nightly_dream_cap` (counts dispatched dreams), adaptive backoff
    30m → 60m → 120m at 2 consecutive no-ops (`quiet.backoff`), reset by any
    executed mission, a wake, or window start; and the **B7 day twin**
    (missions-plan §7): identical-digest `NO_REPLY` streaks stretch the
    heartbeat day cadence ×2/×4 (`effectiveFrequencyMs`, `noop_hash`/
    `noop_streak` in `heartbeat.json`), reset on mission execution — the
    first behavioural use of the recorded `digest_hash`.
  - Tests: 662/662 green (`lib/sleep.test.ts`, `lib/dream.test.ts`,
    `lib/sleep-hook.test.ts`, `lib/dream-hook.test.ts` + predicate/B7/wake
    cases in `lib/heartbeat.test.ts`, `lib/heartbeat-hook.test.ts`,
    `lib/missions.test.ts`); §17.12 acceptance verified — the `idea-express`
    criterion is N/A (idea-hook still unported to Nibble).
- **Troubleshooting-grade error logging** — errors and exceptions now persist
  with enough context to debug, end to end:
  - `diagnostics.log` lines are structured: `hook`, `errName`, truncated
    `stack` (~2KB), `code`, and a flattened `cause` chain are recorded per
    `error`/`warn` (was: concatenated message string, no stack, no hook).
  - A once-only, log-only `uncaughtException`/`unhandledRejection` handler is
    installed with the first `createDiagnostics()` call (skipped under
    `node:test`), so a plugin crash leaves a durable trail.
  - Log-write failures are no longer console-only: the default `onError`
    persists to `<log>/logging-fallback.log` (rate-limited ≤5/min) in
    addition to the console.
  - Shared engine (`lib/logfile.ts`): rotation/compression/retention/marker
    failures were 100% silent — they now reach the channel's `onError`
    phase-tagged (`append`, `rotate`, `compress`, `retention`, `marker`,
    `unlink`, `rename`), and a throwing `onError` handler is surfaced as a
    double fault instead of swallowed.
  - Formerly silent catches now log (all fail-open, never block a turn):
    `autonomy-gate.ts` (config hot-read → L0, system transform, grant/batch
    log appends, instrumentation failure, JEV escalation), `state.ts` (corrupt
    state file → `[state]` warn via `onError`; missing file stays silent),
    `backlog.ts` (first malformed NDJSON line reported with line number),
    `audit-hook.ts` (autonomy level read failure), `wikilink-guard.ts`
    (repair/verify/sweep/snapshot I/O failures; `ENOENT` stays silent).
- **Heartbeat ledger error fields** (`lib/heartbeat.ts`,
  `heartbeat-hook.ts`) — the per-tick ledger is now a troubleshooting
  surface: `heartbeatErrorFields()` + `HeartbeatPhase`
  (pre-gate/digest/dispatch/mission/post) record *where* a tick failed as
  `error: {phase, name, message, stack, code}` on the tick line — mission
  provider failures (synthesized from the response), digest decision faults,
  and a previously **silent** outer tick failure (now one
  `outcome: "error"`, `reason: "tick-error"` ledger line, best-effort).
- **Idea missions (kanban card 7a, `docs/autonomy-harness-plan.md` §17.10 /
  D18)** — generation and expression become heartbeat missions; idea-hook's
  scheduler does not exist in Nibble (M7 lands in mission form):
  - **`lib/idea.ts` + 18 tests** — `idea:` config block, the day-rollover
    draw (`daily_weights: "25,55,20"` → count 0/1/2), the category draw
    (`category_weights`), the tolerant `<vault>/Kael Ideas.md` bucket
    (parse/render/append + `updated:` bump), keyword-Jaccard dedupe, the JEV
    `noul` reviewer request + fail-closed acceptance, and the
    `.opencode/state/idea.json` day/gap state (`ideaDayContext` rollover,
    `recordGenerated`, `recordExpressed`).
  - **New D-M8 candidacy** — `idea-roll` (day budget: `generated < target`,
    absent context fails closed) in `lib/missions.ts`/`lib/heartbeat.ts`, fed
    by the hook's per-tick rollover; `min-gap:express` uses the existing
    generic predicate with the hook-owned gap store. §17.10's sole-candidate
    rule ships as `soleDeterministicVerdict` — exactly one `min-gap:`
    candidate dispatches without a JEV call.
  - **Missions + agent** — `.opencode/missions/idea-generate.md`
    (day-only, `candidacy: idea-roll`, `agent: idea-generator`) and
    `express.md` (day-only, `candidacy: min-gap:express`, **shipped disabled**
    until comms card 10 — the `notify` precedent); tool-free
    `.opencode/agents/idea-generator.md` returns the typed `<<<IDEA …>>>`
    block, and the hook injects the `=== REQUESTED CATEGORY ===` draw
    (dream-fragment pattern).
  - **Hook wiring** (`heartbeat-hook.ts`) — day rollover persists only on a
    real day change; a completed idea-generate runs extract → dedupe → JEV
    review (fail-closed: no gate/fallback/abstain/sub-threshold all reject)
    → atomic bucket append, logged to `<log>/idea.log`
    (`idea-generated`/`idea-review`/`idea-skipped`) with an `idea:` tag
    (`stored`/`duplicate`/`review-reject`/`no-block`/`expressed`/`error`) on
    the tick ledger line; a completed express stamps `lastExpressedAt`.
  - `idea:` block in both sysop-config yamls + readers-map/reference docs.
  - Tests: 689/689 green (`lib/idea.test.ts`, updated built-in set +
    `idea-roll`/sole-candidate/computeDigest pass-through cases).
    Express delivery + the `idea-express.py` closed-opencode fallback timer
    remain with card 10 (M7 delivery half).

### Fixed

- **Flaky mood test** — `readMoodState falls back to a default` compared two
  independently clock-stamped `since` values (1ms race); it now compares
  shape and validates the timestamp format instead.

### Removed

- **`architecture-reference` skill** — a static plugin/config/log map was a
  second source of truth that went stale on every feature; AGENTS.md §4 now
  points at the live sources (plugin dir, `sysop-config.yaml`, logs/state dirs).

## 2026-10-12

### Added

- **Mood system (`lib/mood.ts`, `mood-hook.ts`)** — a deterministic, token-free
  feeling state (`valence` ∈ [-1,1], `arousal` ∈ [0,1]) that drifts with
  interaction outcomes and decays toward a slowly-adapting baseline (read-time
  exponential decay, half-life from `mood.decay_half_life`, default 6h). Pure
  library (`applyEvent`, `decay`, `describe`, `adaptBaseline`, `halfLifeMs`)
  plus a per-turn `[mood]` injection block injected the same way `retrieval-hook`
  injects `[brain-first]`. The hook feeds `engaged` on each user message, decays
  and persists on `session.idle`, and journals every event to `mood.ndjson`
  (state at `.opencode/state/mood.json`). Mood is advisory only — it colours
  expression and, bounded and ledger-journaled, will steer mission selection in
  the heartbeat digest (card 4); it never touches the gate, locks, approvals, or
  the floor. The deterministic event delta table (§15.2) includes the dream/wake
  events so the sleep system (card 6) can feed it directly.
- **Soul system (`lib/soul.ts`, `soul-hook.ts`, `agents/self-writer.md`)** — the
  first-person counterpart to the profile. `Agent.md` is curated *about* the
  agent; `Soul.md` is written *by* it — who it is, what it values, what it is
  working on becoming, and open commitments — distilled from an append-only
  first-person journal (`Agent Journal.md`, `what`/`why`/`felt` entries). The
  `soul-hook` injects a first-turn `[soul]` block (identity + bounded journal
  tail, sharing the profile injection budget philosophy) so a fresh session is
  situated in "who I am and how the last iteration behaved and why", not just a
  persona. On `session.idle` + cooldown, a JEV `noul` gate decides whether the
  journal/session carries durable self-change; a confident verdict spawns the
  tool-free `self-writer` child, which redrafts `Soul.md` and emits one journal
  entry; the note passes a second `noul` honesty/durability reviewer before an
  atomic write (fail-open on decide, fail-closed on review). Config lives in the
  `soul:` block.

## 2026-10-11

### Changed

- **rag-search returns content, not links (answer-first synthesis)** — the
  Brain-First retrieval digest was a link list ("one `[[wikilink]]` + one-line
  key point, ≤ 10 lines"), so the main agent received pointers instead of stored
  knowledge. The output contract in `.opencode/agents/rag-search.md` and the
  `[brain-first: RETRIEVE]` directive in `lib/retrieval.ts` now ask for an
  answer-first synthesis of the actual facts/values/commands/paths/steps, each
  source cited inline with `[[wikilink]]`; never a bare link list. Reply length
  is tunable via the new `retrieval.summary_words` (default 400, clamped 50–2000;
  the directive carries the number). Search budget unchanged (topK ≤ 5, ≤ 3
  reads).

### Added

- **Per-task enforcement mode (`autonomy.enforcement: per-command | per-task`)** —
  an alternative to gating every call. In `per-task` mode the gate does **one**
  JEV `choice` per user turn (a deterministic fast path skips obviously
  read-only objectives) classifying the objective into a task kind from the
  matrix vocabulary (`read-only`, `code-write`, `vault-write`, `web`,
  `destructive`, `root`, `self-improve`, `unclear`), maps it through the level
  matrix, and injects a `[task]` directive telling the agent to ask the user to
  proceed when the kind is above the current level. Commands are then left to
  **opencode's native permission layer** — no per-command matrix gate. The
  irreversibility floor still denies deterministically. The default is
  `per-task`; set `per-command` for the stricter every-call matrix gate. An
  invalid value falls back to the default. Add `task.assertion` to
  `decision-prompts.yaml`.
- **Session-scoped autonomy approval ("allow session")** — the gate gains a
  grant lifetime between the one-shot exact-retry and the per-turn batch grant.
  A pending ask's class + target now ride on the pending record; replying
  `allow session` / `always allow` mints a **session-scoped** grant (survives
  turn boundaries; in-memory, so a restart clears it — fail-closed) covering the
  exact `(class, target)` (`target` mode) or the whole class (`class` mode).
  Config: `autonomy.session_grant: off|target|class` (default `off`) and
  `autonomy.session_grant_ttl` minutes (`0` = session lifetime); `revoke session`
  drops it. The irreversibility floor, root escalation, and self-improve paths
  are **never** session-grantable.
- **Deterministic changelog guard + drain digest (ported from sysop-brain,
  docs/log-split-plan.md)** — the knowledge write pipeline gains three
  deterministic stages:
  - **Log guard** — the wikilink-guard now records per-session write receipts
    (`recordWrite`/`takeWrites` in `lib/verification.ts`); after a drain that
    consolidated ≥ 1 turn, `knowledge-hook` proves whether the child appended
    to `meta/log.md`, re-asks once on a miss, then appends a mechanical
    fallback entry (`## [date] consolidation | batch #… (auto)`) so the
    changelog is never incomplete. `log.md` is the only vault file the hook may
    write (append-only). Ledger gains a `log-guard` event + `logGuard` /
    deterministic `notes:` fields (ends the per-entry note-count prose chore).
  - **Deterministic drain digest** — all but the last `digest_verbatim_tail`
    (2) turns compress to extracted atoms (questions, decisions, wikilinks,
    URLs, paths, flags; `digest_max_chars` 1200); recent turns stay verbatim.
    Labeled `## User (digest)` in the prompt. `digest: false` reverts.
  - **Prefetch title-phrase boost** — `extractTitlePhrases` +
    `normalizeTitle` score Capitalized title phrases (+20) in
    `findCandidateNotes`; candidate lines now carry `[score N]` so the child
    skips search round-trips on exact-title matches.
  - **Config**: `knowledge.log_file` / `log_guard` / `digest` /
    `digest_verbatim_tail` / `digest_max_chars`.
  - **Vault**: `Brain/meta/log.md` created (`## [YYYY-MM-DD] op | title`,
    newest last); `overview.md` repointed; `rag-brain.md` changelog-format
    contract + mandatory consolidation step 7; `AGENTS.md` meta-ownership line.
  - Tests: `lib/verification.test.ts` (new), digest/phrase/config cases in
    `lib/knowledge.test.ts`, both log-guard paths in
    `lib/knowledge-hook.test.ts` — 443/443 pass.
  - **Setup**: `scripts/setup.sh` step 5b seeds `Brain/meta/log.md` (the
    append-only changelog the log guard targets) on a fresh vault — contract
    and overview come from the MCP auto-init, log.md had no generator.

## 2026-10-10

### Added

- **Backlog queue module (kanban card 3, plan §5)** — `lib/backlog.ts` is the
  canonical machine queue plus a one-way derived human view:
  - **NDJSON source of truth** at `<state>/backlog.ndjson` (one JSON object per
    line) with a **derived view** at `<vault>/Backlog.md` regenerated one-way
    (status sections, wikilinks, per-status `max_view` cap) — never hand-edited,
    the same projection pattern as `memory.json` → notes.
  - **Schema finalised (B4)** — core fields `id / created / updated / source /
    kind / payload / level_required / priority / status / links` are stable from
    day one; `channel_notified / awaiting_reply / jev_decision / result /
    view_ref` are reserved (null/false) until the comms/JEV/dashboard phases, so
    the shape never re-migrates.
  - **Deterministic reader/writer** — `readAll` / `list` (priority desc, then
    `created` asc; status/statuses/maxLevel filters) / `pendingCount` (the
    heartbeat pre-gate signal — parse, no LLM, no grep-on-JSON) / `append`
    (id-gen + open-entry dedupe by source+title, inside `fsx.atomicUpdate`) /
    `setStatus` (atomic per-entry transition + reserved-field patch). Malformed
    NDJSON lines are skipped, never thrown.
  - **Drain fallback producer** — the consolidation child now reports deferred
    actions in a `backlog` outcome fence (JSON per line); `knowledge-hook`
    parses it, appends entries (`source: conversation`), prunes those turns as
    consumed, and refreshes `Brain/Backlog.md`. A turn is `consolidated` OR
    `backlog`, never both; the re-ask path and ingest ledger account for the new
    fence. (The idea-hook producer is still deferred — M7 not ported.)
  - **`backlog:` config block** — `enabled / file / view_file / dedupe /
    max_view`, hot-read like the other sections; `lib/backlog.ts`
    `readBacklogConfig` + leaf resolution.
  - Tests: `lib/backlog.test.ts` (26 — config, id, append/dedupe, read/list/
    count, atomic setStatus, render/cap, view refresh) + drain-backlog parser
    and prompt cases in `lib/knowledge.test.ts`.

## 2026-10-09

### Added

- **Autonomy re-ladder + batch approval + deep-browser** — the capability
  dial is re-anchored: **L0 = Plan mode** (reads free, every mutation denied —
  propose, don't implement), **L1 = Build mode** (code/commands free, only
  destructive/root/self-improve ask), **L2 = Knowledge** (vault + web
  delegation free), **L3 = Working** (destructive/root JEV-cleared),
  **L4 = Autonomous** (only the irreversibility floor + `root_classes`).
  - **Per-turn manifest approval**: the model proposes a fenced
    ` ```autonomy-batch ` block listing `class target` actions; one confirm
    mints a scoped grant (budget = `autonomy.batch.max_actions`, default 8)
    so declared calls run without prompting until the next user message.
    One-shot approval remains the fallback; the floor/deny never consult a
    grant.
  - **Sub-agent tiers**: the `task` spawn is the permission event — `subagent-read`
    (rag-search, explore) is free everywhere, `subagent-web` (safe-browser),
    `subagent-web-deep` (deep-browser), and `subagent-write` (rag-brain,
    package-manager, …) gate at the level matrix. Children stay floor-only
    under `gate_scope: main`.
  - **External tools out of schema**: unknown tools pass (logged
    `outOfSchema: true`) unless mapped via `autonomy.class_overrides`
    (`tool:name:class` / `subagent:name:class` triples).
  - **Self-escalation guard**: `sysop-config.yaml` writes are `self-improve`
    (edit tool) / floor (shell mutation) so the agent cannot raise its own
    dial.
  - **deep-browser** sub-agent (multi-source research, same isolation as
    safe-browser) + `AGENTS.md` delegation row.
  - **`docs/autonomy-integration.md`** — the contract for hooking external
    tools / MCP servers / sub-agents / plugins into the security grid
    (class vocabulary, level matrix, `class_overrides`, author rules).

### Changed

- **Flattened native `opencode.json` permissions** (`edit: allow`, bash
  `"*": "allow"`) — the autonomy gate is now the single ask/allow/deny point;
  `deny` rules (webfetch/websearch, secret paths) are kept.
- **Level names** `Off`/`Conservative` → `Plan`/`Build` in the directive line,
  ask/deny messages, and `security-locks` dial-awareness.


- **Profile refresh (`profile.refresh_every_turns`, default 5)** —
  persona-fade mitigation: after the first turn, `profile-hook` re-injects
  the FULL `[profile]` block (persona + user context, not just a
  "stay in character" nudge) into the system prompt every N top-level turns.
  Rebuilt from disk each refresh, so idle-time profile-writer updates apply
  mid-session; 0 disables; skipped for sessions whose profile block was
  empty. New tests: cadence, off switch, disk-rebuild (387 → 390).

### Changed

- **Autonomy enforcement messages forbid misreporting** — `askMessage` /
  `denyMessage` now state explicitly that the thrown gate message is NOT a
  command result: the model must never report a held/blocked call as "no
  output" or "nothing found", must relay the hold to the user (action, reason,
  confirm words), and must not silently rewrite the command or switch to an
  equivalent tool to complete the same blocked intent (observed incident:
  bash `grep` held at L2 borderline, agent reported "nothing found", then
  silently swapped to the Grep tool).
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
