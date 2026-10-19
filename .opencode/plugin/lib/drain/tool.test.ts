import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DEFAULT_DRAIN } from "./config.ts"
import {
  findDrainToolResult,
  parseDrainToolOutput,
  runDrainForMission,
} from "./tool.ts"

function project(): Promise<{ directory: string; stateDir: string; vaultDir: string }> {
  return (async () => {
    const root = await mkdtemp(join(tmpdir(), "drain-tool-"))
    const directory = join(root, "project")
    const stateDir = join(directory, ".opencode", "state")
    const vaultDir = join(directory, "Brain")
    await mkdir(stateDir, { recursive: true })
    await mkdir(vaultDir, { recursive: true })
    return { directory, stateDir, vaultDir }
  })()
}

const writer = {
  capabilities: { write: true },
  consolidate: async () => ({ ok: true, consumed: [], skipped: [] }),
} as any

test("parseDrainToolOutput normalizes a completed result", () => {
  const parsed = parseDrainToolOutput(
    JSON.stringify({
      status: "completed",
      reason: null,
      outcome: "completed",
      summary: "drain:completed",
      tokens: 45,
      session: "ses_writer",
      cursor_before: 10,
      cursor_after: 20,
      sessions: 1,
      items: 2,
    }),
  )
  assert.ok(parsed)
  assert.equal(parsed.status, "completed")
  assert.equal(parsed.tokens, 45)
  assert.equal(parsed.session, "ses_writer")
  assert.equal(parsed.items, 2)
  assert.equal(parseDrainToolOutput("not json"), null)
  assert.equal(parseDrainToolOutput({ status: "maybe" }), null)
})

test("findDrainToolResult reads the last tool part from a transcript", () => {
  const rows = [
    {
      parts: [
        {
          type: "tool",
          tool: "drain_run",
          state: { output: JSON.stringify({ status: "skipped", reason: "in-sync", tokens: 0 }) },
        },
      ],
    },
    {
      parts: [
        {
          type: "tool",
          tool: "drain_run",
          state: { output: JSON.stringify({ status: "completed", tokens: 7, session: "w" }) },
        },
      ],
    },
  ]
  const found = findDrainToolResult(rows)
  assert.ok(found)
  assert.equal(found.status, "completed")
  assert.equal(found.tokens, 7)
  assert.equal(found.session, "w")
})

test("runDrainForMission skips a disabled lane without running the pipe", async () => {
  const ws = await project()
  const result = await runDrainForMission({
    ...ws,
    config: { ...DEFAULT_DRAIN, enabled: false },
    client: {} as any,
    provider: writer,
    waitForIdle: async () => true,
  })
  assert.equal(result.status, "skipped")
  assert.equal(result.reason, "disabled")
  assert.equal(result.tokens, 0)
  assert.equal(result.cursor_before, null)
})

test("runDrainForMission skips when the provider has no writer", async () => {
  const ws = await project()
  const result = await runDrainForMission({
    ...ws,
    config: { ...DEFAULT_DRAIN, initial_lookback_hours: 0 },
    client: {} as any,
    provider: { capabilities: { write: false } } as any,
    waitForIdle: async () => true,
  })
  assert.equal(result.status, "skipped")
  assert.equal(result.reason, "paused")
  assert.equal(result.summary, "drain:paused")
})
