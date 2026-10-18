#!/usr/bin/env bash
# Nibble dashboard backend control (start / stop / restart / status).
#
# Manages only the dashboard backend on DASHBOARD_PORT (default 4097). It does
# NOT manage `opencode serve` (default 127.0.0.1:4096): that process owns
# sessions and the Output & thoughts transcript stream, and opencode owns its
# lifecycle. `status` reports whether the proxy target is reachable.
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
#   DASHBOARD_PORT       backend port              (default: 4097)
#   OPENCODE_SERVE_URL   proxy target              (default: http://127.0.0.1:4096)
#   DASHBOARD_STATIC_DIR built UI directory        (default: auto-detect)
#   NODE_BIN             node executable           (default: command -v node)
set -euo pipefail

usage() {
  sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${DASHBOARD_TARGET:-$HERE}"
if ! TARGET="$(cd "$TARGET" 2>/dev/null && pwd)"; then
  echo "error: target directory not found: ${DASHBOARD_TARGET:-$HERE}" >&2
  exit 1
fi

PORT="${DASHBOARD_PORT:-4097}"
SERVE_URL="${OPENCODE_SERVE_URL:-http://127.0.0.1:4096}"
BACKEND="$TARGET/.opencode/plugin/lib/dashboard-server.ts"
STATE_DIR="$TARGET/.opencode/state"
LOG_DIR="$TARGET/.opencode/logs"
PID_FILE="$STATE_DIR/dashboard.pid"
LOG_FILE="$LOG_DIR/dashboard.log"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

CURL=(curl --noproxy '127.0.0.1,localhost' --max-time 3 -sS)

http_code() {
  "${CURL[@]}" -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || printf '000'
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
  for cand in \
    "$TARGET/projects/Nibble-dashboard/dist/dashboard/browser" \
    "$TARGET/projects/Nibble-dashboard/dist/browser" \
    "$TARGET/dashboard/static" \
    "$TARGET/dashboard/dist/dashboard/browser"; do
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
  if [ "$code" != "000" ]; then
    echo "error: port $PORT already answers (HTTP $code) but no matching dashboard-server process; refusing to start" >&2
    return 1
  fi

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
  local pid code proxy ui
  pid="$(current_pid || true)"
  ui="$(resolve_ui)"
  echo "target: $TARGET"
  echo "url:    http://127.0.0.1:$PORT"
  echo "ui:     ${ui:-<built-in $TARGET/dashboard/static>}"
  echo "log:    $LOG_FILE"

  if [ -n "$pid" ]; then
    echo "state:  running (pid $pid)"
    echo "health: HTTP $(health_code)"
    proxy="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$SERVE_URL/" 2>/dev/null || printf '000')"
    echo "proxy:  $SERVE_URL (HTTP $proxy)"
  else
    code="$(health_code)"
    if [ "$code" = "000" ]; then
      echo "state:  stopped"
    else
      echo "state:  stopped (port $PORT held by a foreign process, HTTP $code)"
    fi
    proxy="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$SERVE_URL/" 2>/dev/null || printf '000')"
    echo "proxy:  $SERVE_URL (HTTP $proxy)"
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
