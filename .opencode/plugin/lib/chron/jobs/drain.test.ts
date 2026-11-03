import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  DRAIN_PRODUCER_STATE_FILE,
  decideDrainProduction,
  effectiveLastEmitted,
  normalizeIntervalMs,
  readDrainProducerState,
  runDrainScan,
  saveDrainProducerState,
  type DrainDecisionInput,
  type DrainScanDeps,
} from "./drain.ts"
import { openWorkStore } from "../../work-store/sqlite.ts"
import { tempDir } from "../../test-utils.ts"
import type { ChronLog } from "../types.ts"

const silentLog: ChronLog = { event: () => {}, warn: () => {} }
const NOW = 1_000_000

async function setup(): Promise<{ dir: string; stateDir: string }> {
  const dir = await tempDir("chron-drain-")
  const stateDir = join(dir, ".opencode", "state")
  await mkdir(stateDir, { recursive: true })
  return { dir, stateDir }
}

async function config(dir: string, lines: string[]): Promise<void> {
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(join(dir, ".opencode", "sysop-config.yaml"), [...lines, ""].join("\n"), "utf8")
}

function dueResult(
  due: boolean,
  pending: number | null = due ? 99 : 0,
  oldestAgeMs: number | null = due ? 0 : null,
): { due: boolean; pending: number | null; oldestAgeMs: number | null } {
  return { due, pending, oldestAgeMs }
}

function scanDeps(
  dirs: { dir: string; stateDir: string },
  overrides: Partial<DrainScanDeps> = {},
): DrainScanDeps {
  return {
    directory: dirs.dir,
    stateDir: dirs.stateDir,
    log: silentLog,
    now: () => NOW,
    due: async () => dueResult(true),
    ...overrides,
  }
}

async function seedQueue(stateDir: string, nowMs = NOW): Promise<void> {
  const store = await openWorkStore({ stateDir, now: () => nowMs })
  store.enqueue(
    [
      {
        id: "drain-pass",
        kind: "drain-pass",
        producer: "chron:drain",
        enqueued_ms: 1,
        requeue_count: 0,
      },
    ],
    nowMs,
  )
  store.close()
}

async function storeRows(stateDir: string, nowMs = NOW) {
  const store = await openWorkStore({ stateDir, now: () => nowMs })
  const rows = store.dump().items
  store.close()
  return rows
}

test("normalizeIntervalMs coerces invalid input to the shipped default", () => {
  assert.equal(normalizeIntervalMs(15), 15 * 60_000)
  assert.equal(normalizeIntervalMs(1), 60_000)
  assert.equal(normalizeIntervalMs(15.9), 15 * 60_000)
  assert.equal(normalizeIntervalMs(0), 15 * 60_000)
  assert.equal(normalizeIntervalMs(-3), 15 * 60_000)
  assert.equal(normalizeIntervalMs(Number.NaN), 15 * 60_000)
  assert.equal(normalizeIntervalMs(Number.POSITIVE_INFINITY), 15 * 60_000)
})

function decisionInput(overrides: Partial<DrainDecisionInput> = {}): DrainDecisionInput {
  return {
    now_ms: NOW,
    interval_ms: 60_000,
    last_emitted_ms: 0,
    enabled: true,
    queued: false,
    intent_pending: false,
    due: true,
    pending: 20,
    oldest_age_ms: 0,
    ...overrides,
  }
}

test("decideDrainProduction applies the gates in order", () => {
  assert.deepEqual(decideDrainProduction(decisionInput({ enabled: false })), {
    emit: false,
    reason: "disabled",
  })
  assert.deepEqual(decideDrainProduction(decisionInput({ last_emitted_ms: NOW - 59_999 })), {
    emit: false,
    reason: "cooldown",
  })
  assert.deepEqual(decideDrainProduction(decisionInput({ queued: true })), {
    emit: false,
    reason: "queued",
  })
  assert.deepEqual(decideDrainProduction(decisionInput({ intent_pending: true })), {
    emit: false,
    reason: "pending-intent",
  })
  assert.deepEqual(
    decideDrainProduction(decisionInput({ due: false, pending: null, oldest_age_ms: null })),
    { emit: false, reason: "unavailable" },
  )
  assert.deepEqual(
    decideDrainProduction(decisionInput({ due: false, pending: 0, oldest_age_ms: null })),
    { emit: false, reason: "empty" },
  )
  assert.deepEqual(
    decideDrainProduction(decisionInput({ due: false, pending: 5, oldest_age_ms: 1 })),
    { emit: false, reason: "below-trigger" },
  )
  assert.deepEqual(decideDrainProduction(decisionInput()), { emit: true, reason: "emitted" })
})

test("decideDrainProduction treats the cooldown boundary as inclusive", () => {
  assert.equal(
    decideDrainProduction(decisionInput({ last_emitted_ms: NOW - 60_000 })).emit,
    true,
  )
  assert.equal(
    decideDrainProduction(decisionInput({ last_emitted_ms: NOW - 60_001 })).emit,
    true,
  )
})

test("decideDrainProduction lets a zero last_emitted_ms emit immediately", () => {
  assert.equal(decideDrainProduction(decisionInput({ last_emitted_ms: 0 })).emit, true)
})

test("readDrainProducerState reads a valid state file", async () => {
  const dirs = await setup()
  await writeFile(
    join(dirs.stateDir, DRAIN_PRODUCER_STATE_FILE),
    JSON.stringify({ version: 1, last_emitted_ms: 1234 }),
    "utf8",
  )
  assert.deepEqual(await readDrainProducerState(dirs.stateDir), {
    version: 1,
    last_emitted_ms: 1234,
  })
})

test("readDrainProducerState treats missing, corrupt, and wrong-version files as empty", async () => {
  const dirs = await setup()
  assert.deepEqual(await readDrainProducerState(dirs.stateDir), {
    version: 1,
    last_emitted_ms: 0,
  })
  await writeFile(join(dirs.stateDir, DRAIN_PRODUCER_STATE_FILE), "{nope", "utf8")
  assert.deepEqual(await readDrainProducerState(dirs.stateDir), {
    version: 1,
    last_emitted_ms: 0,
  })
  await writeFile(
    join(dirs.stateDir, DRAIN_PRODUCER_STATE_FILE),
    JSON.stringify({ version: 2, last_emitted_ms: 1234 }),
    "utf8",
  )
  assert.deepEqual(await readDrainProducerState(dirs.stateDir), {
    version: 1,
    last_emitted_ms: 0,
  })
})

test("saveDrainProducerState creates a missing state directory", async () => {
  const dir = await tempDir("chron-drain-state-")
  const stateDir = join(dir, "nested", "state")
  assert.equal(await saveDrainProducerState(stateDir, { version: 1, last_emitted_ms: 42 }), true)
  assert.deepEqual(await readDrainProducerState(stateDir), {
    version: 1,
    last_emitted_ms: 42,
  })
})

test("saveDrainProducerState reports failure without throwing", async () => {
  const dir = await tempDir("chron-drain-state-")
  const notADir = join(dir, "state-file")
  await writeFile(notADir, "x", "utf8")
  assert.equal(await saveDrainProducerState(notADir, { version: 1, last_emitted_ms: 42 }), false)
})

test("effectiveLastEmitted clamps future and invalid timestamps to zero", () => {
  assert.equal(effectiveLastEmitted(500, NOW, 60_000), 500)
  assert.equal(effectiveLastEmitted(0, NOW, 60_000), 0)
  assert.equal(effectiveLastEmitted(NOW + 1, NOW, 60_000), 0)
  assert.equal(effectiveLastEmitted(-1, NOW, 60_000), 0)
  assert.equal(effectiveLastEmitted(Number.NaN, NOW, 60_000), 0)
})

test("a due backlog inserts exactly one queued row and one state update", async () => {
  const dirs = await setup()
  let saves = 0
  const report = await runDrainScan(
    scanDeps(dirs, {
      saveState: async (state) => {
        saves++
        return saveDrainProducerState(dirs.stateDir, state)
      },
    }),
  )
  assert.deepEqual(report, {
    emitted: true,
    reason: "emitted",
    pending: 99,
    oldest_age_ms: 0,
  })

  const rows = await storeRows(dirs.stateDir)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, "drain-pass")
  assert.equal(rows[0].kind, "drain-pass")
  assert.equal(rows[0].priority, 3)
  assert.equal(saves, 1)
  assert.deepEqual(await readDrainProducerState(dirs.stateDir), {
    version: 1,
    last_emitted_ms: NOW,
  })
})

test("a second run inside the interval is a cooldown and skips store and DB", async () => {
  const dirs = await setup()
  await runDrainScan(scanDeps(dirs))

  let hasChecks = 0
  let dueChecks = 0
  const second = await runDrainScan(
    scanDeps(dirs, {
      storeHas: () => {
        hasChecks++
        return false
      },
      due: async () => {
        dueChecks++
        return dueResult(true)
      },
    }),
  )
  assert.deepEqual(second, {
    emitted: false,
    reason: "cooldown",
    pending: null,
    oldest_age_ms: null,
  })
  assert.equal(hasChecks, 0)
  assert.equal(dueChecks, 0)
  assert.equal((await storeRows(dirs.stateDir)).length, 1)
})

test("a queued drain-pass returns queued without reading the due check", async () => {
  const dirs = await setup()
  await seedQueue(dirs.stateDir)
  let hasChecks = 0
  let dueChecks = 0
  const report = await runDrainScan(
    scanDeps(dirs, {
      storeHas: () => {
        hasChecks++
        return true
      },
      due: async () => {
        dueChecks++
        return dueResult(true)
      },
    }),
  )
  assert.deepEqual(report, { emitted: false, reason: "queued", pending: null, oldest_age_ms: null })
  assert.equal(hasChecks, 1)
  assert.equal(dueChecks, 0)
  assert.equal((await storeRows(dirs.stateDir)).length, 1)
})

test("an enqueue duplicate returns pending-intent without advancing state", async () => {
  const dirs = await setup()
  let saves = 0
  const report = await runDrainScan(
    scanDeps(dirs, {
      enqueue: () => ({ accepted: [], rejected: [], duplicates: ["drain-pass"] }),
      saveState: async () => {
        saves++
        return true
      },
    }),
  )
  assert.deepEqual(report, {
    emitted: false,
    reason: "pending-intent",
    pending: 99,
    oldest_age_ms: 0,
  })
  assert.equal(saves, 0)
  assert.deepEqual(await readDrainProducerState(dirs.stateDir), {
    version: 1,
    last_emitted_ms: 0,
  })
})

test("an unwritable store directory returns unavailable", async () => {
  const dir = await tempDir("chron-drain-")
  const notADir = join(dir, "state-file")
  await writeFile(notADir, "x", "utf8")
  const report = await runDrainScan({
    directory: dir,
    stateDir: notADir,
    log: silentLog,
    now: () => NOW,
    due: async () => dueResult(true),
  })
  assert.deepEqual(report, {
    emitted: false,
    reason: "unavailable",
    pending: null,
    oldest_age_ms: null,
  })
})

test("a below-trigger backlog reports its counts and does not write", async () => {
  const dirs = await setup()
  const report = await runDrainScan(
    scanDeps(dirs, { due: async () => dueResult(false, 5, 1_000) }),
  )
  assert.deepEqual(report, {
    emitted: false,
    reason: "below-trigger",
    pending: 5,
    oldest_age_ms: 1_000,
  })
  assert.deepEqual(await storeRows(dirs.stateDir), [])
})

test("an empty backlog reports empty", async () => {
  const dirs = await setup()
  const report = await runDrainScan(
    scanDeps(dirs, { due: async () => dueResult(false, 0, null) }),
  )
  assert.deepEqual(report, { emitted: false, reason: "empty", pending: 0, oldest_age_ms: null })
  assert.deepEqual(await storeRows(dirs.stateDir), [])
})

test("drain.enabled false skips the store and the due check", async () => {
  const dirs = await setup()
  await config(dirs.dir, ["drain:", "  enabled: false"])
  let hasChecks = 0
  let dueChecks = 0
  const report = await runDrainScan(
    scanDeps(dirs, {
      storeHas: () => {
        hasChecks++
        return false
      },
      due: async () => {
        dueChecks++
        return dueResult(true)
      },
    }),
  )
  assert.deepEqual(report, { emitted: false, reason: "disabled", pending: null, oldest_age_ms: null })
  assert.equal(hasChecks, 0)
  assert.equal(dueChecks, 0)
})

test("a thrown state read or store check returns unavailable and logs", async () => {
  const cases: Array<{
    name: string
    overrides: Partial<DrainScanDeps>
    pattern: RegExp
  }> = [
    {
      name: "state",
      overrides: {
        readState: async () => {
          throw new Error("state boom")
        },
      },
      pattern: /producer state read failed/,
    },
    {
      name: "store",
      overrides: {
        storeHas: () => {
          throw new Error("store boom")
        },
      },
      pattern: /queue read failed/,
    },
  ]

  for (const item of cases) {
    const dirs = await setup()
    const warnings: string[] = []
    const report = await runDrainScan(
      scanDeps(dirs, {
        ...item.overrides,
        log: { event: () => {}, warn: (message) => warnings.push(message) },
      }),
    )
    assert.deepEqual(report, {
      emitted: false,
      reason: "unavailable",
      pending: null,
      oldest_age_ms: null,
    })
    assert.equal(warnings.length, 1, item.name)
    assert.match(warnings[0], item.pattern, item.name)
  }
})

test("a thrown due check returns unavailable and logs", async () => {
  const dirs = await setup()
  const warnings: string[] = []
  const report = await runDrainScan(
    scanDeps(dirs, {
      log: { event: () => {}, warn: (message) => warnings.push(message) },
      due: async () => {
        throw new Error("db boom")
      },
    }),
  )
  assert.deepEqual(report, {
    emitted: false,
    reason: "unavailable",
    pending: null,
    oldest_age_ms: null,
  })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /due check failed/)
})

test("an enqueue failure returns write-failed, logs, and saves no state", async () => {
  const dirs = await setup()
  const warnings: string[] = []
  let saves = 0
  const report = await runDrainScan(
    scanDeps(dirs, {
      log: { event: () => {}, warn: (message) => warnings.push(message) },
      enqueue: () => {
        throw new Error("write boom")
      },
      saveState: async () => {
        saves++
        return true
      },
    }),
  )
  assert.deepEqual(report, {
    emitted: false,
    reason: "write-failed",
    pending: 99,
    oldest_age_ms: 0,
  })
  assert.equal(saves, 0)
  assert.ok(warnings.some((message) => /intent write failed/.test(message)))
})

test("a full queue rejects the drain pass without advancing state", async () => {
  const dirs = await setup()
  const warnings: string[] = []
  const report = await runDrainScan(
    scanDeps(dirs, {
      log: { event: () => {}, warn: (message) => warnings.push(message) },
      enqueue: () => ({ accepted: [], rejected: ["drain-pass"], duplicates: [] }),
    }),
  )
  assert.deepEqual(report, {
    emitted: false,
    reason: "write-failed",
    pending: 99,
    oldest_age_ms: 0,
  })
  assert.ok(warnings.some((message) => /rejected \(queue full\)/.test(message)))
})

test("a state save failure still reports emitted and logs a warning", async () => {
  const dirs = await setup()
  const warnings: string[] = []
  const report = await runDrainScan(
    scanDeps(dirs, {
      log: { event: () => {}, warn: (message) => warnings.push(message) },
      saveState: async () => false,
    }),
  )
  assert.deepEqual(report, {
    emitted: true,
    reason: "emitted",
    pending: 99,
    oldest_age_ms: 0,
  })
  assert.ok(warnings.some((message) => /state save failed/.test(message)))
  assert.equal((await storeRows(dirs.stateDir)).length, 1)
})

test("a future last_emitted_ms is reset to zero and warned about", async () => {
  const dirs = await setup()
  await writeFile(
    join(dirs.stateDir, DRAIN_PRODUCER_STATE_FILE),
    JSON.stringify({ version: 1, last_emitted_ms: NOW + 10_000 }),
    "utf8",
  )
  const warnings: string[] = []
  const report = await runDrainScan(
    scanDeps(dirs, {
      log: { event: () => {}, warn: (message) => warnings.push(message) },
      due: async () => dueResult(false, 5, 1_000),
    }),
  )
  assert.deepEqual(report, {
    emitted: false,
    reason: "below-trigger",
    pending: 5,
    oldest_age_ms: 1_000,
  })
  assert.ok(warnings.some((message) => /in the future; resetting to 0/.test(message)))
  assert.deepEqual(await readDrainProducerState(dirs.stateDir), {
    version: 1,
    last_emitted_ms: 0,
  })
})

test("a future last_emitted_ms still emits when due", async () => {
  const dirs = await setup()
  await writeFile(
    join(dirs.stateDir, DRAIN_PRODUCER_STATE_FILE),
    JSON.stringify({ version: 1, last_emitted_ms: NOW + 10_000 }),
    "utf8",
  )
  const report = await runDrainScan(scanDeps(dirs))
  assert.equal(report.emitted, true)
  assert.deepEqual(await readDrainProducerState(dirs.stateDir), {
    version: 1,
    last_emitted_ms: NOW,
  })
})

test("a thrown config read returns config-error and writes no state", async () => {
  const dirs = await setup()
  const warnings: string[] = []
  let saves = 0
  const report = await runDrainScan(
    scanDeps(dirs, {
      log: { event: () => {}, warn: (message) => warnings.push(message) },
      readConfig: async () => {
        throw new Error("config boom")
      },
      saveState: async () => {
        saves++
        return true
      },
    }),
  )
  assert.deepEqual(report, {
    emitted: false,
    reason: "config-error",
    pending: null,
    oldest_age_ms: null,
  })
  assert.equal(saves, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /config read failed/)
})

test("two sequential scans in the same millisecond emit one row", async () => {
  const dirs = await setup()
  const first = await runDrainScan(scanDeps(dirs))
  const second = await runDrainScan(scanDeps(dirs))
  assert.equal(first.reason, "emitted")
  assert.equal(second.reason, "cooldown")
  assert.equal((await storeRows(dirs.stateDir)).length, 1)
})

test("integration: emit, cooldown, queue dedupe, then disabled", async () => {
  const dirs = await setup()
  let now = NOW
  const deps = (overrides: Partial<DrainScanDeps> = {}) =>
    scanDeps(dirs, { now: () => now, due: async () => dueResult(true), ...overrides })

  const first = await runDrainScan(deps())
  assert.equal(first.reason, "emitted")
  assert.equal((await storeRows(dirs.stateDir, now)).length, 1)
  assert.deepEqual(await readDrainProducerState(dirs.stateDir), {
    version: 1,
    last_emitted_ms: NOW,
  })

  const second = await runDrainScan(deps())
  assert.equal(second.reason, "cooldown")
  assert.equal((await storeRows(dirs.stateDir, now)).length, 1)

  now = NOW + 15 * 60_000 + 1
  await seedQueue(dirs.stateDir, now)
  const third = await runDrainScan(deps())
  assert.equal(third.reason, "queued")
  assert.equal((await storeRows(dirs.stateDir, now)).length, 1)

  await config(dirs.dir, ["drain:", "  enabled: false"])
  now += 15 * 60_000
  const fourth = await runDrainScan(deps())
  assert.equal(fourth.reason, "disabled")
  assert.equal((await storeRows(dirs.stateDir, now)).length, 1)
})
