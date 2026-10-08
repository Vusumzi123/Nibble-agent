#!/usr/bin/env bash
# Nibble launcher — start Ollama for the embedding MCP, run opencode, and stop
# Ollama again on exit — but only if this script started it.
#   1. server   — probe OLLAMA_URL; if down, `ollama serve &` and wait ready
#   2. model    — require the embedding model (OLLAMA_MODEL) is present
#   3. run      — `opencode "$@"`, exit code propagates
#   4. cleanup  — kill+wait the server PID we started; pre-existing server untouched
#
# Usage: ./scripts/run.sh [opencode args...]
set -euo pipefail

OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
EMBED_MODEL="${OLLAMA_MODEL:-qwen3-embedding:0.6b}"

STARTED=0
OLLAMA_PID=""

die() { printf '%s\n' "run.sh: $*" >&2; exit 1; }

cleanup() {
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

# 3. run
opencode "$@"
