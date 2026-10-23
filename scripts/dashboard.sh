#!/usr/bin/env bash
# Nibble dashboard backend launcher (kanban card 8 — autonomy-harness §9.2).
# Starts the local `autonomy-dashboard-api` Node/TS server:
#   - config API (schema-validated writes), metrics/ledger/backlog reads,
#   - streaming single-origin proxy to `opencode serve`,
#   - CSRF-gated mutations; loopback bind only (auth = card 11).
#
# Usage: ./scripts/dashboard.sh [project-dir]
# Env:    DASHBOARD_PORT (default dashboard.port, 0 = auto),
#         OPENCODE_SERVE_URL (explicit proxy target; unset = live pointer/discovery)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${1:-$ROOT}"

exec node "$ROOT/.opencode/plugin/lib/dashboard-server.ts" "$DIR"
