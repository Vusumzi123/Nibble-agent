import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_DRAIN, readDrainConfig } from "./config.ts"
import { childIdleWait } from "./step.ts"

test("the drain step injects child_stall_ms into every idle wait", async () => {
  const calls: Array<[string, number | undefined]> = []
  const wait = childIdleWait(
    { child_stall_ms: 240_000 },
    async (sessionID, timeoutMs) => {
      calls.push([sessionID, timeoutMs])
      return true
    },
  )

  assert.equal(await wait("ses_sum_1"), true)
  assert.equal(await wait("ses_writer"), true)
  assert.deepEqual(calls, [
    ["ses_sum_1", 240_000],
    ["ses_writer", 240_000],
  ])
})

test("child_stall_ms defaults to 240 s and never drops below 1 s", async () => {
  assert.equal(DEFAULT_DRAIN.child_stall_ms, 240_000)

  const dir = await mkdtemp(join(tmpdir(), "drain-step-config-"))
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(
    join(dir, ".opencode", "sysop-config.yaml"),
    "drain:\n  child_stall_ms: 10",
    "utf8",
  )

  assert.equal((await readDrainConfig(dir)).child_stall_ms, 1000)
})
