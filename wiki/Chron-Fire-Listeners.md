# Chron fire listeners

Chron's event listeners are the hook point for scheduled work. A listener runs
when chron fires a job. This page is only about those listeners; it does not
cover opencode's own plugin hooks (`chat.message`, `tool.execute.after`,
`session.idle`).

The chron singleton is owned by `.opencode/plugin/chron-hook.ts`. That plugin
creates the instance, registers the prompt bridge, starts the timer, and
returns. A listener attaches to that instance.

## Recommended pattern

Put the listener in a module and call it from `chron-hook.ts`:

```ts
// .opencode/plugin/lib/my-chron-listeners.ts
import type { Chron } from "./chron/chron.ts"

export function registerMyChronListeners(chron: Chron): void {
  chron.on("fire", async (event) => {
    // every file and code job
  })

  chron.on("fire:nightly-report", async (event) => {
    // only this job id
  })
}
```

Wire it in after the bridge and before the timer starts:

```ts
registerChronBridge(chron, { directory: dir, stateDir, log })
registerMyChronListeners(chron)
await registerCodeJobs(chron)
chron.start()
```

`chron.on` returns an unsubscribe function. Listeners can also be added after
`start()`.

## What a listener receives

```ts
type FireEvent = {
  id: string
  source: "file" | "code"
  occurrence_ms: number
  fired_at_ms: number
  late: boolean
  payload?: unknown
}
```

- `occurrence_ms` — scheduled instant.
- `fired_at_ms` — when the tick ran.
- `late` — true when missed occurrences were coalesced.
- `payload` — only for `chron.emit(id, payload)`.

Order for one job: its code handler (if it has one), then every `fire`
listener, then every `fire:<id>` listener. Listeners run sequentially. A thrown
listener is logged and the remaining listeners still run.

## Deferring

Return `{ defer: true }` to retry the same occurrence on the next wake:

```ts
chron.on("fire:nightly-report", async (event) => {
  const result = await deliver(event)
  return result.full ? { defer: true } : undefined
})
```

Any listener can defer. The occurrence stays due until it succeeds or
`chron.defer_ttl_hours` expires (default 24 hours). After the TTL, chron logs
`defer-dropped` and advances. The prompt bridge uses this when the task store is
full.

## Manual jobs and `emit`

A file job with `schedule: manual` never fires on its own. Push it:

```ts
await chron.emit("nightly-report", { reason: "manual" })
```

`emit` sets `occurrence_ms` and `fired_at_ms` to now, does not change the
schedule state, and runs the handler and listeners immediately. It warns once
for an unknown or disabled id. For a file job, `source` stays `"file"`, so the
prompt bridge still turns it into a user task.

## Code jobs

A code job is deterministic work on a schedule, registered at plugin load:

```ts
chron.register({
  id: "nightly-report",
  schedule: "daily 23:00",
  handler: async (event) => {
    // deterministic work
  },
})
```

The first registration for an id wins. An invalid schedule is rejected at
registration and never fires. A code job shadows a file job with the same id;
the file job is ignored and chron warns. Code changes need a restart.

`chron.list()` returns the merged job view with `next_due_ms`,
`last_fired_ms`, and `deferred`. There is no CLI; call it from a plugin or test.

## Separate plugin caveat

If the listener lives in its own plugin instead of `chron-hook.ts`, it must use
the same singleton:

```ts
const cfg = await readChronConfig(dir)
if (!cfg.enabled) return {}
const { stateDir, logDir } = await readResolvedPaths(dir, homedir())
const chron = getChron({ directory: dir, stateDir, logDir })
chron.on("fire", listener)
return {}
```

`getChron` creates the singleton if `chron-hook.ts` has not loaded yet. The
first caller's deps win, so a separate plugin can lose the owner's logger
configuration. Prefer the owner pattern.

Chron also has a stale-code guard: if a chron code file changes after the
process starts, `chron-hook.ts` disables chron and asks for a restart. Plugin
edits do not take effect live.

## Which job type?

| Need | Use |
| --- | --- |
| A plain prompt on a clock | A scheduled markdown job in `.opencode/schedule/`. |
| Deterministic code on a clock | A chron code job. |
| A reaction to a fired job | A `chron.on("fire")` or `fire:<id>` listener. |

## Tests

```bash
node --test .opencode/plugin/lib/chron/chron.test.ts \
  .opencode/plugin/lib/chron-bridge.test.ts
```

Restart opencode after editing a plugin and check `.opencode/logs/chron.log` for
fire, defer, and warning events.

## Source

- [`chron-hook.ts`](../.opencode/plugin/chron-hook.ts) — owner plugin.
- [`chron/chron.ts`](../.opencode/plugin/lib/chron/chron.ts) — `on`, `emit`,
  `register`, `list`.
- [`chron/types.ts`](../.opencode/plugin/lib/chron/types.ts) — `FireEvent`.
- [`chron-bridge.ts`](../.opencode/plugin/lib/chron-bridge.ts) — the built-in
  `fire` listener.
- [`Adding scheduled markdown jobs`](Adding-Scheduled-Markdown-Jobs.md) — the
  file-job side.
