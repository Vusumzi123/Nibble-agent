# Nibble Dashboard

A local web dashboard for the **Nibble autonomy harness** — heartbeat
observability and autonomy settings. Angular 22 front end styled with
[Phosphorstrap](vendor/phosphorstrap) (the retro-terminal theme/token layer over
Bootstrap 5.3).

It is a **thin client over the target project's dashboard backend** (Nibble
card 8, `lib/dashboard.ts` + `lib/dashboard-server.ts`). It does **not** hook the
heartbeat directly: the backend reads the NDJSON ledgers + state files and
exposes the schema-validated config writer; this app just renders and drives it.

## Widgets

1. **Flight** — when the agent is on a flight (running a heartbeat mission) or
   idle: live status, tick, phase, mission, child session, elapsed vs the
   15-minute tick budget, lock state, and a recent-ticks table.
   *Source:* `state/heartbeat.current.json` + `state/heartbeat.lock` +
   `logs/heartbeat.log`.
2. **Output & thoughts** — the full child-session transcript (assistant text,
   reasoning traces, tool calls), streamed live while a mission is in flight
   and kept after it finishes.
   *Source:* the backend's `opencode serve` proxy (`/api/serve/*`).
3. **Metrics** — token spend, mission runs, execution time, cadence, and the
   error list with phases.
   *Source:* `logs/heartbeat.log` (+ `state/backlog.ndjson`, mood).
4. **Setup** — edit the heartbeat scheduler (`heartbeat.enabled`,
   `long_silence_factor`) and the autonomy dials (`level`,
   `autonomy.heartbeat.frequency`, `in_progress_lock`, `mission_token_budget`,
   `gate_scope`). Writes go through the backend's comment-preserving,
   round-trip-validated writer.
5. **Missions** — every mission offered to the heartbeat, with a switch to
   enable/disable each one. Toggling writes the restrict-only overlay
   `autonomy.missions.<id>.enabled` (off writes `enabled: false`, on removes
   it); a mission whose own file disables it is shown file-disabled and cannot
   be re-enabled here.
   *Source:* `.opencode/missions/*.md` + `autonomy.missions` (`/api/missions`).

The app reads data from **the folder it is launched for** — the opencode
project you point it at (default: the current directory).

## Run

The build output lands in `../static`, which is the backend's default
`staticDir` (`<project>/dashboard/static`) — no `DASHBOARD_STATIC_DIR` needed.

```sh
npm install
npm run build
./scripts/run.sh --dashboard      # or: ./scripts/dashboard-ctl.sh start
```

`run.sh --dashboard` brings the backend up alongside opencode (and stops it on
exit if it was the one that started it). The control script works standalone:
`./scripts/dashboard-ctl.sh start|stop|restart|status|logs`. Then open
http://127.0.0.1:4097 (port and proxy target come from `dashboard.port` and
`dashboard.serve_url` in `.opencode/sysop-config.yaml`).

### Development

```sh
npm start          # ng serve on :4200, proxying /api to the backend on :4097
```

In another terminal, start the backend for the target project:

```sh
node ../../.opencode/plugin/lib/dashboard-server.ts ../..
```

The Angular dev proxy (`proxy.conf.json`) forwards `/api` to `:4097` with
`changeOrigin: false`, so the backend's loopback Host/Origin checks still pass.

## Backend requirements (Nibble side)

This project depends on the **Nibble** changes that back the widgets:

- `lib/heartbeat.ts` — `heartbeat.current.json` marker (read/write).
- `plugin/heartbeat-hook.ts` — writes the marker on every phase transition and
  records `duration_ms` per tick.
- `lib/autonomy.ts` — the top-level `heartbeat:` section is writable.
- `lib/dashboard.ts` — `configSnapshot().heartbeat` + `heartbeatSnapshot()`.
- `lib/dashboard.ts` — `missionsSnapshot()` + `setMissionEnabled()` and
  `loadMissionStates()` in `lib/missions.ts` for the missions widget.
- `lib/dashboard-server.ts` — `GET /api/heartbeat`, `GET`/`PUT /api/missions`,
  static SPA asset serving, and the `DASHBOARD_STATIC_DIR` CLI hook.

## Theming

Phosphorstrap: `<html data-theme="dark|light|green-crt">`. Flip it live from
the header switcher.
