---
name: mission-authoring
description: Use when creating, changing, or reviewing a Nibble heartbeat mission (.opencode/missions/*.md) — frontmatter contract, candidacy gates, prompt/result contract, restrict-only config overlay, custom mission agents, and adding a new mission tool. Also use when a mission never fires, fires when it should not, or a child ignores its result contract.
---

# Authoring a Nibble Mission

A mission is one Markdown file in `.opencode/missions/`. The frontmatter is
configuration read by the deterministic orchestrator; the body is the prompt
sent to one child agent. There are no hardcoded missions — built-ins are just
files beside user missions.

Mission files are trusted local config and hot-read every tick: editing one
takes effect on the next tick, no restart. Editing the harness that parses
them (`lib/missions.ts`, `lib/heartbeat.ts`, `heartbeat-hook.ts`) **does**
require an opencode restart, and is self-improve (approval-gated).

## File contract

```markdown
---
id: my-mission
title: Short human title
frequency: mid
menus: [day]
min_level: 2
approval: writes-follow-dial
candidacy: always
agent: ""
enabled: true
---

Instructions for the child agent. This is the whole task prompt.
```

Defaults when a key is missing or invalid (`lib/missions.ts`
`DEFAULT_MISSION`):

| Key | Values | Default | Notes |
| --- | --- | --- | --- |
| `id` | `[A-Za-z_][A-Za-z0-9_-]*` | filename stem | Lowercase by convention. A duplicate id makes the later file (sorted by filename) be skipped. |
| `title` | string | `id` | Shown in the UI and the ledger. |
| `frequency` | `high` / `mid` / `low` | `mid` | A dispatch **weight**, never a gate: 1.0 / 0.5 / 0.2, multiplied by mood bias. |
| `menus` | inline list of `day` / `night` / `both` | `[day]` | `both` expands to `[day, night]`. The live window is chosen from the quiet flag. |
| `min_level` | integer 0–4 | `2` | Lowest `autonomy.level` that may run it. |
| `approval` | `n/a` / `per-item` / `writes-follow-dial` / `always` | `writes-follow-dial` | Label only — surfaced in the UI. It does **not** enforce anything; the autonomy matrix gates execution. |
| `candidacy` | see below | `always` | Producer-side eligibility gate, evaluated when the item is enqueued. |
| `enqueue` | `producer` / `item` | `producer` | `item` keeps the mission out of the digest roll: a dedicated producer enqueues its items (the `user-task` consumer is the one in-tree example). |
| `agent` | opencode agent name | `""` | `""` = the default heartbeat agent. A name pins the child session to that agent (and its permissions). |
| `enabled` | `true` / `false` | `true` | A config overlay may only turn this off. |

Unknown frontmatter keys are ignored with a warn-once. Invalid values fall
back to the default above and warn once per process to
`.opencode/logs/autonomy-config.log` (section `missions`). A mixed-valid
`menus` list is a typo and is rejected whole.

## Candidacy predicates

`lib/heartbeat.ts` `candidacyPasses` is authoritative. The **producer** runs it
when deciding what to enqueue; there is no model gate. All predicates are
deterministic and fail closed.

| Value | Passes when |
| --- | --- |
| `always` | Always (subject to `enabled`, `menus`, `min_level`). |
| `backlog-pending` | Open backlog entries at the current level > 0. |
| `brain-stale` | The oldest `type: reference` vault note is ≥ 720h old by its `updated:` frontmatter. `brain-stale:<hours>` overrides the threshold; absent signal fails closed. Status-fed missions are emitted as the `staleness` work kind. |
| `dream-gate` | Sleep status is `dreaming`, under the nightly cap, and the `quiet.dream_chance` roll passes. Feature-specific (dream hook). |
| `idea-roll` | Today's idea draw has quota left. Feature-specific (idea pipeline); absent state = fail closed. |
| `min-gap:<key>` | Never ran, or `now - lastRun >= minGapMs[key]`. The heartbeat keeps per-mission last-run stamps in `heartbeat.json`; a key with no wired gap reads as 0 → always eligible. |
| `roll:<p>` | `Math.random() < p` per tick. `<p>` must be numeric; it is not clamped. |

A mission enqueued on a lucky `roll:`/`min-gap:` tick is a **reservation**: once
it is in the pool it runs even if the gate would not pass again. The producer
enqueues at most one mission and one staleness item per tick; the consumer runs
exactly one pool item, or skips the tick when the pool is empty.

Before candidacy, the loader filters on `enabled`, effective `menus` containing
the current window, and `level >= min_level`.

New predicate names require code changes in `lib/missions.ts` (parser) and
`lib/heartbeat.ts` (evaluation plus context wiring), with tests — a file
change alone cannot add one.

## Writing the body

The final prompt is assembled as: context header → fixed heartbeat prompt →
`Mission: <id> — <title>` → the body (trimmed). The body is
authoritative and is not validated, so it must be a complete, self-contained
task brief.

- State the objective, the stopping condition, and the exact tool calls.
- Name what each tool result means (`skipped` vs `completed` vs error).
- Say when to decline and how (normally: load `roll-mission` and follow it).
- Never ask the user questions; no interactive approvals. If the work would
  need one, pick smaller work or decline.
- Respect the stated soft token budget. It is measured after the turn;
  there is no mid-turn stop, so scope accordingly.
- Security rules are unchanged: `security-locks` before root/destructive
  work, web only through `safe-browser`, vault reads through `rag-search`,
  vault writes through `rag-brain`, and no self-modification of `.opencode/`.

## Result contract

Every tool-capable mission ends by calling the `mission_result` tool exactly
once:

```json
{ "status": "completed", "summary": "one line" }
{ "status": "declined", "summary": "why", "reason": "in-sync" }
{ "status": "error", "summary": "what failed" }
```

- The orchestrator reads the **last** call from the child transcript; multiple
  calls log a warning and last wins.
- Missing call: falls back to the final assistant text and the child outcome,
  records `result_missing: true`, and **never** infers a decline.
- A tool returning `status: "skipped"` is telemetry, not a decline. The child
  must still call `mission_result` with `declined`.
- `declined`: the item is dropped (the producer re-proposes it next tick if its
  gate still passes). There is no same-tick reroll.

- A decline must leave no side effects.
- Tool-free missions (`agent: dreamer`, `agent: idea-generator`) cannot call
  `mission_result`; they end with their typed object/markers and the hook
  parses it. Do not mix the two contracts.

## Worked example — tool-backed

```markdown
---
id: audit-refresh
title: Verify audit log health
frequency: low
menus: [day]
min_level: 2
approval: n/a
candidacy: min-gap:audit-refresh
enabled: true
---

Inspect the active audit log read-only.

1. Read `.opencode/logs/audit.log`; count non-zero `exit` entries.
2. If there are none, load `roll-mission` and follow it with reason
   `clean` — do not write anything.
3. If there are failures, group them by command and report the top three.
4. Call `mission_result` once: `completed` with a one-line summary.
```

Note `min-gap:audit-refresh` is only meaningful once that key is wired into
the candidacy context (`gaps` + `minGapMs`); otherwise it behaves as always
eligible.

## Custom mission agent

1. Add `.opencode/agents/<name>.md` with `mode: subagent` and explicit
   permissions. Deny everything the mission must not touch; grant only the
   tools it needs.
2. Tool-free agents: deny `read`, `write`, `edit`, `bash`, `task`, `glob`,
   `grep`, `webfetch`, `websearch` and return a typed final message.
3. Set `agent: <name>` in the mission. If the agent does not exist, dispatch
   errors (`promptAsync` failure); the tick records an error.
4. Agent config changes need an opencode restart (no hot reload).

## Adding a new mission tool

`mission_result` is registered on the plugin tool surface in
`.opencode/plugin/heartbeat-hook.ts`. To add a new deterministic capability:

1. Implement it under `.opencode/plugin/lib/` (pure, never throws) and test it.
2. Register it in the hook's `tool:` object with a schema; the tool is then
   callable from mission child sessions and passes through the normal
   autonomy/permission layer.
3. Make the mission body the source of truth for usage.
4. If the tool changes dispatch or result behavior, add its file to
   `HEARTBEAT_CODE_FILES` in `lib/heartbeat.ts` so the stale-code guard blocks
   an old process.
5. Restart opencode after plugin changes. Mission files stay hot-read.

## Config overlay (restrict-only)

Under `autonomy.missions.<id>.*` in `sysop-config.yaml`:

```yaml
autonomy:
  missions:
    my-mission:
      enabled: false      # always honoured
      min_level: 3        # may only be raised
      frequency: low      # may only move toward low
      menus: [day]        # may only be narrowed
```

Widening attempts are rejected, logged once, and the file value stands. The
overlay may write `enabled: false`; it cannot re-enable a file-disabled mission.

## Verify

1. `node --test .opencode/plugin/lib/*.test.ts .opencode/plugin/lib/drain/*.test.ts`
   — add a `parseMissionFile` fixture and, if shipped, a loader assertion in
   `lib/missions.test.ts`.
2. Next tick, read `.opencode/logs/heartbeat.log`: one NDJSON line with
   `verdict`, `mission`, `outcome`, `token_cost`, `result_status`,
   `result_missing`, `over_budget`, and `reason`.
3. Check `.opencode/state/heartbeat.json` for the no-op streak and
   `.opencode/state/work-queue.json` for the pool. A mission that never appears
   in `candidates:` is failing `enabled`, `menus`, `min_level`, or `candidacy`.

## Pitfalls

- `menus` defaults to `[day]`; an unset night mission silently never runs at
  night.
- `frequency` does not force cadence — it only weights the producer's draw.
- Do not treat `skipped` as a result. Decline explicitly.
- Do not reuse `dream-gate`, `idea-roll`, or `min-gap:` keys unless the
  matching feature/store is actually wired.
- Mission files live under `.opencode/`; writing them is self-improve and
  needs explicit approval. Never enable a new autonomous mission as a
  side effect of another task.
