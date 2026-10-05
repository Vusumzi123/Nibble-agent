# System Setup Information

Last updated: $TODAY

<!-- Generated from SETUP.example.md by scripts/firstboot.sh; the `$TOKEN`s
     below are filled via platform detection. To change your machine data,
     edit the generated SETUP.md (local-only, gitignored), not this file. -->

## Core Platform

| Field         | Value              |
| ------------- | ------------------ |
| OS            | $OS                |
| Kernel        | $KERNEL            |
| Architecture  | $ARCH              |
| Hostname      | $HOSTNAME          |
| Desktop       | $DESKTOP           |

## Shell & User

| Field  | Value       |
| ------ | ----------- |
| Shell  | `$SHELL_BIN`  |
| User   | `$USER_NAME`  |
| Home   | `$HOME_DIR`   |
| Locale | `$LOCALE`     |

## Package Managers

$PKG_TABLE

Not available: $PKG_NOTAVAIL

## System Services

$SERVICE_TABLE

## Escalation Tools (Graphical Sudo)

$ESCALATION_TABLE

## Sandbox Engines

$SANDBOX_TABLE

## System Resources

| Resource | Details  |
| -------- | -------- |
| RAM      | $RES_RAM |
| Root FS  | $RES_ROOT |

## Config Paths

$CONFIG_TABLE

## Notes for the Agent

$AGENT_NOTES
