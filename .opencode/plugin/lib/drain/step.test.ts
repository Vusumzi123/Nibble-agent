import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_DRAIN, readDrainConfig } from "./config.ts"
import { runDrainStep } from "./step.ts"

test("child_stall_ms defaults to 600 s, attempts to 2, and the floor holds", async () => {
  assert.equal(DEFAULT_DRAIN.child_stall_ms, 600_000)
  assert.equal(DEFAULT_DRAIN.max_attempts, 2)

  const dir = await mkdtemp(join(tmpdir(), "drain-step-config-"))
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(
    join(dir, ".opencode", "sysop-config.yaml"),
    "drain:\n  child_stall_ms: 10\n  max_attempts: 0",
    "utf8",
  )

  const cfg = await readDrainConfig(dir)
  assert.equal(cfg.child_stall_ms, 1000)
  assert.equal(cfg.max_attempts, DEFAULT_DRAIN.max_attempts)
})

test("a disabled config returns before any provider or child work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drain-step-"))
  const result = await runDrainStep({
    directory: dir,
    stateDir: dir,
    vaultDir: dir,
    client: {} as any,
    resolveProvider: async () => undefined,
    readConfig: async () => ({ ...DEFAULT_DRAIN, enabled: false }),
  })
  assert.deepEqual(result, { ran: false, reason: "disabled" })
})
