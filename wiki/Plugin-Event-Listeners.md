# Plugin event listeners

There are two event systems in this repo. They look similar and solve different
problems.

- **opencode plugin hooks** — functions a plugin returns for events such as
  `chat.message`, `tool.execute.after`, and `session.idle`.
- **chron fire listeners** — `chron.on("fire", fn)` and
  `chron.on("fire:<id>", fn)` for jobs the scheduler fires.

Use the first to react to user and tool activity. Use the second to react to a
scheduled job.

## opencode plugin hooks

A plugin is one TypeScript file in `.opencode/plugin/`. It default-exports an
async function and returns an object of hooks:

```ts
import type { Plugin } from "@opencode-ai/plugin"

export default (async ({ client, directory }) => {
  return {
    "chat.message": async (input) => {
      // input.sessionID, input.agent
    },
    "tool.execute.after": async (input, output) => {
      // input.tool, input.args, input.sessionID, output.metadata
    },
    event: async ({ event }) => {
      // event.type, event.properties
    },
  }
}) satisfies Plugin
```

Plugins are auto-discovered from `.opencode/plugin/*.ts` and loaded once when
opencode starts. Editing a plugin does not hot-reload it; restart opencode. A
hook that reads a config file on every event sees config edits immediately.

### Common hooks

| Hook | Payload | Use it for |
| --- | --- | --- |
| `chat.message` | `input.sessionID`, `input.agent`, the message parts | Per-turn capture. |
| `tool.execute.after` | `input.tool`, `input.args`, `input.sessionID`, `output.metadata` | Audit and telemetry. |
| `event` | `event.type`, `event.properties` | Session lifecycle. `session.idle` carries `properties.sessionID`. |
| `experimental.chat.system.transform` | `(input, output)`; push text to `output.system` | Per-turn prompt injection. |

The repo already uses all four. `mood-hook.ts` is a short example of
`chat.message`, `event`, and the system transform. `audit-hook.ts` shows
`tool.execute.after` with a bash-only filter.

### A guarded example

This example skips automation child sessions and keeps each hook small:

```ts
import type { Plugin } from "@opencode-ai/plugin"
import { automationChildSessions } from "./lib/automation.ts"
import { createSessionTools } from "./lib/sessions.ts"

export default (async ({ client, directory }) => {
  const dir = directory ?? process.cwd()
  const sessions = createSessionTools(client, dir)

  const isChild = async (sid: string): Promise<boolean> =>
    automationChildSessions.has(sid) || (await sessions.isChild(sid))

  return {
    "chat.message": async (input) => {
      if (!input.sessionID || (await isChild(input.sessionID))) return
      // record the top-level turn
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "bash") return
      if (!input.sessionID || (await isChild(input.sessionID))) return
      const metadata = (output?.metadata ?? {}) as Record<string, unknown>
      // inspect input.args?.command and metadata.exit
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sid = event.properties.sessionID
      if (!sid || (await isChild(sid))) return
      // turn-complete work
    },
  }
}) satisfies Plugin
```

### Rules that keep hooks safe

- **Never throw out of a hook.** Wrap the body in `try/catch` and log the
  failure. Hooks fail open; they should not break the user's turn.
- **Skip child sessions.** A subagent turn can otherwise re-trigger automation.
  Check both `automationChildSessions` and `sessions.isChild(sid)`.
- **Register child sessions before prompting.** If your hook creates a child
  session, add its id to `automationChildSessions` before sending the prompt so
  the other plugins skip it.
- **Do not use `console.*`.** Output can leak into the TUI input box. Write
  structured diagnostics through `getLogger` or `createDiagnostics` from
  `lib/logging.ts`.
- **Keep hooks deterministic.** No model calls inside a hook. If work needs a
  model, enqueue a task and let the consumer run it.
- **Do not spawn work you cannot stop.** A hook runs inside the request path;
  long work delays the turn.

## chron fire listeners

Chron owns the scheduler singleton. The owner plugin is `chron-hook.ts`; it
creates the instance, registers the prompt bridge, starts the timer, and returns.
A listener is a function on that instance.

The recommended pattern is a small module called from `chron-hook.ts`:

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

`chron.on` returns an unsubscribe function. Listeners can be added after
`start()` too; they attach to the in-memory set.

### What a listener receives

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

- `occurrence_ms` is the scheduled instant.
- `fired_at_ms` is when the tick actually ran.
- `late` is true when a missed occurrence was coalesced.
- `payload` is present only for `chron.emit(id, payload)`.

Order for one job: its own code handler, then every `fire` listener, then every
`fire:<id>` listener. Listeners run sequentially and a thrown listener is
logged without stopping the rest.

### Deferring

Return `{ defer: true }` to retry the same occurrence on the next wake:

```ts
chron.on("fire:nightly-report", async (event) => {
  const result = await deliver(event)
  return result.full ? { defer: true } : undefined
})
```

Any listener can defer, and the occurrence stays due until it succeeds or
`chron.defer_ttl_hours` expires. After the TTL, the occurrence is dropped and
`chron.log` records `defer-dropped`. The prompt bridge uses this when the task
store is full.

### Manual jobs and `emit`

A file job with `schedule: manual` never fires on its own. Push it from code:

```ts
await chron.emit("nightly-report", { reason: "manual" })
```

`emit` sets `occurrence_ms` and `fired_at_ms` to now, does not change schedule
state, and runs the job handler and listeners immediately. It warns once for an
unknown or disabled id. For a file job, `source` stays `"file"`, so the prompt
bridge still turns it into a user task.

### Code jobs

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
the file job is ignored and chron warns. Code job changes need a restart.

`chron.list()` returns the merged job view with `next_due_ms`, `last_fired_ms`,
and a `deferred` flag. There is no CLI for it; call it from a plugin or a test.

### Separate plugin caveat

If you keep listeners in their own plugin instead of `chron-hook.ts`, they must
use the same singleton:

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
process starts, `chron-hook.ts` disables chron and asks for a restart. Do not
expect plugin edits to take effect live.

## Which one do I use?

| You want to react to | Use |
| --- | --- |
| A user message | `chat.message` |
| A tool call and its result | `tool.execute.after` |
| A finished turn | `event` with `session.idle` |
| A scheduled markdown job or code job | `chron.on("fire:<id>", ...)` |
| A one-off push with no schedule | `manual` job + `chron.emit` |

## Tests

The chron core and bridge have direct tests:

```bash
node --test .opencode/plugin/lib/chron/chron.test.ts \
  .opencode/plugin/lib/chron-bridge.test.ts
```

Plugin hooks are tested the same way as `lib/mood-hook.test.ts`: build the hook
object, then call the named hook or `hooks.event({ event: { type: "session.idle",
properties: { sessionID } } })`. Restart opencode after editing a plugin and
check `.opencode/logs/chron.log` for scheduler events.

## Source

- [`chron-hook.ts`](../.opencode/plugin/chron-hook.ts) — owner plugin.
- [`chron/chron.ts`](../.opencode/plugin/lib/chron/chron.ts) — `on`, `emit`,
  `register`, `list`.
- [`chron/types.ts`](../.opencode/plugin/lib/chron/types.ts) — `FireEvent`.
- [`chron-bridge.ts`](../.opencode/plugin/lib/chron-bridge.ts) — the built-in
  `fire` listener.
- [`mood-hook.ts`](../.opencode/plugin/mood-hook.ts) and
  [`audit-hook.ts`](../.opencode/plugin/audit-hook.ts) — opencode hook examples.
- [`AGENTS.md`](../AGENTS.md) — hook safety rules.
