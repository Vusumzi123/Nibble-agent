import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_DRAIN } from "./config.ts"
import type { DrainPipeClient, DrainPipeDeps } from "./pipe.ts"
import { hasMissionRunner, runMissionRunner } from "./runner.ts"

function stubClient(): DrainPipeClient {
  return {
    session: {
      async create() {
        return { data: { id: "ses_x" } }
      },
      async promptAsync() {
        return { response: { ok: true } }
      },
      async messages() {
        return { data: [] }
      },
    },
  }
}

async function deps(): Promise<DrainPipeDeps> {
  const root = await mkdtemp(join(tmpdir(), "drain-runner-"))
  return {
    directory: "/work/project-a",
    stateDir: root,
    vaultDir: root,
    config: { ...DEFAULT_DRAIN, enabled: false },
    client: stubClient(),
    waitForIdle: async () => true,
  }
}

test("drain-pipe is registered", () => {
  assert.equal(hasMissionRunner("drain-pipe"), true)
  assert.equal(hasMissionRunner("nope"), false)
})

test("an unknown runner returns null for fall-through", async () => {
  assert.equal(await runMissionRunner("nope", await deps()), null)
})

test("the drain-pipe runner dispatches the pipe", async () => {
  const result = await runMissionRunner("drain-pipe", await deps())
  assert.equal(result?.outcome, "nothing")
})
