# Nibble Dashboard v2 — pinned spec

Status: **live data** (2026-10-27). Source decisions: Agora thread #131 posts
267/269/271/285, board 6 cards S1/M0–M4/F1/Q1, plus the build session overrides
below. This revision replaces the earlier demo-only client: the dashboard now
monitors the running Kael harness through a purpose-built local backend.

## Architecture

```
Angular 22 SPA (Dashboard/) ── same origin ──► Node server (Dashboard/server)
                                                   ├─ .opencode/state/*.json
                                                   ├─ .opencode/logs/*.log|ndjson
                                                   ├─ .opencode/sysop-config.yaml
                                                   ├─ .opencode/missions/*.md
                                                   └─ ~/.local/share/opencode/opencode.db (+ serve proxy)
```

- `server/index.mjs` is a dependency-free HTTP server (Node 24, `node:sqlite`).
  It serves `dist/` and the `/api` surface; the Angular dev server proxy is only
  needed while developing.
- `server/data.mjs` is the read-only layer. `server/settings.mjs` owns the
  settings schema, YAML editing and mission overlays.
- Real per-run cost, model and timestamps come from opencode's SQLite `session`
  table; mission run identity comes from `heartbeat.log`'s `runs[]`, and drain
  passes are projected from `drain.log` (`source: "pipe"`) as `kind: "drain"`.
- No demo fallback. If the backend is down the SPA shows an offline banner and
  retries every 4 s; the backend itself retries nothing.
- Scheduler: [`../docs/swrr-work-scheduler-plan.md`](../docs/swrr-work-scheduler-plan.md).
  SWRR is live in `.opencode/plugin/lib/work-queue.ts`; the QUEUE panel,
  METRICS service share, FLIGHT next-kind and SETTINGS weights read the
  persisted `{version, items, scheduler}` state.

## What is monitored

| Source | Exposed as |
| --- | --- |
| `heartbeat.current.json`, `heartbeat.json` | current flight, lock/stale, tick counters, next-tick schedule |
| `mood.json`, `sleep.json`, `idea.json` | mood valence/arousal, quiet-hours state, daily idea draw |
| `work-queue.json` | unified queue + SWRR scheduler: kind, priority, age, due/not-before, TTL, requeues, weights/credits/served |
| `drain.current.json`, `drain-cursor.json`, `drain.log` | drain lag, pending turns/sessions, passes, last outcome |
| `backlog.ndjson` | open/total counts and entries |
| `heartbeat.log` + `drain.log` + `opencode.db` | runs with mission, kind, outcome, tokens, cost, model, duration, abort reason; drain pipe passes included |
| `autonomy-gate.log` | gate verdicts (allow/ask/deny) and classes |
| `decisions.log`, `retrieval.log` | JEV decisions, retrieval retrieves/skips, latency |
| `audit.log` | command audit failures/exits |
| `rag-search.log`, `web-usage.log` | delegated usage and cost |
| `*.log|ndjson` | ledger list + tail (logs page) |
| opencode serve (`state/serve-url`) | live session transcript via `/api/serve/*` |
| lock files | heartbeat/mission/drain/run/ownership lock presence and age |
| missions + `autonomy.missions` | effective mission table and overlay |

Cost is measured (`opencode.db`), not estimated from a rate table. The old D1
rate-map blocker is obsolete.

## What can be changed

19 settings sections are rendered from `GET /api/settings`:

`autonomy` (level, gate mode/scope, heartbeat frequency/lock, budget, root
classes, batch, session grant, enforcement, chatter, quiet/dream) · `heartbeat`
· `scheduler` (fair + per-kind weights) · `drain` · `mood` · `comms` · `idea` ·
`decisions` · `retrieval` · `browser` · `profile` · `soul` · `telemetry` ·
`backlog` · `memory` · `dashboard` · `audit` (read-only) · `paths` (read-only) ·
`vault` (read-only).

- Writes are per-field (`PUT /api/settings`) with type/range/enum validation
  and cross-field rules (`stale ≥ 3×refresh`, stall/timeout not both 0).
- `autonomy.level` may be lowered, not raised (no `login+2fa`).
- `dashboard.auth.*` is read-only; `bind_address`/`serve_url` stay loopback.
- Sections marked **restart** need an opencode restart (browser scan, telemetry,
  memory provider, dashboard target). Everything else is hot-read by the harness.
- Settings writes are atomic and journaled to `logs/dashboard.log`. YAML
  comments are preserved; whitespace is normalised by the YAML serializer.
- Missions use `PUT /api/missions` with restrict-only rules: disable, raise
  `min_level`, move frequency toward low, narrow `menus`. Widening is refused.
  No-op values remove their overlay key instead of adding noise.

## API surface

```
GET  /api/health                 backend, serve URL/reachability, paths, writable sections
GET  /api/overview               one-shot shell snapshot
GET  /api/heartbeat              current + schedule + counters
GET  /api/mood | /sleep | /idea  state files
GET  /api/queues                 work queue + running + drain + SWRR scheduler
GET  /api/drain                  drain lag, pending turns, passes
GET  /api/runs                   ?limit&mission&kind&outcome&hours
GET  /api/metrics/tokens         ?hours&bucket=tick|hour|day
GET  /api/metrics/cost           ?hours  (models, days, missions, avg/run)
GET  /api/metrics/errors         ?hours  (runs, gates, audit, retrieval, drain, series)
GET  /api/metrics/throughput     ?hours  (runs/hour, tokens, cost, p50/p95)
GET  /api/metrics/queue-wait     current queue p50/p95 (historical=false)
GET  /api/models                 ?hours  (session cost by model)
GET  /api/activity               ?hours  (gate/decision/retrieval/audit/drain/delegate feed)
GET  /api/sessions               ?hours&limit (opencode session rows)
GET  /api/settings               schema + current values
PUT  /api/settings               {updates:[{path,value}]}
GET  /api/config                 raw parsed config
GET  /api/missions               effective missions + overlays
PUT  /api/missions               {id,enabled|min_level|frequency|menus}
GET  /api/backlog                ?limit
GET  /api/ledgers                ledger list
GET  /api/ledgers/:name          ?limit
GET  /api/locks                  lock presence/age
GET  /api/csrf                   double-submit token
ANY  /api/serve/*                proxy to opencode serve
```

All mutations require the CSRF header and a loopback host/origin. The server
binds `127.0.0.1:4097` by default (`DASHBOARD_PORT`, `DASHBOARD_HOST`).

## Style contract

Phosphorstrap tokens only (`--ph-*`); no raw colors in component CSS.

| Attribute on `<html>` | Values | Default |
| --- | --- | --- |
| `data-theme` | `nibble`, `nibble-light` | `nibble` |
| `data-accent` | `lime`, `amber`, `cyan`, `violet`, `rose` | `lime` |
| `data-density` | `compact`, `comfortable` | `compact` |

- Every accent writes both `--ph-primary` and `--ph-primary-rgb`.
- Persisted in `localStorage` (`nibble.dashboard.v2`), replayed before first paint.
- Deep links: `?theme=nibble-light&accent=cyan&density=comfortable`,
  `?appearance=1`, `?palette=1`.
- Accent tints chrome/charts; status colors stay semantic.
- Terminal feel: mono labels/numbers, 4 px grid, 1 px borders, 3–4 px radii.

## Shell and pages

Header (brand, live/offline pill, level, mood, clock, theme menu, ⌘K, refresh) →
8-cell status strip → 6-tab nav → page → status footer.

| # | Strip cell | Value |
| --- | --- | --- |
| 1 | backend | live/offline + serve host |
| 2 | tick cadence | tick #, phase, next due |
| 3 | mission / lease | mission or side mission, level, run-lease state |
| 4 | token burn | last run tokens / budget, model |
| 5 | $ spend · 24h | measured session cost, avg/run, today |
| 6 | work queue | depth, due count, oldest age |
| 7 | drain backlog | pending turns, queued state, oldest pending age |
| 8 | error rate · 24h | run error rate, errors/total, overruns |

| Tab | Key | Contents |
| --- | --- | --- |
| FLIGHT | 1 | mission/lease, token+cost, vitals (mood/sleep/ideas/cadence/next kind/drain), live transcript, queue peek, activity feed |
| METRICS | 2 | cadence, error rate, drain backlog, token burn, spend, $/mission, current queue age, overruns; scheduler service share; hourly burn chart; spend by model; outcomes; gate verdicts; mission rollup |
| QUEUE | 3 | drain strip, in-flight, SWRR scheduler panel, unified work queue, run history + run drawer |
| MISSIONS | 4 | effective missions, enable switches, restrict-only overlay editor, candidacy split |
| LOGS | 5 | ledger index + tailing/filter/save viewer |
| SETTINGS | 6 | runtime target, locks/backlog insights, schema-driven settings with per-section apply |

## Layout and source map

```
Dashboard/
  server/          index.mjs (HTTP), data.mjs (sources), settings.mjs (schema+YAML)
  src/app/core/    api, models, store, theme, formatting, toasts
  src/app/shared/  status-strip, sparkline, metric-panel, run-table, transcript, palette
  src/app/pages/   flight, metrics, queues, missions, logs, setup
  src/styles.css   shell + widget primitives on --ph-* tokens
  vendor/phosphorstrap  Phosphorstrap 0.2.0
```

## Run

```
npm install
npm run build          # dist/
npm run server         # http://127.0.0.1:4097  (API + built UI)

# development, two terminals:
npm run server
npm start              # http://127.0.0.1:4200, proxies /api → 4097
```

Env: `KAEL_DIR` (default repo root), `DASHBOARD_PORT` (4097), `DASHBOARD_HOST`
(127.0.0.1), `DASHBOARD_DB` (opencode.db), `DASHBOARD_DIST`.

## Deviations from the settled board

- **6-page nav** (Q1 fixed 5): LOGS is a page; Output is folded into FLIGHT.
- Themes are `nibble` + `nibble-light` exactly as Phosphorstrap 0.2.0 ships.
- Cost is measured from opencode sessions, so the D1 model-rate table is not
  needed. Queue-wait history remains unavailable because completed runs do not
  persist an enqueue timestamp; the panel reports the **current** queue wait.
- Metrics ownership remains Nemu's on the board; this build renders the agreed
  surface and does not claim the board cards.

## Known limits

- SWRR currently covers queued work (`mission`, `drain-pass`, `staleness`).
  `quiet-hours`, `profile-update` and `soul-update` are still self-gating
  maintenance steps after the tick; their weights are reserved until their
  producer lands. Mission-definition fairness remains bounded-candidacy work.
- `drain.pending` mirrors the harness `unconsumedCount` query: top-level
  (`parent_id IS NULL`) sessions, exact automation titles, non-synthetic text
  parts, and per-session cursor marks as well as the global watermark. It can
  still differ from a stale consumer run by a few turns while a pass is active.
- Error rate over a 24h window with only a few ticks is noisy by nature.
- Settings writes re-serialise the whole YAML document (comments preserved).
- No auth beyond loopback + CSRF; TLS/login/2FA is still card 11.
- The board-wide root hold still applies to wiring this build into the harness's
  own service; it runs as a separate local process.
