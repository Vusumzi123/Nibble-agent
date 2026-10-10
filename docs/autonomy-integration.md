# Autonomy Integration — Hooking External Modules Into the Security Grid

The autonomy gate (`plugin/autonomy-gate.ts` + `plugin/lib/autonomy-gate.ts`)
classifies every tool call in `tool.execute.before` into a **class**, then
applies a level matrix (L0 Plan … L4 Autonomous). Anything it does not
recognize is `external` and runs **outside the schema** (passes, logged).
This file is the contract for a new tool, MCP server, sub-agent, or plugin to
declare where it belongs.

## The model in one paragraph

- **The dial is hot-read** from `.opencode/sysop-config.yaml` (`autonomy:`)
  every call — no restart to change a level or class mapping.
- **The spawn is the permission event** for sub-agents: a child session is
  autonomy-unaware and faces only the irreversibility floor under
  `gate_scope: main`. Classifying the `task` spawn is how you gate what a
  child can do.
- **Unknown = out of schema.** Security of an unclassified tool is the
  responsibility of whoever programs it (settled decision D21).

## The class vocabulary

| Class | Meaning |
| --- | --- |
| `pure-read` | Read-only tools (`read`, `glob`, `grep`, `list`, `todowrite`, `skill`, `question`) and vault reads. |
| `readonly-bash` | Bash commands with no side effects (`ls`, `git status`, `pacman -Q`, …). |
| `vault-write` | Writes to the Brain vault via the `markdown-vault_*` MCP tools. |
| `project-write` | `edit` / `write` / `patch` on project files. |
| `subagent-read` | Spawn of a read-only child (`rag-search`, `explore`). |
| `subagent-web` | Spawn of a one-shot web child (`safe-browser`). |
| `subagent-web-deep` | Spawn of a deep-research child (`deep-browser`). |
| `subagent-write` | Spawn of a mutating child (`rag-brain`, `package-manager`, `os-configurator`, `sandbox-runner`, `web-developer`, …). |
| `destructive` | Non-floor destructive commands (`rm` on user paths, `pacman -R`, `systemctl stop`, `kill`, …). |
| `root` | Escalated commands (`sudo`/`pkexec`/`doas`/`su`). |
| `self-improve` | Writes to `.opencode/plugin/**`, `opencode.json`, or `sysop-config.yaml`. |
| `borderline` | Bash that fits no other class. |
| `external` | Anything not in the registry and not overridden — **out of schema** (allow + logged). |
| `floor` | Irreversibility: `mkfs`/`dd` on block devices, `rm -rf` on system roots, tampering with the security hooks or config files. Denied at every level, never approvable. |

## The level matrix

| Class | L0 Plan | L1 Build | L2 Knowledge | L3 Working | L4 Autonomous |
| --- | --- | --- | --- | --- | --- |
| `pure-read` / `readonly-bash` | allow | allow | allow | allow | allow |
| `project-write` / `vault-write` | **deny** | allow | allow | allow | allow |
| `subagent-read` | allow | allow | allow | allow | allow |
| `subagent-web` | ask | ask | allow | allow | allow |
| `subagent-web-deep` | ask | ask | ask+JEV | allow | allow |
| `subagent-write` | ask | ask | allow | allow | allow |
| `destructive` | **deny** | ask | ask | ask+JEV | allow |
| `root` | **deny** | ask | ask | ask+JEV | `root_classes` |
| `self-improve` | **deny** | ask | ask | ask | ask+JEV |
| `borderline` | **deny** | ask+JEV | ask+JEV | ask+JEV | ask+JEV |
| `external` | allow | allow | allow | allow | allow |
| `floor` | deny | deny | deny | deny | deny |

`ask` blocks and waits for the user's confirm; `ask+JEV` additionally consults
the typed-decision provider first (fail-closed to `ask`). `deny` never runs.

## The three ways a module gets classified

### 1. Built-in registry (first-party, ship with Nibble)

Edit `plugin/lib/autonomy-gate.ts`:

- `PURE_READ_TOOLS` / `PROJECT_WRITE_TOOLS` — tool-name sets.
- `VAULT_PREFIX` — a namespace prefix (e.g. `markdown-vault_`) grouped under
  one class.
- `SUBAGENT_TIERS` — `subagent_type` → tier for `task` spawns.

### 2. Config override (third-party, per-project, no code change)

`autonomy.class_overrides` in `.opencode/sysop-config.yaml`, hot-read:

```yaml
autonomy:
  class_overrides:
    - tool:my-mcp_*:vault-write          # every my-mcp_* tool is a vault write
    - tool:frobnicate:project-write      # exact tool name
    - subagent:my-agent:subagent-write   # a Task child type
```

Syntax is `kind:name:class` where `kind` is `tool` or `subagent`. A `tool:`
name ending in `*` is a prefix glob. Config override wins over the built-in
registry. Invalid class names never match (fail-closed to the default
behavior). No restart required.

### 3. Naming convention

Follow a namespace prefix so a whole family is classified together via
`class_overrides` or the registry (the `markdown-vault_*` pattern).

## Rules for tool / plugin authors

1. **Declare, or be external.** A mutating tool that is not declared runs
   un-gated (`external`). If your tool writes files, removes packages, or runs
   shell, declare a class — otherwise *you* own the safety story.
2. **A sub-agent's spawn is the permission event.** The child never sees the
   dial; make sure its `subagent_type` maps to the right tier. Unknown
   `subagent_type` fails closed to `subagent-write`.
3. **Gate plugins are orthogonal.** `vault-readonly-guard`, `write-guard`,
   `audit-hook`, and the floor compose at the tool boundary and are **never**
   bypassed by raising the level. Do not expect a high dial to disable them.
4. **Web access is denied for the main agent.** `webfetch`/`websearch` are
   natively denied; browsing goes through `safe-browser`/`deep-browser`. A new
   web-touching child needs its own `webfetch`/`websearch: allow` permission
   block (see `opencode.json`) and should be added to
   `telemetry.watch_agents`.
5. **You cannot self-elevate.** Editing `sysop-config.yaml` (which holds the
   dial) is `self-improve` via the edit tool and **floor** via shell mutation.

## Batch approval (`autonomy-batch`)

Any `ask`-class call (including a class you mapped via `class_overrides`) can
be pre-approved as a batch: the model proposes a fenced block, the user
confirms once, and matching declared calls run without further prompts until
the next user message.

````text
```autonomy-batch
project-write src/a.ts
destructive rm -rf /tmp/scratch
```
````

Budget per turn is `autonomy.batch.max_actions` (default 8; `0` disables).

## Future: self-declaration via tool metadata

opencode does not currently expose a runtime tool-metadata channel the gate can
read, so classification is registry + `class_overrides`. When a
`tool.definition`-style annotation is available, a plugin could ship its own
default class and skip the config step. Until then, use `class_overrides`.

## Checklist for adding a module

1. Pick a class from the vocabulary above (what is the worst this tool can do?).
2. Map it: registry (first-party) or `class_overrides` (third-party).
3. If it is a `task` child, set the `subagent_type` tier and give it the
   permissions its own isolation needs.
4. If it touches the web, deny main-agent `webfetch`/`websearch` and route
   through a browser child instead.
5. Run `node --test .opencode/plugin/lib/*.test.ts` and add a matrix test for
   the new mapping.
