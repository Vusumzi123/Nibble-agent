#!/usr/bin/env bash
# Nibble launcher — one supervisor for the instance.
#
#   1. lock      — one run.sh per project (state/run.lock)
#   2. ollama    — probe OLLAMA_URL; if down, start it and remember ownership
#                  (machine-shared: a pre-existing server is always adopted)
#   3. port      — resolve the opencode port: CLI > env > auto
#                  (0 = kernel-assigned; a pinned port that is busy falls back
#                  to a free one and is logged)
#   4. opencode  — `opencode --port <serve-port> --hostname 127.0.0.1 "$@"`
#   5. cleanup   — stop only what this script started, remove its pointers and
#                  runtime manifest, then exit with opencode's code
#
# The live address is published under .opencode/state/:
#   serve-url     http://127.0.0.1:<opencode-port>
#   runtime.json  the pid, port, fallback flag, and Ollama ownership
#
# Usage: ./scripts/run.sh [--serve-port N] [--print-urls] [opencode args...]
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
RUN_LOG="$LOGS/run.log"

PRINT_URLS=0
SERVE_PORT_ARG=""
OPTS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --print-urls) PRINT_URLS=1; shift ;;
    --serve-port) SERVE_PORT_ARG="${2:-}"; shift 2 ;;
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
  if [ -n "$SERVE_URL" ]; then remove_pointer_if "$STATE/serve-url" "$SERVE_URL"; fi
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

# --- port resolution --------------------------------------------------------
serve_req="${SERVE_PORT_ARG:-${NIBBLE_SERVE_PORT:-0}}"
case "$serve_req" in ''|*[!0-9]*) serve_req=0 ;; esac

read -r SERVE_PORT SERVE_FALLBACK <<< "$(node "$NET" free-port "$serve_req")"
[ -n "$SERVE_PORT" ] || die "could not allocate an opencode port"
SERVE_URL="http://127.0.0.1:$SERVE_PORT"

if [ "$PRINT_URLS" = 1 ]; then
  printf 'serve http://127.0.0.1:%s\n' "$SERVE_PORT"
  exit 0
fi

# --- one supervisor per project --------------------------------------------
exec 9>"$STATE/run.lock"
if ! flock -n 9; then
  die "another run.sh is already active for $ROOT (state/run.lock held)"
fi

# Recover from a SIGKILLed previous run: children close fd 9, so they can
# outlive the supervisor. Refuse to duplicate a live opencode (the user may
# still be using it).
if [ -f "$STATE/runtime.json" ]; then
  read -r OLD_OC <<< "$(node -e '
    try {
      const m = require(process.argv[1]);
      process.stdout.write(`${m.opencode?.pid ?? 0}`);
    } catch {}
  ' "$STATE/runtime.json" 2>/dev/null || true)"
  if [ -n "${OLD_OC:-}" ] && [ "$OLD_OC" != "0" ] && kill -0 "$OLD_OC" 2>/dev/null; then
    die "an opencode from a previous run is still alive (pid $OLD_OC); stop it first"
  fi
fi

if [ "$SERVE_FALLBACK" = 1 ]; then
  log "opencode port $serve_req is busy; using $SERVE_PORT"
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

# --- opencode ---------------------------------------------------------------
write_pointer "$STATE/serve-url" "$SERVE_URL"
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
  log "warning: opencode is not answering $SERVE_URL/config"
else
  log "opencode  $SERVE_URL"
fi

set +e
wait "$OPENCODE_PID"
RC=$?
set -e
exit "$RC"
