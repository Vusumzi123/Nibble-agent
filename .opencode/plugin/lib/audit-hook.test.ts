import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tempDir, tempHome } from "./test-utils.ts"

// Isolate HOME before the hook module resolves anything home-scoped.
const TEST_HOME = tempHome("ahook-home-")
void TEST_HOME
const { default: createHook } = await import("../audit-hook.ts")

async function project(level?: number): Promise<string> {
  const dir = await tempDir("ahook-proj-")
  await mkdir(join(dir, ".opencode"), { recursive: true })
  if (level !== undefined) {
    await writeFile(
      join(dir, ".opencode", "sysop-config.yaml"),
      ["autonomy:", `  level: ${level}`, ""].join("\n"),
      "utf8",
    )
  }
  return dir
}

async function readAudit(dir: string): Promise<any[]> {
  try {
    const raw = await readFile(join(dir, ".opencode", "logs", "audit.log"), "utf8")
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

async function runCommand(hooks: any, command: string): Promise<void> {
  await hooks["tool.execute.after"](
    { sessionID: "ses_1", tool: "bash", args: { command } } as any,
    { metadata: { exit: 0 } } as any,
  )
}

test("audit-hook stamps the hot-read autonomy level on every command", async () => {
  const dir = await project(3)
  const hooks = await createHook({ directory: dir } as any)
  await runCommand(hooks, "echo hi")
  const lines = await readAudit(dir)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].cmd, "echo hi")
  assert.equal(lines[0].autonomy_level, 3)
  await rm(dir, { recursive: true, force: true })
})

test("a level flip applies to the next command without re-creating the hook", async () => {
  const dir = await project(3)
  const hooks = await createHook({ directory: dir } as any)
  await runCommand(hooks, "echo one")
  await writeFile(
    join(dir, ".opencode", "sysop-config.yaml"),
    ["autonomy:", "  level: 0", ""].join("\n"),
    "utf8",
  )
  await runCommand(hooks, "echo two")
  const lines = await readAudit(dir)
  assert.equal(lines.length, 2)
  assert.equal(lines[0].autonomy_level, 3)
  assert.equal(lines[1].autonomy_level, 0)
  await rm(dir, { recursive: true, force: true })
})

test("a missing config falls back to the code default level", async () => {
  const dir = await project()
  const hooks = await createHook({ directory: dir } as any)
  await runCommand(hooks, "echo hi")
  const lines = await readAudit(dir)
  assert.equal(lines.length, 1)
  // DEFAULT_AUTONOMY.level (code default 1) when no autonomy block exists.
  assert.equal(lines[0].autonomy_level, 1)
  await rm(dir, { recursive: true, force: true })
})
