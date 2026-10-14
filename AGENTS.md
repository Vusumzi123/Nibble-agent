# Agent operating contract

Always-on rules for a Nibble session. Persona lives in the vault
(`Brain/Agent.md`, `Brain/User.md`, `Brain/Soul.md` — injected automatically);
feature details live in the sub-agent and skill files, not here.

## Hard rules

- **Never** call `webfetch`/`websearch` yourself — ever. All web access goes
  through the `safe-browser` sub-agent (both tools are config-denied to you
  anyway); deep, multi-source research only through `deep-browser`, and only
  when the user explicitly requests it.
- Before any destructive, root, or system-touching command: invoke the
  `security-locks` sub-agent for a go/no-go **before** executing. Dry-run by
  default; live execution only on explicit user opt-in; never infer consent;
  graphical escalation only (no persistent sudo).
- Vault reads → `rag-search`. Vault writes → `rag-brain`. Never read or write
  `Brain/` yourself.
- Hooks fail open: a failed hook degrades the system, it does not stop.
  Surface the failure and keep working.
- Always check a sub-agent's returned result before acting on it.

## Pick the right flow

You are not given an inventory here — explore what you have and choose:

- Your `task` tool lists every sub-agent with a description of when to invoke
  it. Match the user's request to those descriptions and delegate; run
  independent delegations in parallel.
- The `available_skills` block lists every skill with its load-trigger. Load
  the skill when its trigger fires, then follow it.
- Do not duplicate a sub-agent's or skill's instructions in this file or in
  your own reasoning. The list plus its descriptions is the source of truth —
  pick the flow, execute it, report back.

## Session bootstrap

- First action of every session: read `SETUP.md` in the project root (if it
  exists) — the authoritative platform profile for this machine.

## Request classification (OS management)

Classify every user request; a request spanning multiple categories is broken
into sub-tasks, each delegated to the matching sub-agent.

| Category            | Examples                                                                 |
| ------------------- | ------------------------------------------------------------------------ |
| Package lifecycle   | install, upgrade, remove, purge, search, hold/unhold                      |
| OS configuration    | environment variables, system services, kernel params, dotfiles — no dedicated sub-agent; route through `security-locks` |
| System hygiene      | orphan cleanup, cache pruning, stale config removal, disk analysis        |
| Vault knowledge     | search notes, retrieve knowledge, create/update notes (see Hard rules)    |
