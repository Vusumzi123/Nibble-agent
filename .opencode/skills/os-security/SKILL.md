---
name: os-security
description: Load before any OS-changing or root operation - package install/upgrade/remove/purge/search, systemd services, kernel params, dotfiles, or any potentially destructive command. Provides the root-need checklist, the graphical escalation ladder (pkexec/kdialog/zenity/askpass), the mandatory security-locks dry-run workflow, and a worked example.
---

# OS Security — Escalation & Dry-Run Procedures

The inline `AGENTS.md` keeps the invariant one-liners (never plaintext
passwords, no persistent sudo, always invoke `security-locks` first). This
skill holds the full procedures.

## Root Detection Checklist

A command NEEDS root when:

- It modifies files/directories the current user cannot write to
- It calls a package manager (`apt`, `dnf`, `pacman`, `brew`, `winget`, …)
- It starts/stops/enables/disables/masks a systemd unit (or equivalent)
- It writes to `/etc`, `/usr`, `/opt`, `/boot`, `/sys`, `/proc/sys`
- It modifies kernel parameters (`sysctl`, `modprobe`)
- It changes file ownership/permissions on system files
- It binds to a privileged port (<1024)
- It manipulates user accounts (`useradd`, `passwd`, `usermod`)

## Escalation Protocol (Graphical Prompt — Never Plaintext)

When root is needed, you MUST use a desktop-compatible graphical password
dialog. Try these in order until one succeeds:

1. **`pkexec <command>`** — PolicyKit graphical prompt (preferred; works on
   KDE, Gnome, Xfce, and most modern desktops). Pass the command as a single
   quoted string.
2. **`kdialog --password --title="opencode sudo" | sudo -S <command>`** —
   KDE-native password dialog. Pipe into `sudo -S`. Use when `pkexec` is
   unavailable (KDE/Plasma environments).
3. **`zenity --password --title="opencode sudo" | sudo -S <command>`** —
   Pipe the password from a Zenity dialog into `sudo -S`. Use as a secondary
   fallback.
4. **`SUDO_ASKPASS=/path/to/askpass sudo -A <command>`** — Fallback for
   headless or non-graphical environments. The askpass program must open a
   graphical password prompt (e.g. `ksshaskpass`, `ssh-askpass`,
   `lxqt-openssh-askpass`).

**Rules:**

- NEVER use `sudo` without a graphical prompt wrapper.
- NEVER hardcode or echo a password.
- NEVER use `echo <password> | sudo -S` (it exposes the password in
  `ps` and shell history).
- NEVER run a shell as `sudo -i` or `sudo -s` (persistent elevation).
- Every escalated command gets its own password prompt. Do not cache
  credentials across commands.

Before running an escalated command, announce it to the user:
`[ROOT REQUIRED] <command>`

## Dry-Run Workflow

1. User says "Install htop".
2. You prep the command: `sudo pacman -S htop`.
3. You invoke **`security-locks`** → checks whitelist, audit log, sandbox.
4. `security-locks` returns `APPROVED_DRY_RUN` with the dry-run command:
   `pacman -Sw --print htop`.
5. You present the dry-run output to the user.
6. User must respond with an explicit confirmation (`proceed`, `yes`, `--execute`).
7. You invoke **`security-locks`** again → `APPROVED_LIVE`.
8. You execute the live command via the graphical prompt.
   (The command is logged automatically by the audit-hook plugin — no manual step.)

## Example Session

```
User: install htop
Agent: [reading SETUP.md → platform, package manager, pkexec available]
       [classifying → package lifecycle → package-manager]
       [invoking security-locks for dry-run check]
Agent: Dry-run: pacman would install htop (1 package, 348 KiB). Proceed?
User: yes
Agent: [invoking security-locks for live approval]
       [ROOT REQUIRED] pkexec pacman -S --noconfirm htop
       htop installed successfully.
       [audit-hook] command auto-logged to .opencode/logs/audit.log.
```
