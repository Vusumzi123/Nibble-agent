import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { DEFAULT_DRAIN, type DrainConfig } from "./config.ts"
import {
  DRAIN_CURRENT_FILE,
  idleDrainCurrent,
  startDrainConsumer,
  type DrainConsumerDeps,
  type WakeStopReason,
} from "./consumer.ts"
import { createDrainLedger, DRAIN_LEDGER_FILE } from "./ledger.ts"
import { acquireDrainLock, drainLockFile } from "./lock.ts"
import { createBrainProvider } from "../memory/providers/builtin/brain.ts"
import type { MemoryProvider } from "../memory/types.ts"

const PROJECT = "/work/project-c"

const ONE_ITEM = JSON.stringify({
  items: [
    {
      title: "Wireguard Restart",
      summary: "Restart wg0.",
      tags: [],
      atoms: ["sudo systemctl restart wg0"],
    },
  ],
})

function fakeClient(): { client: any } {
  let n = 0
  return {
    client: {
      session: {
        async list() {
          return { data: [] }
        },
        async create(args: any) {
          if (args.body.title === "drain-summarize") return { data: { id: `ses_sum_${++n}` } }
          return { data: { id: "ses_writer" } }
        },
        async promptAsync() {
          return { response: { ok: true } }
        },
        async messages(args: any) {
          const id = args.path.id as string
          if (id === "ses_writer") {
            return {
              data: [
                {
                  info: { role: "assistant", tokens: { input: 5, output: 2 } },
                  parts: [{ type: "text", text: "```consolidated\n#1\n```" }],
                },
              ],
            }
          }
          return {
            data: [
              {
                info: { role: "assistant", tokens: { input: 5, output: 2 } },
                parts: [{ type: "text", text: ONE_ITEM }],
              },
            ]
          }
        },
      },
    },
  }
}

async function workspace(): Promise<{ root: string; stateDir: string; vaultDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "drain-consumer-"))
  const stateDir = join(root, "state")
  const vaultDir = join(root, "vault")
  await mkdir(stateDir, { recursive: true })
  await mkdir(vaultDir, { recursive: true })
  return { root, stateDir, vaultDir }
}

async function seedDb(opts: { turns?: number; sessionTime?: number } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "drain-consumer-db-"))
  const file = join(dir, "opencode.db")
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, time_updated INTEGER NOT NULL, time_created INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL DEFAULT '');
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, data TEXT NOT NULL);
  `)
  const sessionTime = opts.sessionTime ?? 1_000
  db.prepare("INSERT INTO session (id, parent_id, directory, time_updated) VALUES (?, ?, ?, ?)").run(
    "top-1",
    null,
    PROJECT,
    sessionTime,
  )
  const turns = opts.turns ?? 1
  for (let i = 0; i < turns; i++) {
    const t = sessionTime + i
    db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
      `m${i}`,
      "top-1",
      t,
      JSON.stringify({ role: i % 2 === 0 ? "user" : "assistant" }),
    )
    db.prepare("INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)").run(
      `m${i}-p`,
      `m${i}`,
      JSON.stringify({ type: "text", text: `run sudo systemctl restart wg0 ${i}` }),
    )
  }
  db.close()
  return file
}

function config(overrides: Partial<DrainConfig> = {}): DrainConfig {
  return {
    ...DEFAULT_DRAIN,
    writer_model: "test/writer",
    summarize_model: "test/sum",
    initial_lookback_hours: 0,
    settle_seconds: 0,
    poll_seconds: 60,
    ...overrides,
  }
}

function deps(
  base: { stateDir: string; vaultDir: string; dbFile?: string },
  cfg: DrainConfig,
  opts: { ledger?: any; provider?: MemoryProvider | null; client?: any } = {},
): DrainConsumerDeps {
  const { client } = fakeClient()
  let provider: MemoryProvider | undefined
  if (opts.provider === null) {
    provider = undefined
  } else if (opts.provider !== undefined) {
    provider = opts.provider
  } else {
    provider = createBrainProvider({
      directory: PROJECT,
      stateDir: base.stateDir,
      vaultDir: base.vaultDir,
      drain: cfg,
      summaryWords: 400,
      ...(base.dbFile === undefined ? {} : { dbFile: base.dbFile }),
    })
  }
  return {
    directory: PROJECT,
    stateDir: base.stateDir,
    vaultDir: base.vaultDir,
    client: opts.client ?? client,
    waitForIdle: async () => true,
    registerChild: () => {},
    ...(base.dbFile === undefined ? {} : { dbFile: base.dbFile }),
    ...(opts.ledger ? { ledger: opts.ledger } : {}),
    resolveProvider: async () => provider,
    readConfig: async () => cfg,
    autostart: false,
    onWarn: () => {},
  }
}

test("idle marker: state file is written when the backlog is below the trigger", async () => {
  const base = await workspace()
  const cfg = config({ trigger_pending: 12 })
  // 2 turns only — below trigger_pending=12, and no oldest-age trigger with 0 turns age.
  const dbFile = await seedDb({ turns: 2, sessionTime: Date.now() - 10_000 })
  const handle = startDrainConsumer({ ...deps({ ...base, dbFile }, cfg) })

  const summary = await handle.wake()
  assert.equal(summary, null, "below trigger: no wake work")

  const marker = JSON.parse(await readFile(join(base.stateDir, DRAIN_CURRENT_FILE), "utf8"))
  assert.equal(marker.state, "idle")
  assert.equal(marker.pending, 2)
  assert.ok(marker.next_due > Date.now(), "a next wake is scheduled")
  handle.stop()
})

test("a triggered wake runs passes and stops at the backlog-below-trigger", async () => {
  const base = await workspace()
  const cfg = config({ trigger_pending: 2 })
  const dbFile = await seedDb({ turns: 3, sessionTime: Date.now() - 600_000 })
  const ledger = createDrainLedger({ logDir: join(base.stateDir, "logs") })
  const handle = startDrainConsumer({ ...deps({ ...base, dbFile }, cfg, { ledger }) })

  const summary = await handle.wake()
  assert.ok(summary)
  assert.equal(summary!.trigger, "consumer")
  assert.equal(summary!.passes, 1)
  assert.ok(summary!.wake_tokens > 0)
  assert.equal(summary!.stopped, "backlog-below-trigger")
  assert.equal(summary!.pending_before, 3)
  assert.equal(summary!.pending_after, 0)

  await ledger.flush()
  const lines = (await readFile(join(base.stateDir, "logs", DRAIN_LEDGER_FILE), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  const consumerLine = lines.find((l) => l.source === "consumer")
  assert.ok(consumerLine, "one consumer ledger line per wake")
  assert.equal(consumerLine.passes, 1)
  assert.equal(consumerLine.stopped, "backlog-below-trigger")
  assert.equal(consumerLine.wake_tokens, summary!.wake_tokens)

  const marker = JSON.parse(await readFile(join(base.stateDir, DRAIN_CURRENT_FILE), "utf8"))
  assert.equal(marker.state, "idle")
  assert.equal(marker.pending, 0)
  handle.stop()
})

test("disabled config is a no-op and the marker idles", async () => {
  const base = await workspace()
  const cfg = config({ enabled: false })
  const handle = startDrainConsumer({ ...deps(base, cfg) })
  const summary = await handle.wake()
  assert.equal(summary, null)
  const marker = JSON.parse(await readFile(join(base.stateDir, DRAIN_CURRENT_FILE), "utf8"))
  assert.equal(marker.state, "idle")
  handle.stop()
})

test("consumer: false (rollback) idles the loop", async () => {
  const base = await workspace()
  const cfg = config({ consumer: false })
  const dbFile = await seedDb({ turns: 5, sessionTime: Date.now() - 600_000 })
  const handle = startDrainConsumer({ ...deps({ ...base, dbFile }, cfg) })
  const summary = await handle.wake()
  assert.equal(summary, null, "legacy lane behaviour: the consumer does not run")
  handle.stop()
})

test("a held lock skips the wake with passes: 0 (§5.1)", async () => {
  const base = await workspace()
  const cfg = config({ trigger_pending: 2 })
  const dbFile = await seedDb({ turns: 3, sessionTime: Date.now() - 600_000 })
  const ledger = createDrainLedger({ logDir: join(base.stateDir, "logs") })
  const lock = await acquireDrainLock(drainLockFile(base.stateDir), {
    refreshMs: cfg.lock_refresh_ms,
    staleMs: cfg.lock_stale_ms,
  })
  assert.ok(lock)

  const handle = startDrainConsumer({ ...deps({ ...base, dbFile }, cfg, { ledger }) })
  const summary = await handle.wake()

  assert.ok(summary)
  assert.equal(summary!.passes, 0, "a lock-held wake never reaches a pass")
  assert.equal(summary!.stopped, "lock-held")

  await ledger.flush()
  const lines = (await readFile(join(base.stateDir, "logs", DRAIN_LEDGER_FILE), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  const consumerLine = lines.find((l) => l.source === "consumer")
  assert.equal(consumerLine.passes, 0)
  assert.equal(consumerLine.stopped, "lock-held")
  assert.equal(
    lines.filter((l) => l.source === "pipe").length,
    0,
    "no pipe line was written — the pass never ran",
  )

  await lock.release()
  handle.stop()
})

test("max_passes_per_wake caps the loop (§2.6 backstop)", async () => {
  const base = await workspace()
  // Many turns, tiny per-pass cap: several passes needed but capped at 2.
  const cfg = config({ trigger_pending: 2, max_passes_per_wake: 2, max_turns_per_session: 1 })
  const dbFile = await seedDb({ turns: 6, sessionTime: Date.now() - 600_000 })
  const handle = startDrainConsumer({ ...deps({ ...base, dbFile }, cfg) })

  const summary = await handle.wake()
  assert.ok(summary)
  assert.equal(summary!.passes, 2, "stops at max_passes_per_wake")
  assert.equal(summary!.stopped, "max-passes")
  handle.stop()
})

test("wake_token_budget caps the wake (§2.6)", async () => {
  const base = await workspace()
  // Budget of 1 token: the first pass spends 14, so the second never starts.
  const cfg = config({
    trigger_pending: 2,
    max_passes_per_wake: 6,
    wake_token_budget: 1,
    max_turns_per_session: 1,
  })
  const dbFile = await seedDb({ turns: 6, sessionTime: Date.now() - 600_000 })
  const handle = startDrainConsumer({ ...deps({ ...base, dbFile }, cfg) })

  const summary = await handle.wake()
  assert.ok(summary)
  assert.equal(summary!.passes, 1, "one pass, then the wake budget stops the loop")
  assert.ok(summary!.wake_tokens >= 1)
  assert.equal(summary!.stopped, "wake-token-budget")
  handle.stop()
})

test("no provider: the wake idles without passes", async () => {
  const base = await workspace()
  const cfg = config({ trigger_pending: 2 })
  const dbFile = await seedDb({ turns: 3, sessionTime: Date.now() - 600_000 })
  const handle = startDrainConsumer({
    ...deps({ ...base, dbFile }, cfg, { provider: null }),
  })
  const summary = await handle.wake()
  assert.equal(summary, null)
  handle.stop()
})

test("a config flip between passes stops the wake (§2.2)", async () => {
  const base = await workspace()
  let cfg = config({ trigger_pending: 2, max_turns_per_session: 1 })
  const dbFile = await seedDb({ turns: 6, sessionTime: Date.now() - 600_000 })
  let calls = 0
  const d = deps({ ...base, dbFile }, cfg)
  // Flip the config after the first pass by swapping readConfig.
  const flipped = {
    ...d,
    readConfig: async () => {
      calls++
      // call 1: wake entry; call 2: before pass 1; call 3: before pass 2.
      if (calls >= 3) return { ...cfg, consumer: false }
      return cfg
    },
  }
  const handle = startDrainConsumer(flipped)
  const summary = await handle.wake()
  assert.ok(summary)
  assert.equal(summary!.passes, 1)
  assert.equal(summary!.stopped, "config-changed")
  handle.stop()
})

test("idleDrainCurrent defaults", () => {
  const marker = idleDrainCurrent(1_000)
  assert.equal(marker.state, "idle")
  assert.equal(marker.trigger, null)
  assert.equal(marker.pass, 0)
  assert.equal(marker.pending, null)
  assert.equal(marker.next_due, null)
  assert.equal(marker.updated_at, new Date(1_000).toISOString())
})

test("oldest-age trigger: old turns fire a wake even below pending count (§2.5)", async () => {
  const base = await workspace()
  const old = Date.now() - 3 * 3_600_000
  const cfg = config({ trigger_pending: 99, trigger_max_age_hours: 2 })
  const dbFile = await seedDb({ turns: 1, sessionTime: old })
  const handle = startDrainConsumer({ ...deps({ ...base, dbFile }, cfg) })

  const summary = await handle.wake()
  assert.ok(summary, "age trigger fires despite pending < trigger_pending")
  assert.equal(summary!.stopped, "backlog-below-trigger")
  handle.stop()
})
