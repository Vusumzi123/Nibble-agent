#!/usr/bin/env bash
# Nibble launcher — start Ollama for the embedding MCP and (optionally) the
# dashboard backend, run opencode, and stop whatever this script started —
# but only that; pre-existing servers are untouched.
#   1. server    — probe OLLAMA_URL; if down, `ollama serve &` and wait ready
#   2. model     — require the embedding model (OLLAMA_MODEL) is present
#   3. dashboard — with --dashboard: adopt a running backend or start one
#                  (scripts/dashboard-ctl.sh; port/proxy from sysop-config)
#   4. run       — `opencode "$@"`, exit code propagates
#   5. cleanup   — stop the dashboard and kill+wait the Ollama PID we started
#
# Usage: ./scripts/run.sh [--dashboard] [opencode args...]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
EMBED_MODEL="${OLLAMA_MODEL:-qwen3-embedding:0.6b}"

DASHBOARD=0
if [ "${1:-}" = "--dashboard" ]; then
  DASHBOARD=1
  shift
fi

STARTED=0
OLLAMA_PID=""
STARTED_DASH=0

die() { printf '%s\n' "run.sh: $*" >&2; exit 1; }

cleanup() {
  if [ "$STARTED_DASH" = 1 ]; then
    "$ROOT/scripts/dashboard-ctl.sh" stop || true
  fi
  if [ "$STARTED" = 1 ] && [ -n "$OLLAMA_PID" ]; then
    kill "$OLLAMA_PID" 2>/dev/null || true
    wait "$OLLAMA_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# 1. server — is Ollama already answering?
if ! curl -sf --max-time 2 "$OLLAMA_URL/api/version" >/dev/null 2>&1; then
  command -v ollama >/dev/null 2>&1 \
    || die "ollama not found on PATH — install it from https://ollama.com"
  ollama serve &
  OLLAMA_PID=$!
  STARTED=1
  ready=0
  for _ in $(seq 1 60); do
    if curl -sf --max-time 2 "$OLLAMA_URL/api/version" >/dev/null 2>&1; then
      ready=1
      break
    fi
    kill -0 "$OLLAMA_PID" 2>/dev/null \
      || die "ollama serve exited before becoming ready"
    sleep 0.5
  done
  [ "$ready" = 1 ] || die "timed out waiting for Ollama at $OLLAMA_URL"
fi

# 2. model — the embedding model must already be pulled.
if ! curl -sf --max-time 3 "$OLLAMA_URL/api/tags" 2>/dev/null \
    | grep -q "\"name\":\"$EMBED_MODEL\""; then
  die "model '$EMBED_MODEL' is not pulled — run: ollama pull $EMBED_MODEL"
fi

# 3. dashboard — adopt if already up (another run.sh, ctl, or a manual start);
# otherwise start it and own its shutdown, mirroring the Ollama contract.
if [ "$DASHBOARD" = 1 ]; then
  CTL="$ROOT/scripts/dashboard-ctl.sh"
  [ -x "$CTL" ] || die "dashboard-ctl.sh not found or not executable at $CTL"
  if "$CTL" status 2>/dev/null | grep -q "state:  running"; then
    echo "run.sh: dashboard already running — leaving it up after exit"
  else
    "$CTL" start || die "dashboard failed to start (see: $CTL logs)"
    STARTED_DASH=1
  fi
fi

# 4. run
opencode "$@"
