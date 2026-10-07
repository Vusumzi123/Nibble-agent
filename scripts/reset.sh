#!/usr/bin/env bash
# Nibble reset — return the project to a fresh (just-cloned) state by removing
# the local-only layer that setup.sh and the runtime hooks generate. Only
# gitignored local files are removed; tracked source is never touched.
#   1. local config   — .opencode/sysop-config.yaml
#   2. vault          — Brain/
#   3. platform file  — SETUP.md
#   4. transient      — .opencode/state/, .opencode/logs/
#   5. caches         — .opencode/scripts/__pycache__/
# With --dev, also .opencode/node_modules/ and .temp/ (test/build artifacts).
# Idempotent: missing paths are skipped.
#
# Usage: ./scripts/reset.sh [--dry-run] [--yes] [--dev]
set -euo pipefail

DRY=0
ASSUME_YES=0
INCLUDE_DEV=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --yes|-y)  ASSUME_YES=1 ;;
    --dev)     INCLUDE_DEV=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "reset: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TARGETS=(
  ".opencode/sysop-config.yaml"
  "Brain"
  "SETUP.md"
  ".opencode/state"
  ".opencode/logs"
  ".opencode/scripts/__pycache__"
)
if [ "$INCLUDE_DEV" -eq 1 ]; then
  TARGETS+=(".opencode/node_modules" ".temp")
fi

present=()
for t in "${TARGETS[@]}"; do
  [ -e "$t" ] && present+=("$t")
done

if [ "${#present[@]}" -eq 0 ]; then
  echo "reset: already fresh — nothing to remove."
  exit 0
fi

echo "reset — $REPO_ROOT"
echo "the following local-only paths will be removed:"
for t in "${present[@]}"; do
  echo "  rm -rf $t"
done

if [ "$DRY" -eq 1 ]; then
  echo "reset: dry-run — nothing removed."
  exit 0
fi

if [ "$ASSUME_YES" -eq 0 ]; then
  printf 'Remove these %d path(s)? [y/N]: ' "${#present[@]}" >&2
  IFS= read -r a || a=""
  case "$a" in y|Y|yes|YES) ;; *) echo "reset: aborted." >&2; exit 1 ;; esac
fi

for t in "${present[@]}"; do
  rm -rf -- "$t"
  echo "  removed $t"
done

echo "reset: done ($(pwd))"
echo "next: ./scripts/setup.sh"
