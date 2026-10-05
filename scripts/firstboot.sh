#!/usr/bin/env bash
# ecco first boot — generates the local-only layer from tracked templates.
#   1. Brain/Agent.md + Brain/User.md   (vault profile stubs, profile-hook inputs)
#   2. .opencode/sysop-config.yaml      (copied from the tracked example)
#   3. SETUP.md                         (rendered from SETUP.example.md via
#                                        platform detection)
# Idempotent: never overwrites an existing file; safe to run repeatedly.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CREATED=()
SKIPPED=()
TODAY="$(date +%F)"

mark() { # mark <path> <created|skipped>
  if [ "$2" = created ]; then CREATED+=("$1"); else SKIPPED+=("$1"); fi
}

# ---------------------------------------------------------------- 1. vault stubs
mkdir -p Brain

if [ ! -e "Brain/Agent.md" ]; then
  cat > "Brain/Agent.md" <<EOF
---
title: Agent
tags:
  - ai/opencode
  - agent/personality
  - agent/system-prompt
type: note
created: $TODAY
updated: $TODAY
status: draft
---

# Agent — Operating Instructions

Prompt-style persona directive injected into the agent's first turn. Read as
instructions, not description.

<!-- firstboot stub — describe your agent's personality, voice, and operating
     rules here. profile-hook injects this note into the first turn of every
     top-level session. -->
EOF
  mark "Brain/Agent.md" created
else
  mark "Brain/Agent.md" skipped
fi

if [ ! -e "Brain/User.md" ]; then
  cat > "Brain/User.md" <<EOF
---
title: User
tags:
  - personal
  - profile
  - agent/user-context
type: note
created: $TODAY
updated: $TODAY
status: draft
---

# User — Context

Working context about the user: identity, preferences, stack, projects,
hardware — whatever you want the agent to know about you.

<!-- firstboot stub — fill in your own context; profile-hook injects this
     note alongside Agent.md. -->
EOF
  mark "Brain/User.md" created
else
  mark "Brain/User.md" skipped
fi

# --------------------------------------------------------------- 2. local config
if [ ! -e ".opencode/sysop-config.yaml" ]; then
  cp .opencode/sysop-config.example.yaml .opencode/sysop-config.yaml
  mark ".opencode/sysop-config.yaml" created
else
  mark ".opencode/sysop-config.yaml" skipped
fi

# --------------------------------------------------------------------- 3. SETUP.md
if [ ! -e "SETUP.md" ]; then
  OS="$(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-unknown Linux}")" || OS="unknown Linux"
  KERNEL="$(uname -r)"
  ARCH="$(uname -m)"
  HOSTNAME_VAL="$(hostname 2>/dev/null || echo unknown)"
  DESKTOP="${XDG_CURRENT_DESKTOP:-n/a}"
  SHELL_BIN="${SHELL:-$(command -v bash)}"
  SHELL_NAME="$(basename "$SHELL_BIN")"
  USER_NAME="$(id -un)"
  HOME_DIR="$HOME"
  LOCALE="$(locale 2>/dev/null | awk -F= '/^LANG=/{print $2}')"
  LOCALE="${LOCALE:-unknown}"

  # -- package managers ------------------------------------------------
  PKG_TABLE="| Tool | Path | Notes |
| ---- | ---- | ----- |"
  PKG_MISSING=()
  for t in pacman apt dnf zypper eopkg brew yay paru pamac flatpak snap winget nix; do
    if p="$(command -v "$t" 2>/dev/null)"; then
      PKG_TABLE+=$'\n'"| \`$t\` | \`$p\` | detected |"
    else
      PKG_MISSING+=("$t")
    fi
  done
  PKG_NOTAVAIL=""
  if [ "${#PKG_MISSING[@]}" -gt 0 ]; then
    for m in "${PKG_MISSING[@]}"; do PKG_NOTAVAIL+="${PKG_NOTAVAIL:+, }$m"; done
  else
    PKG_NOTAVAIL="(none — everything above is available)"
  fi

  # -- services --------------------------------------------------------
  SERVICE_TABLE="| Tool | Version / Path |
| ---- | --------------- |"
  if p="$(command -v systemctl 2>/dev/null)"; then
    SV="$(systemctl --version 2>/dev/null | head -n1 | awk '{print $2}')"
    SERVICE_TABLE+=$'\n'"| \`systemctl\` | \`$p\` (systemd ${SV:-unknown}) |"
  else
    SERVICE_TABLE+=$'\n'"| systemd | not found |"
  fi

  # -- escalation ------------------------------------------------------
  ESCALATION_TABLE="| Tool | Path | Priority |
| ---- | ---- | -------- |"
  add_esc_row() { # add_esc_row <tool> <priority>
    if p="$(command -v "$1" 2>/dev/null)"; then
      ESCALATION_TABLE+=$'\n'"| \`$1\` | \`$p\` | $2 |"
    else
      ESCALATION_TABLE+=$'\n'"| \`$1\` | not found | $2 |"
    fi
  }
  add_esc_row pkexec 1st
  add_esc_row kdialog 2nd
  add_esc_row zenity 3rd
  if p="$(command -v ksshaskpass 2>/dev/null)"; then
    ESCALATION_TABLE+=$'\n'"| \`ksshaskpass\` | \`$p\` | SUDO_ASKPASS |"
  fi

  # -- sandbox ---------------------------------------------------------
  SANDBOX_TABLE="| Tool | Path | Notes |
| ---- | ---- | ----- |"
  for t in docker podman firejail bubblewrap; do
    if p="$(command -v "$t" 2>/dev/null)"; then
      SANDBOX_TABLE+=$'\n'"| \`$t\` | \`$p\` | detected |"
    else
      SANDBOX_TABLE+=$'\n'"| \`$t\` | not found | — |"
    fi
  done

  # -- resources -------------------------------------------------------
  RES_RAM="$(awk '/MemTotal/{printf "%.0f GB total", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo unknown)"
  RES_ROOT="$(df -h / 2>/dev/null | awk 'NR==2{print $2" total, "$5" used ("$1")"}' || echo unknown)"

  # -- config paths ----------------------------------------------------
  case "$SHELL_NAME" in
    fish) SHELL_CFG="~/.config/fish/config.fish" ;;
    zsh)  SHELL_CFG="~/.zshrc" ;;
    bash) SHELL_CFG="~/.bashrc" ;;
    *)    SHELL_CFG="n/a" ;;
  esac
  CONFIG_TABLE="| Purpose | Path |
| ------- | ---- |
| Shell config | \`$SHELL_CFG\` |
| Systemd units | \`/etc/systemd/system/\`, \`~/.config/systemd/user/\` |
| sysctl drop-ins | \`/etc/sysctl.d/\` |
| modprobe drop-ins | \`/etc/modprobe.d/\` |
| Audit log dir | \`~/.opencode-sysop/\` |"
  case "$DESKTOP" in
    *[Kk][Dd][Ee]*)
      CONFIG_TABLE+=$'\n'"| KDE settings | \`~/.config/kdeglobals\`, \`~/.config/plasma*.rc\` |" ;;
  esac
  if command -v Hyprland >/dev/null 2>&1; then
    CONFIG_TABLE+=$'\n'"| Hyprland config | \`~/.config/hypr/\` |"
  fi

  # -- agent notes -----------------------------------------------------
  AGENT_NOTES=""
  if command -v pacman >/dev/null 2>&1; then
    AGENT_NOTES+=$'\n'"- **Arch-based distro** — use \`pacman\` for system packages; \`yay\`/\`paru\` for the AUR if available."
  elif command -v apt >/dev/null 2>&1; then
    AGENT_NOTES+=$'\n'"- **Debian-based distro** — use \`apt\` for system packages."
  elif command -v dnf >/dev/null 2>&1; then
    AGENT_NOTES+=$'\n'"- **Fedora-based distro** — use \`dnf\` for system packages."
  else
    AGENT_NOTES+=$'\n'"- **Package management** — see the Package Managers table above."
  fi
  AGENT_NOTES+=$'\n'"- **Shell: \`$SHELL_NAME\`** — keep shell configuration in its native location (see Config Paths)."
  if [ -n "${WAYLAND_DISPLAY:-}" ]; then
    AGENT_NOTES+=$'\n'"- **Wayland session** detected — graphical escalation (pkexec) should work; kdialog is a native fallback."
  fi
  if command -v docker >/dev/null 2>&1; then
    AGENT_NOTES+=$'\n'"- **Docker** available for sandboxing; otherwise rely on opencode's own sub-agent isolation."
  else
    AGENT_NOTES+=$'\n'"- **No system sandbox** — rely on opencode's own sub-agent isolation (or install docker/firejail)."
  fi
  if command -v systemctl >/dev/null 2>&1; then
    AGENT_NOTES+=$'\n'"- **systemd** — all service management is via \`systemctl\`."
  fi
  # (AGENT_NOTES keeps its leading newline — the template places the list after a blank line)

  export TODAY OS KERNEL ARCH HOSTNAME="$HOSTNAME_VAL" DESKTOP SHELL_BIN USER_NAME \
         HOME_DIR LOCALE PKG_TABLE PKG_NOTAVAIL SERVICE_TABLE ESCALATION_TABLE \
         SANDBOX_TABLE RES_RAM RES_ROOT CONFIG_TABLE AGENT_NOTES

  TOKENS='${TODAY} ${OS} ${KERNEL} ${ARCH} ${HOSTNAME} ${DESKTOP} ${SHELL_BIN} ${USER_NAME} ${HOME_DIR} ${LOCALE} ${PKG_TABLE} ${PKG_NOTAVAIL} ${SERVICE_TABLE} ${ESCALATION_TABLE} ${SANDBOX_TABLE} ${RES_RAM} ${RES_ROOT} ${CONFIG_TABLE} ${AGENT_NOTES}'

  if command -v envsubst >/dev/null 2>&1; then
    envsubst "$TOKENS" < SETUP.example.md > SETUP.md
  else
    python3 - SETUP.example.md SETUP.md "$TOKENS" <<'PY'
import os, sys
src, dst, tokens = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(src, encoding="utf-8").read()
for tok in [t.strip("${}") for t in tokens.split() if t.strip()]:
    text = text.replace("${%s}" % tok, os.environ.get(tok, ""))
open(dst, "w", encoding="utf-8").write(text)
PY
  fi
  mark "SETUP.md" created
else
  mark "SETUP.md" skipped
fi

# ------------------------------------------------------------------------ summary
echo "firstboot: done ($(pwd))"
for f in "${CREATED[@]+"${CREATED[@]}"}"; do echo "  created: $f"; done
for f in "${SKIPPED[@]+"${SKIPPED[@]}"}"; do echo "  exists (skipped): $f"; done
