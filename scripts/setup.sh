#!/usr/bin/env bash
# Nibble setup — install dependencies, connect a model, and generate the
# local-only layer from the tracked templates.
#   0. preflight  — Arch Linux only; must not run as root
#   1. deps       — opencode, nodejs+npm (markdown-vault MCP + tests), gettext
#   2. LLM        — connect a provider (`opencode providers login`)
#   3. config     — .opencode/sysop-config.yaml + model selection
#   4. skip       — disable LLM-dependent features when no provider connected
#   5. profiles   — Brain/Agent.md + Brain/User.md interactive Q&A
#   6. SETUP.md   — platform detection (rendered from SETUP.example.md)
#   7. summary
# Idempotent: skips anything already done; safe to run repeatedly.
#
# Usage: ./scripts/setup.sh [--dry-run]
set -euo pipefail

DRY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "setup: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CONFIG=".opencode/sysop-config.yaml"
EXAMPLE=".opencode/sysop-config.example.yaml"
GLOBAL_CONFIG="$HOME/.config/opencode/opencode.json"
AUTH="$HOME/.local/share/opencode/auth.json"
TODAY="$(date +%F)"

CREATED=()
SKIPPED=()
CHANGED=()
DISABLED=0
SKIP_FEATURES=0

mark() { if [ "$2" = created ]; then CREATED+=("$1"); else SKIPPED+=("$1"); fi; }
have() { command -v "$1" >/dev/null 2>&1; }

ask() { # ask "prompt" [default] -> stdout (prompt goes to stderr)
  local p="$1" d="${2-}" a=""
  if [ -n "$d" ]; then printf '%s [%s]: ' "$p" "$d" >&2; else printf '%s: ' "$p" >&2; fi
  IFS= read -r a || a=""
  printf '%s' "${a:-$d}"
}
confirm() { # confirm "prompt" [default y|n] -> 0 if yes
  local p="$1" d="${2:-y}" a=""
  if [ "$d" = y ]; then printf '%s [Y/n]: ' "$p" >&2; else printf '%s [y/N]: ' "$p" >&2; fi
  IFS= read -r a || a=""
  a="${a:-$d}"
  case "$a" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# ---------------------------------------------------------------- 0. preflight
if [ "$(id -u)" -eq 0 ]; then
  echo "setup: do not run as root — run as your normal user (sudo is used internally)." >&2
  exit 1
fi
if ! have pacman; then
  echo "setup: Nibble currently supports Arch Linux only (pacman not found)." >&2
  exit 1
fi

echo "Nibble setup — $REPO_ROOT"

# ---------------------------------------------------------------- 1. deps
echo "== dependencies =="
install_pkg() { # install_pkg <pacman-package> <probe-command>
  if have "$2"; then
    echo "  $2 found (ok)"
    SKIPPED+=("dep:$1")
    return
  fi
  echo "  installing $1 ..."
  if [ "$DRY" -eq 1 ]; then
    echo "  [dry-run] sudo pacman -S --needed --noconfirm $1"
  else
    echo "[ROOT REQUIRED] sudo pacman -S --needed --noconfirm $1" >&2
    sudo pacman -S --needed --noconfirm "$1"
  fi
  CHANGED+=("dep:$1")
}
install_pkg opencode opencode
install_pkg nodejs node
install_pkg npm npx
install_pkg gettext envsubst

if ! have node; then
  echo "setup: node is required after the dependency step." >&2
  exit 1
fi

# ---------------------------------------------------------------- 2. LLM
echo "== LLM provider =="
count_creds() {
  [ -f "$AUTH" ] || { echo 0; return; }
  node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(Object.keys(j).length))}catch(e){process.stdout.write("0")}' "$AUTH" 2>/dev/null || echo 0
}
LLM_OK=0
if [ "$(count_creds)" -gt 0 ]; then
  echo "  provider connected ($(count_creds) credential(s))"
  LLM_OK=1
else
  if confirm "No LLM provider is connected. Connect one now (opencode providers login)?" y; then
    if [ "$DRY" -eq 1 ]; then
      echo "  [dry-run] opencode providers login"
      SKIP_FEATURES=1
    else
      opencode providers login || true
      if [ "$(count_creds)" -gt 0 ]; then
        echo "  provider connected"
        LLM_OK=1
      else
        echo "  still no provider — LLM features will be disabled"
        SKIP_FEATURES=1
      fi
    fi
  else
    echo "  skipped — LLM features will be disabled"
    SKIP_FEATURES=1
  fi
fi

# ------------------------------------------------- config edit helpers (node)
pick_model() { # pick_model "label" -> stdout model id or empty
  local label="$1" a i=1
  local -a models=()
  while IFS= read -r l; do [ -n "$l" ] && models+=("$l"); done < <(opencode models 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | grep -E '/[^/]+$' | sort -u)
  if [ "${#models[@]}" -eq 0 ]; then
    ask "$label — no models listed; enter provider/model (Enter to skip)"
    return 0
  fi
  echo "  available models:" >&2
  for m in "${models[@]}"; do printf '    %3d) %s\n' "$i" "$m" >&2; i=$((i + 1)); done
  a="$(ask "$label — number or provider/model (Enter to skip)")"
  [ -z "$a" ] && return 0
  if printf '%s' "$a" | grep -qE '^[0-9]+$' && [ "$a" -ge 1 ] && [ "$a" -le "${#models[@]}" ]; then
    printf '%s' "${models[$((a - 1))]}"
  else
    printf '%s' "$a"
  fi
}

write_global_model() { # write_global_model provider/model  (merges into global config)
  local d
  d="$(dirname "$GLOBAL_CONFIG")"
  mkdir -p "$d"
  [ -f "$GLOBAL_CONFIG" ] && cp "$GLOBAL_CONFIG" "$GLOBAL_CONFIG.bak.$(date +%s)"
  node -e '
const fs=require("fs"),p=process.argv[1],m=process.argv[2];
let j={}; try{ j=JSON.parse(fs.readFileSync(p,"utf8")); }catch(e){ j={}; }
j.model=m;
fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n");
' "$GLOBAL_CONFIG" "$1"
}

yaml_replace_writer() { # yaml_replace_writer provider/model
  node -e '
const fs=require("fs"),f=process.argv[1],m=process.argv[2];
let s=fs.readFileSync(f,"utf8");
const re=/  # writer_model: provider\/model[^\n]*\n  # +#[^\n]*\n/;
if(!re.test(s)){ console.error("writer_model placeholder not found"); process.exit(2); }
fs.writeFileSync(f, s.replace(re,"  writer_model: "+m+"\n"));
' "$CONFIG" "$1"
}

apply_decisions_openjev() { # backend base_url model keyfile
  node -e '
const fs=require("fs"),f=process.argv[1];
const b=process.argv[2],u=process.argv[3],mo=process.argv[4],k=process.argv[5];
let s=fs.readFileSync(f,"utf8");
s=s.replace(/^(\s*provider:\s*)rules\b.*$/m,(m0,p1)=>p1+"openjev");
s=s.replace(/^  # backend: llamacpp.*$/m,()=>"  backend: "+b);
s=s.replace(/^  # transport: chat.*$/m,()=>"  transport: chat");
s=s.replace(/^  # base_url: .*$/m,()=>"  base_url: "+u);
s=s.replace(/^  # model: .*$/m,()=>"  model: "+mo);
if(k) s=s.replace(/^  # api_key_file: .*$/m,()=>"  api_key_file: "+k);
fs.writeFileSync(f,s);
if(!/\n  provider: openjev/.test("\n"+s)){ console.error("decisions: provider not set"); process.exit(2); }
' "$CONFIG" "$1" "$2" "$3" "$4"
}

set_block_key() { # set_block_key <file> <block> <key> <value>
  node -e '
const fs=require("fs"),f=process.argv[1],block=process.argv[2],key=process.argv[3],val=process.argv[4];
const lines=fs.readFileSync(f,"utf8").split("\n");
const esc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
const bRe=new RegExp("^"+esc(block)+":\\s*(#.*)?$");
let bi=-1;
for(let i=0;i<lines.length;i++){ if(bRe.test(lines[i])){ bi=i; break; } }
if(bi<0){ console.error("block not found: "+block); process.exit(2); }
let end=bi+1;
for(; end<lines.length; end++){ const l=lines[end]; if(l.trim()===""||!/^\s/.test(l)) break; }
const kRe=new RegExp("^(\\s+)"+esc(key)+":\\s");
let found=false;
for(let i=bi+1;i<end;i++){ const mm=lines[i].match(kRe); if(mm){ lines[i]=mm[1]+key+": "+val; found=true; break; } }
if(!found){ lines.splice(end,0,"  "+key+": "+val); }
fs.writeFileSync(f,lines.join("\n"));
' "$1" "$2" "$3" "$4"
}

# ---------------------------------------------------------------- 3. config
echo "== config =="
FRESH_CONFIG=0
if [ ! -e "$CONFIG" ]; then
  cp "$EXAMPLE" "$CONFIG"
  mark "$CONFIG" created
  FRESH_CONFIG=1
  echo "  created $CONFIG"
else
  mark "$CONFIG" skipped
  echo "  $CONFIG exists (kept)"
fi

if [ "$FRESH_CONFIG" -eq 1 ]; then
  if [ "$LLM_OK" -eq 1 ]; then
    echo "== models =="
    MAIN="$(pick_model 'Default session model')"
    if [ -n "$MAIN" ]; then
      if [ "$DRY" -eq 1 ]; then
        echo "  [dry-run] write model=$MAIN to $GLOBAL_CONFIG"
      else
        write_global_model "$MAIN"
        echo "  session model = $MAIN (written to $GLOBAL_CONFIG)"
      fi
    else
      echo "  session model — left to opencode default"
    fi

    echo "  profile-writer model:" >&2
    echo "    1) inherit the session model (default)" >&2
    echo "    2) pick a different model" >&2
    W="$(ask 'Choose' 1)"
    if [ "$W" = 2 ]; then
      WM="$(pick_model 'profile-writer model')"
      if [ -n "$WM" ]; then
        if [ "$DRY" -eq 1 ]; then echo "  [dry-run] writer_model: $WM"; else
          yaml_replace_writer "$WM"
          echo "  profile-writer = $WM"
        fi
      fi
    fi

    echo "  decision gate provider:" >&2
    echo "    1) rules — deterministic, no model (default)" >&2
    echo "    2) openjev — model-backed (local or endpoint)" >&2
    D="$(ask 'Choose' 1)"
    if [ "$D" = 2 ]; then
      BE="$(ask 'Backend (llamacpp|openai|ollama|deepseek)' llamacpp)"
      BU="$(ask 'Base URL' 'http://127.0.0.1:8090')"
      BM="$(ask 'Model name')"
      BK="$(ask 'API key file (blank for local)' '')"
      if [ "$DRY" -eq 1 ]; then
        echo "  [dry-run] decisions: openjev backend=$BE model=$BM"
      else
        apply_decisions_openjev "$BE" "$BU" "$BM" "$BK"
        echo "  decisions = openjev ($BE, $BM)"
      fi
    fi
  else
    echo "== disabling LLM-dependent features =="
    if [ "$DRY" -eq 1 ]; then
      echo "  [dry-run] set profile.decide, knowledge/decisions/retrieval .enabled = false"
    else
      set_block_key "$CONFIG" profile decide false
      set_block_key "$CONFIG" knowledge enabled false
      set_block_key "$CONFIG" decisions enabled false
      set_block_key "$CONFIG" retrieval enabled false
      echo "  profile.decide / knowledge / decisions / retrieval → off"
    fi
    DISABLED=1
  fi
else
  echo "  config already exists — skipping model questions (edit it manually or remove it to re-run)"
fi

# ---------------------------------------------------------------- 5. profiles
echo "== profiles =="
mkdir -p Brain
is_stub() {
  [ ! -e "$1" ] && return 0
  grep -qE 'stub — describe your agent|stub — fill in your own context' "$1" && return 0
  return 1
}
write_agent_stub() {
  cat > Brain/Agent.md <<EOF
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

<!-- setup stub — describe your agent's personality, voice, and operating
     rules here. Your profile notes live at the vault root as reference/config
     for the agent (rag-brain) — keep them current. -->
EOF
  mark "Brain/Agent.md" created
}
write_user_stub() {
  cat > Brain/User.md <<EOF
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

<!-- setup stub — fill in your own context; pairs with Agent.md as the
     user-side profile note at the vault root. -->
EOF
  mark "Brain/User.md" created
}
write_agent_profile() { # name tone lang rules never
  local f="Brain/Agent.md" created="$TODAY"
  if [ -e "$f" ]; then created="$(grep -m1 '^created:' "$f" | sed 's/^created:[[:space:]]*//' || true)"; fi
  cat > "$f" <<EOF
---
title: Agent
tags:
  - ai/opencode
  - agent/personality
  - agent/system-prompt
type: note
created: ${created:-$TODAY}
updated: $TODAY
status: draft
---

# Agent — Operating Instructions

Prompt-style persona directive injected into the agent's first turn. Read as
instructions, not description.

- **Name:** $1
- **Voice:** $2
- **Language:** $3
- **Operating rules:** ${4:-—}
- **Never:** ${5:-—}
EOF
}
write_user_profile() { # name role lang stack prefs notes
  local f="Brain/User.md" created="$TODAY"
  if [ -e "$f" ]; then created="$(grep -m1 '^created:' "$f" | sed 's/^created:[[:space:]]*//' || true)"; fi
  cat > "$f" <<EOF
---
title: User
tags:
  - personal
  - profile
  - agent/user-context
type: note
created: ${created:-$TODAY}
updated: $TODAY
status: draft
---

# User — Context

Working context about the user: identity, preferences, stack, projects,
hardware — whatever you want the agent to know about you.

- **Name / handle:** ${1:-—}
- **Role:** ${2:-—}
- **Language:** ${3:-—}
- **Stack & interests:** ${4:-—}
- **Preferences:** ${5:-—}
- **Notes:** ${6:-—}
EOF
}

[ -e Brain/Agent.md ] || write_agent_stub
[ -e Brain/User.md ] || write_user_stub

if is_stub Brain/Agent.md || is_stub Brain/User.md; then
  if confirm "Configure the Agent and User profile notes now?" y; then
    if is_stub Brain/Agent.md; then
      echo "  — agent profile —" >&2
      AN="$(ask 'Agent name' Nibble)"
      AT="$(ask 'Voice / tone' 'concise and direct')"
      AL="$(ask 'Language' English)"
      AR="$(ask 'Operating rules (optional)')"
      AX="$(ask 'Never do (optional)')"
      if [ "$DRY" -eq 1 ]; then echo "  [dry-run] write Brain/Agent.md"; else
        write_agent_profile "$AN" "$AT" "$AL" "$AR" "$AX"
        echo "  wrote Brain/Agent.md (name: $AN)"
      fi
    fi
    if is_stub Brain/User.md; then
      echo "  — user profile —" >&2
      UN="$(ask 'Your name / handle')"
      UR="$(ask 'Role / occupation (optional)')"
      UL="$(ask 'Language' English)"
      US="$(ask 'Tech stack & interests (optional)')"
      UP="$(ask 'Working preferences (optional)')"
      UO="$(ask 'Anything else the agent should know (optional)')"
      if [ "$DRY" -eq 1 ]; then echo "  [dry-run] write Brain/User.md"; else
        write_user_profile "$UN" "$UR" "$UL" "$US" "$UP" "$UO"
        echo "  wrote Brain/User.md"
      fi
    fi
  else
    echo "  profiles skipped (stubs kept)"
  fi
else
  echo "  profiles already configured (kept)"
fi

# --------------------------------------------------------------------- 6. SETUP.md
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

  SERVICE_TABLE="| Tool | Version / Path |
| ---- | --------------- |"
  if p="$(command -v systemctl 2>/dev/null)"; then
    SV="$(systemctl --version 2>/dev/null | head -n1 | awk '{print $2}')"
    SERVICE_TABLE+=$'\n'"| \`systemctl\` | \`$p\` (systemd ${SV:-unknown}) |"
  else
    SERVICE_TABLE+=$'\n'"| systemd | not found |"
  fi

  ESCALATION_TABLE="| Tool | Path | Priority |
| ---- | ---- | -------- |"
  add_esc_row() {
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

  SANDBOX_TABLE="| Tool | Path | Notes |
| ---- | ---- | ----- |"
  for t in docker podman firejail bubblewrap; do
    if p="$(command -v "$t" 2>/dev/null)"; then
      SANDBOX_TABLE+=$'\n'"| \`$t\` | \`$p\` | detected |"
    else
      SANDBOX_TABLE+=$'\n'"| \`$t\` | not found | — |"
    fi
  done

  RES_RAM="$(awk '/MemTotal/{printf "%.0f GB total", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo unknown)"
  RES_ROOT="$(df -h / 2>/dev/null | awk 'NR==2{print $2" total, "$5" used ("$1")"}' || echo unknown)"

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
| Audit + log dir | \`.opencode/logs/\` |"
  case "$DESKTOP" in
    *[Kk][Dd][Ee]*)
      CONFIG_TABLE+=$'\n'"| KDE settings | \`~/.config/kdeglobals\`, \`~/.config/plasma*.rc\` |" ;;
  esac
  if command -v Hyprland >/dev/null 2>&1; then
    CONFIG_TABLE+=$'\n'"| Hyprland config | \`~/.config/hypr/\` |"
  fi

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
echo "setup: done ($(pwd))"
for f in "${CREATED[@]+"${CREATED[@]}"}"; do echo "  created: $f"; done
for f in "${SKIPPED[@]+"${SKIPPED[@]}"}"; do echo "  exists (skipped): $f"; done

if [ "$DISABLED" -eq 1 ]; then
  cat <<'EOF'

NOTE: no LLM provider was connected, so model-backed features are OFF in
  .opencode/sysop-config.yaml   (profile.decide, knowledge.enabled,
  decisions.enabled, retrieval.enabled = false).
Connect later with `opencode providers login`, then set those keys back to
true — or delete .opencode/sysop-config.yaml and re-run ./scripts/setup.sh.
EOF
fi
