#!/usr/bin/env bash
# Nibble launcher — one supervisor for the instance and its side servers.
#
#   1. lock      — one run.sh per project (state/run.lock)
#   2. ollama    — probe OLLAMA_URL; if down, start it and remember ownership
#                  (machine-shared: a pre-existing server is always adopted)
#   3. ports     — resolve opencode/dashboard ports: CLI > env > config > auto
#                  (0 = kernel-assigned; a pinned port that is busy falls back
#                  to a free one and is logged — the config is never rewritten)
#   4. dashboard — always start (unless --no-dashboard) on its resolved port
#   5. opencode  — `opencode --port <serve-port> --hostname 127.0.0.1 "$@"`
#   6. cleanup   — stop only what this script started, remove its pointers and
#                  runtime manifest, then exit with opencode's code
#
# The live addresses are published under .opencode/state/:
#   serve-url     http://127.0.0.1:<opencode-port>
#   dashboard-url http://127.0.0.1:<dashboard-port>
#   runtime.json  both plus pids, requested/actual port fallbacks, ownership
#
# Usage: ./scripts/run.sh [--no-dashboard] [--headless]
#                         [--serve-port N] [--dashboard-port N] [--print-urls]
#                         [opencode args...]
set -euo pipefail

# Preserve the caller's stdin. An async child in a non-interactive shell has
# its stdin redirected to /dev/null before explicit redirections, which would
# leave the TUI unable to read the terminal; fd 3 keeps the real one.
exec 3<&0

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
EMBED_MODEL="${OLLAMA_MODEL:-qwen3-embedding:0.6b}"
STATE="$ROOT/.opencode/state"
LOGS="$ROOT/.opencode/logs"
NET="$ROOT/scripts/lib/net.mjs"
DASH_CTL="$ROOT/scripts/dashboard-ctl.sh"
RUN_LOG="$LOGS/run.log"

NO_DASH=0
HEADLESS=0
PRINT_URLS=0
SERVE_PORT_ARG=""
DASH_PORT_ARG=""
OPTS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --dashboard) shift ;; # legacy no-op: the dashboard is always started
    --no-dashboard) NO_DASH=1; shift ;;
    --headless) HEADLESS=1; shift ;;
    --print-urls) PRINT_URLS=1; shift ;;
    --serve-port) SERVE_PORT_ARG="${2:-}"; shift 2 ;;
    --dashboard-port) DASH_PORT_ARG="${2:-}"; shift 2 ;;
    --) shift; OPTS=("$@"); break ;;
    *) OPTS+=("$1"); shift ;;
  esac
done

mkdir -p "$STATE" "$LOGS"

log() {
  printf '%s run.sh: %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$RUN_LOG" >&2
}
die() {
  printf 'run.sh: %s\n' "$*" >&2
  exit 1
}

STARTED_OLLAMA=0
OLLAMA_PID=""
STARTED_DASH=0
DASH_URL=""
DASH_PID=""
SERVE_URL=""
OPENCODE_PID=""
CLEANED=0

write_pointer() { # write_pointer <file> <value>
  printf '%s\n' "$2" > "$1.tmp.$$"
  mv "$1.tmp.$$" "$1"
}

remove_pointer_if() { # remove_pointer_if <file> <expected>
  [ -f "$1" ] || return 0
  [ "$(cat "$1" 2>/dev/null || true)" = "$2" ] && rm -f "$1"
  return 0
}

write_manifest() {
  MANIFEST_FILE="$STATE/runtime.json" \
  MANIFEST_PROJECT="$ROOT" \
  MANIFEST_OWNER="$$" \
  MANIFEST_OPENCODE_PID="${OPENCODE_PID:-}" \
  MANIFEST_SERVE_PORT="$SERVE_PORT" \
  MANIFEST_SERVE_FALLBACK="$SERVE_FALLBACK" \
  MANIFEST_DASHBOARD_PID="${DASH_PID:-}" \
  MANIFEST_DASHBOARD_PORT="${DASH_PORT_ACTUAL:-0}" \
  MANIFEST_DASHBOARD_FALLBACK="$DASH_FALLBACK" \
  MANIFEST_OLLAMA_URL="$OLLAMA_URL" \
  MANIFEST_OLLAMA_OWNED="$STARTED_OLLAMA" \
  node -e '
    const fs = require("node:fs");
    const e = process.env;
    const num = (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n > 0 ? n : null;
    };
    const doc = {
      schema: 1,
      project: e.MANIFEST_PROJECT,
      owner_pid: Number(e.MANIFEST_OWNER) || null,
      started_at: new Date().toISOString(),
      opencode: {
        pid: num(e.MANIFEST_OPENCODE_PID),
        port: num(e.MANIFEST_SERVE_PORT),
        url: `http://127.0.0.1:${e.MANIFEST_SERVE_PORT}`,
        fallback: e.MANIFEST_SERVE_FALLBACK === "1",
      },
      dashboard: {
        pid: num(e.MANIFEST_DASHBOARD_PID),
        port: num(e.MANIFEST_DASHBOARD_PORT),
        url: e.MANIFEST_DASHBOARD_PORT === "0" ? null : `http://127.0.0.1:${e.MANIFEST_DASHBOARD_PORT}`,
        fallback: e.MANIFEST_DASHBOARD_FALLBACK === "1",
      },
      ollama: { url: e.MANIFEST_OLLAMA_URL, owned: e.MANIFEST_OLLAMA_OWNED === "1" },
    };
    const tmp = `${e.MANIFEST_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
    fs.renameSync(tmp, e.MANIFEST_FILE);
  '
}

cleanup() {
  [ "$CLEANED" = 1 ] && return 0
  CLEANED=1
  trap - EXIT INT TERM
  if [ -n "$OPENCODE_PID" ] && kill -0 "$OPENCODE_PID" 2>/dev/null; then
    kill -TERM "$OPENCODE_PID" 2>/dev/null || true
    wait "$OPENCODE_PID" 2>/dev/null || true
  fi
  if [ "$STARTED_DASH" = 1 ]; then
    "$DASH_CTL" stop >/dev/null 2>&1 9>&- || true
  fi
  if [ -n "$SERVE_URL" ]; then remove_pointer_if "$STATE/serve-url" "$SERVE_URL"; fi
  if [ -n "$DASH_URL" ]; then remove_pointer_if "$STATE/dashboard-url" "$DASH_URL"; fi
  rm -f "$STATE/runtime.json"
  if [ "$STARTED_OLLAMA" = 1 ] && [ -n "$OLLAMA_PID" ]; then
    kill "$OLLAMA_PID" 2>/dev/null || true
    wait "$OLLAMA_PID" 2>/dev/null || true
  fi
}

on_signal() {
  log "signal received — shutting down"
  if [ -n "$OPENCODE_PID" ] && kill -0 "$OPENCODE_PID" 2>/dev/null; then
    kill -TERM "$OPENCODE_PID" 2>/dev/null || true
  fi
  exit 130
}

trap cleanup EXIT
trap on_signal INT TERM

# --- config + port resolution ----------------------------------------------
cfg_serve="$(node "$NET" config "$ROOT" dashboard serve_port 2>/dev/null || true)"
cfg_dash="$(node "$NET" config "$ROOT" dashboard port 2>/dev/null || true)"
case "$cfg_serve" in ''|*[!0-9]*) cfg_serve=0 ;; esac
case "$cfg_dash" in ''|*[!0-9]*) cfg_dash=0 ;; esac

serve_req="${SERVE_PORT_ARG:-${NIBBLE_SERVE_PORT:-$cfg_serve}}"
dash_req="${DASH_PORT_ARG:-${DASHBOARD_PORT:-$cfg_dash}}"
case "$serve_req" in ''|*[!0-9]*) serve_req=0 ;; esac
case "$dash_req" in ''|*[!0-9]*) dash_req=0 ;; esac

read -r SERVE_PORT SERVE_FALLBACK <<< "$(node "$NET" free-port "$serve_req")"
read -r DASH_PORT DASH_FALLBACK <<< "$(node "$NET" free-port "$dash_req")"
[ -n "$SERVE_PORT" ] || die "could not allocate an opencode port"
[ -n "$DASH_PORT" ] || die "could not allocate a dashboard port"
SERVE_URL="http://127.0.0.1:$SERVE_PORT"

if [ "$PRINT_URLS" = 1 ]; then
  printf 'serve http://127.0.0.1:%s\n' "$SERVE_PORT"
  [ "$NO_DASH" = 1 ] || printf 'dashboard http://127.0.0.1:%s\n' "$DASH_PORT"
  exit 0
fi

# --- one supervisor per project --------------------------------------------
exec 9>"$STATE/run.lock"
if ! flock -n 9; then
  die "another run.sh is already active for $ROOT (state/run.lock held)"
fi

# Recover from a SIGKILLed previous run: children close fd 9, so they can
# outlive the supervisor. Stop the dashboard it left; refuse to duplicate a
# live opencode (the user may still be using it).
if [ -f "$STATE/runtime.json" ]; then
  read -r OLD_OC OLD_DASH <<< "$(node -e '
    try {
      const m = require(process.argv[1]);
      process.stdout.write(`${m.opencode?.pid ?? 0} ${m.dashboard?.pid ?? 0}`);
    } catch {}
  ' "$STATE/runtime.json" 2>/dev/null || true)"
  if [ -n "${OLD_DASH:-}" ] && [ "$OLD_DASH" != "0" ] && kill -0 "$OLD_DASH" 2>/dev/null; then
    log "stopping the orphaned dashboard from a previous run (pid $OLD_DASH)"
    DASHBOARD_TARGET="$ROOT" "$DASH_CTL" stop >/dev/null 2>&1 9>&- || kill -TERM "$OLD_DASH" 2>/dev/null || true
  fi
  if [ -n "${OLD_OC:-}" ] && [ "$OLD_OC" != "0" ] && kill -0 "$OLD_OC" 2>/dev/null; then
    die "an opencode from a previous run is still alive (pid $OLD_OC); stop it first"
  fi
fi

if [ "$SERVE_FALLBACK" = 1 ]; then
  log "opencode port $serve_req is busy; using $SERVE_PORT"
fi
if [ "$NO_DASH" = 0 ] && [ "$DASH_FALLBACK" = 1 ]; then
  log "dashboard port $dash_req is busy; using $DASH_PORT"
fi

# --- Ollama (machine-shared) ------------------------------------------------
if ! curl -sf --max-time 2 "$OLLAMA_URL/api/version" >/dev/null 2>&1; then
  command -v ollama >/dev/null 2>&1 \
    || die "ollama not found on PATH — install it from https://ollama.com"
  ollama serve 9>&- &
  OLLAMA_PID=$!
  STARTED_OLLAMA=1
  ready=0
  for _ in $(seq 1 60); do
    if curl -sf --max-time 2 "$OLLAMA_URL/api/version" >/dev/null 2>&1; then
      ready=1
      break
    fi
    kill -0 "$OLLAMA_PID" 2>/dev/null || die "ollama serve exited before becoming ready"
    sleep 0.5
  done
  [ "$ready" = 1 ] || die "timed out waiting for Ollama at $OLLAMA_URL"
fi

if ! curl -sf --max-time 3 "$OLLAMA_URL/api/tags" 2>/dev/null \
    | grep -q "\"name\":\"$EMBED_MODEL\""; then
  die "model '$EMBED_MODEL' is not pulled — run: ollama pull $EMBED_MODEL"
fi

# --- dashboard (always, unless --no-dashboard) ------------------------------
write_pointer "$STATE/serve-url" "$SERVE_URL"
if [ "$NO_DASH" = 0 ]; then
  [ -x "$DASH_CTL" ] || die "dashboard-ctl.sh not found or not executable at $DASH_CTL"
  if "$DASH_CTL" status 2>/dev/null | grep -q "state:  running"; then
    # One supervisor per project: take the backend over so it proxies this
    # instance and is stopped when this run ends.
    log "adopting the running dashboard (restart on $SERVE_URL)"
    DASHBOARD_PORT="$DASH_PORT" OPENCODE_SERVE_URL="$SERVE_URL" "$DASH_CTL" restart 9>&- \
      || die "dashboard failed to restart (see: $DASH_CTL logs)"
  else
    DASHBOARD_PORT="$DASH_PORT" OPENCODE_SERVE_URL="$SERVE_URL" "$DASH_CTL" start 9>&- \
      || die "dashboard failed to start (see: $DASH_CTL logs)"
  fi
  STARTED_DASH=1
  DASH_URL="$(cat "$STATE/dashboard-url" 2>/dev/null || true)"
  [ -n "$DASH_URL" ] || die "dashboard did not publish state/dashboard-url"
  DASH_PID="$(cat "$STATE/dashboard.pid" 2>/dev/null || true)"
  DASH_PORT_ACTUAL="$(node -e 'try { process.stdout.write(new URL(process.argv[1]).port) } catch {}' "$DASH_URL" 2>/dev/null || true)"
  DASH_PORT_ACTUAL="${DASH_PORT_ACTUAL:-$DASH_PORT}"
  if [ "$DASH_PORT_ACTUAL" != "$DASH_PORT" ]; then
    log "dashboard requested port $DASH_PORT is busy; using $DASH_PORT_ACTUAL"
    DASH_FALLBACK=1
  fi
  log "dashboard $DASH_URL"
fi

# run.sh owns the dashboard; keep the hook from spawning a second one.
export DASHBOARD_AUTOSTART=0
export OPENCODE_SERVE_URL="$SERVE_URL"
export NIBBLE_SERVE_PORT="$SERVE_PORT"

# --- opencode ---------------------------------------------------------------
if [ "$HEADLESS" = 1 ]; then
  write_manifest
  log "headless: side servers only (opencode $SERVE_URL)"
  # `wait` is interruptible by a trapped signal; a bare `sleep` defers it.
  while :; do
    sleep 3600 9>&- &
    wait $!
  done
fi

opencode --port "$SERVE_PORT" --hostname 127.0.0.1 "${OPTS[@]}" <&3 9>&- &
OPENCODE_PID=$!
write_manifest
for _ in $(seq 1 100); do
  if curl -sf --max-time 1 "$SERVE_URL/config" >/dev/null 2>&1; then
    break
  fi
  kill -0 "$OPENCODE_PID" 2>/dev/null || break
  sleep 0.2
done
if ! curl -sf --max-time 1 "$SERVE_URL/config" >/dev/null 2>&1; then
  log "warning: opencode is not answering $SERVE_URL/config — the dashboard transcript will be unavailable"
else
  log "opencode  $SERVE_URL"
fi

set +e
wait "$OPENCODE_PID"
RC=$?
set -e
exit "$RC"
