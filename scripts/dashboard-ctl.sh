#!/usr/bin/env bash
# Nibble dashboard backend control (start / stop / restart / status).
#
# Manages only the dashboard backend. It does NOT manage `opencode serve`:
# that process owns sessions and the Output & thoughts transcript stream, and
# opencode owns its lifecycle. `status` reports whether the proxy target is
# reachable.
#
# Port and proxy target come from `dashboard.port` / `dashboard.serve_url` in
# .opencode/sysop-config.yaml (env DASHBOARD_PORT / OPENCODE_SERVE_URL
# override). The static UI is served from <target>/dashboard/static — the
# committed `npm run build` output of dashboard/ui.
#
# Usage:
#   ./scripts/dashboard-ctl.sh start
#   ./scripts/dashboard-ctl.sh stop [--force]
#   ./scripts/dashboard-ctl.sh restart
#   ./scripts/dashboard-ctl.sh status
#   ./scripts/dashboard-ctl.sh logs [lines]
#
# Env:
#   DASHBOARD_TARGET     project to observe        (default: parent of scripts/)
#   DASHBOARD_PORT       backend port override     (default: dashboard.port config)
#   OPENCODE_SERVE_URL   proxy target override     (default: dashboard.serve_url config)
#   DASHBOARD_STATIC_DIR built UI directory        (default: <target>/dashboard/static)
#   NODE_BIN             node executable           (default: command -v node)
set -euo pipefail

usage() {
  sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${DASHBOARD_TARGET:-$HERE}"
if ! TARGET="$(cd "$TARGET" 2>/dev/null && pwd)"; then
  echo "error: target directory not found: ${DASHBOARD_TARGET:-$HERE}" >&2
  exit 1
fi

PORT="${DASHBOARD_PORT:-4097}"
# Display-only fallback for `status` when the backend is down; when it is up,
# status reports the proxy target from /api/health (config-aware).
SERVE_URL="${OPENCODE_SERVE_URL:-http://127.0.0.1:4096}"
BACKEND="$TARGET/.opencode/plugin/lib/dashboard-server.ts"
STATE_DIR="$TARGET/.opencode/state"
LOG_DIR="$TARGET/.opencode/logs"
PID_FILE="$STATE_DIR/dashboard.pid"
LOG_FILE="$LOG_DIR/dashboard.log"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

CURL=(curl --noproxy '127.0.0.1,localhost' --max-time 3 -sS)

http_code() {
  # curl prints 000 via -w even when the connection fails; do not append a
  # second fallback (that produced "000000" and looked like a live port).
  local code
  code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$1" 2>/dev/null)" || true
  printf '%s' "${code:-000}"
}

health_code() {
  http_code "http://127.0.0.1:$PORT/api/health"
}

alive() {
  [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null
}

is_ours() {
  local pid="${1:-}"
  alive "$pid" || return 1
  local cmd
  cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  case "$cmd" in
    *dashboard-server.ts*"$TARGET"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Find a dashboard-server process for this target even when the pid file is
# missing or stale (e.g. it was started manually before this script existed).
find_running() {
  local p pid cmd found=""
  for p in /proc/[0-9]*/cmdline; do
    [ -r "$p" ] || continue
    cmd="$(tr '\0' ' ' < "$p" 2>/dev/null || true)"
    case "$cmd" in
      *dashboard-server.ts*"$TARGET"*)
        pid="${p#/proc/}"
        pid="${pid%/cmdline}"
        if [ -z "$found" ]; then
          found="$pid"
        else
          echo "warning: multiple dashboard backends for $TARGET: $found, $pid" >&2
        fi
        ;;
    esac
  done
  [ -n "$found" ] && printf '%s\n' "$found"
}

current_pid() {
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if is_ours "$pid"; then
    printf '%s\n' "$pid"
    return 0
  fi
  pid="$(find_running || true)"
  [ -n "$pid" ] && printf '%s\n' "$pid"
}

resolve_ui() {
  local cand
  if [ -n "${DASHBOARD_STATIC_DIR:-}" ] && [ -f "$DASHBOARD_STATIC_DIR/index.html" ]; then
    printf '%s\n' "$DASHBOARD_STATIC_DIR"
    return 0
  fi
  # Integrated build output first (dashboard/ui → npm run build → dashboard/static);
  # legacy per-checkout locations stay as fallback for one release.
  for cand in \
    "$TARGET/dashboard/static" \
    "$TARGET/projects/Nibble-dashboard/dist/dashboard/browser" \
    "$TARGET/projects/Nibble-dashboard/dist/browser" \
    "$TARGET/../Nibble-dashboard/dist/dashboard/browser" \
    "$TARGET/../Nibble-dashboard/dist/browser"; do
    if [ -f "$cand/index.html" ]; then
      printf '%s\n' "$cand"
      return 0
    fi
  done
  return 0
}

do_start() {
  local pid code ui i
  pid="$(current_pid || true)"
  if [ -n "$pid" ]; then
    echo "dashboard: already running (pid $pid)"
    mkdir -p "$STATE_DIR"
    printf '%s\n' "$pid" > "$PID_FILE"
    return 0
  fi

  if [ ! -f "$BACKEND" ]; then
    echo "error: missing backend: $BACKEND" >&2
    return 1
  fi
  if [ -z "$NODE_BIN" ]; then
    echo "error: node not found; set NODE_BIN or load your node manager" >&2
    return 1
  fi

  code="$(health_code)"
  case "$code" in
    "" | "000") ;;
    *)
      echo "error: port $PORT already answers (HTTP $code) but no matching dashboard-server process; refusing to start" >&2
      return 1
      ;;
  esac

  mkdir -p "$STATE_DIR" "$LOG_DIR"
  ui="$(resolve_ui)"

  echo "dashboard: starting on http://127.0.0.1:$PORT"
  (
    cd "$TARGET"
    if [ -n "$ui" ]; then
      export DASHBOARD_STATIC_DIR="$ui"
    fi
    nohup "$NODE_BIN" "$BACKEND" "$TARGET" >> "$LOG_FILE" 2>&1 </dev/null &
    printf '%s\n' "$!" > "$PID_FILE"
  )

  for i in $(seq 1 50); do
    if [ "$(health_code)" = "200" ]; then
      echo "dashboard: up (pid $(cat "$PID_FILE"))  log: $LOG_FILE"
      return 0
    fi
    sleep 0.2
  done

  echo "error: dashboard did not become healthy within 10s; last log lines:" >&2
  tail -n 10 "$LOG_FILE" >&2 2>/dev/null || true
  return 1
}

do_stop() {
  local force="${1:-0}" pid i
  pid="$(current_pid || true)"
  if [ -z "$pid" ]; then
    echo "dashboard: not running"
    rm -f "$PID_FILE"
    return 0
  fi

  echo "dashboard: stopping (pid $pid)"
  kill -TERM "$pid" 2>/dev/null || true
  for i in $(seq 1 50); do
    alive "$pid" || break
    sleep 0.2
  done

  if alive "$pid"; then
    if [ "$force" = "1" ]; then
      echo "dashboard: force-killing (pid $pid)" >&2
      kill -KILL "$pid" 2>/dev/null || true
      sleep 0.3
    else
      echo "error: pid $pid is still alive after 10s; rerun with 'stop --force'" >&2
      return 1
    fi
  fi

  rm -f "$PID_FILE"
  echo "dashboard: stopped"
}

do_status() {
  local pid code proxy ui hcode health_serve
  pid="$(current_pid || true)"
  ui="$(resolve_ui)"
  hcode="$(health_code)"
  echo "target: $TARGET"
  echo "url:    http://127.0.0.1:$PORT"
  echo "ui:     ${ui:-<built-in $TARGET/dashboard/static>}"
  echo "log:    $LOG_FILE"

  # When the backend is up, /api/health reports the serve_url it resolved
  # (opts > env > dashboard.serve_url config > default) — trust that over
  # this script's env-derived guess.
  health_serve=""
  if [ "$hcode" = "200" ]; then
    health_serve="$("${CURL[@]}" "http://127.0.0.1:$PORT/api/health" 2>/dev/null \
      | sed -n 's/.*"serve_url": *"\([^"]*\)".*/\1/p')" || true
  fi
  proxy="${health_serve:-$SERVE_URL}"

  if [ -n "$pid" ]; then
    echo "state:  running (pid $pid)"
    echo "health: HTTP $hcode"
    echo "proxy:  $proxy (HTTP $(http_code "$proxy/"))"
  else
    if [ "$hcode" = "000" ]; then
      echo "state:  stopped"
    else
      echo "state:  stopped (port $PORT held by a foreign process, HTTP $hcode)"
    fi
    echo "proxy:  $proxy (HTTP $(http_code "$proxy/"))"
  fi
}

cmd="${1:-status}"
shift || true

case "$cmd" in
  start|up)
    do_start
    ;;
  stop|down)
    force=0
    if [ "${1:-}" = "--force" ] || [ "${1:-}" = "-f" ]; then
      force=1
    fi
    do_stop "$force"
    ;;
  restart)
    do_stop 0
    do_start
    ;;
  status|ps)
    do_status
    ;;
  logs)
    tail -n "${1:-50}" "$LOG_FILE"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "unknown command: $cmd" >&2
    usage >&2
    exit 2
    ;;
esac
