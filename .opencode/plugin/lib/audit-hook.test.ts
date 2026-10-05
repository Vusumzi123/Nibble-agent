import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, readFile, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { clearLoggerCache } from "./logging.ts"
import { parseNdjson, tempDir, tempHome, writeSection } from "./test-utils.ts"

// Isolate the audit trail: point HOME at a throwaway dir BEFORE the hook module
// resolves the sysop root from the home directory at plugin init.
const TEST_HOME = tempHome("audit-hook-home-")

const { default: createHook } = await import("../audit-hook.ts")

const SYSOp = join(TEST_HOME, ".opencode-sysop")

// Minimal project whose `audit:` section forces rotation after a couple of
// entries and gzips generations older than the newest.
async function freshProject(opts: { rotateBytes?: number } = {}): Promise<string> {
  const dir = await tempDir("audit-hook-proj-")
  await mkdir(SYSOp, { recursive: true })
  // The logger factory caches one logger per resolved path and the trail lives
  // at a fixed <HOME>/<sysop> location, so reset both between tests.
  clearLoggerCache()
  for (const f of await readdir(SYSOp).catch(() => [])) {
    if (f.startsWith("audit.log")) await rm(join(SYSOp, f), { force: true })
  }
  await writeSection(dir, "audit", [
    "enabled: true",
    "log: audit.log",
    `rotate_bytes: ${opts.rotateBytes ?? 80}`,
    "keep_generations: 3",
    "retention_days: 0",
    "compress: true",
    "compress_after: 1",
    "compress_level: 6",
    "rotate_by: size",
  ])
  return dir
}

async function bash(hook: any, command: string, exit: number | null = 0): Promise<void> {
  await hook["tool.execute.after"](
    { sessionID: "ses_main", tool: "bash", args: { command } } as any,
    { metadata: { exit } } as any,
  )
}

function parseLines(text: string): any[] {
  return parseNdjson(text) as any[]
}

test("audit-hook writes a coerced, redacted entry through the shared logger", async () => {
  const dir = await freshProject({ rotateBytes: 0 })
  const hook = await createHook({ directory: dir } as any)
  await hook["chat.message"]({ sessionID: "ses_main", agent: "build" } as any)

  await bash(hook, "curl --token=supersecret https://example.com", 0)

  const log = await readFile(join(SYSOp, "audit.log"), "utf8")
  const [entry] = parseLines(log)
  assert.deepEqual(Object.keys(entry), ["ts", "agent", "cmd", "exit", "root", "sandbox", "dry"])
  assert.equal(entry.agent, "build")
  assert.equal(entry.cmd, "curl --token=*** https://example.com")
  assert.equal(entry.exit, 0)
  assert.equal(entry.root, false)
  assert.equal(entry.sandbox, "opencode")
  assert.equal(entry.dry, false)
  await rm(dir, { recursive: true, force: true })
})

test("audit-hook classifies root, sandbox, and dry-run commands", async () => {
  const dir = await freshProject({ rotateBytes: 0 })
  const hook = await createHook({ directory: dir } as any)
  await hook["chat.message"]({ sessionID: "ses_main", agent: "sysop" } as any)

  await bash(hook, "pkexec pacman -S --noconfirm htop", 0)
  await bash(hook, "docker run --rm alpine echo hi", 0)
  await bash(hook, "pacman -Sw --print htop", 0)
  await bash(hook, "definitely-not-a-real-command", 127)

  const entries = parseLines(await readFile(join(SYSOp, "audit.log"), "utf8"))
  assert.equal(entries[0].root, true)
  assert.equal(entries[1].sandbox, "docker")
  assert.equal(entries[2].dry, true)
  assert.equal(entries[3].exit, 127)
  await rm(dir, { recursive: true, force: true })
})

test("audit-hook rotates and gzips older generations", async () => {
  const dir = await freshProject({ rotateBytes: 80 })
  const hook = await createHook({ directory: dir } as any)
  await hook["chat.message"]({ sessionID: "ses_main", agent: "sysop" } as any)

  for (let i = 0; i < 8; i++) {
    await bash(hook, `echo command-number-${i} with some padding to grow the file`, 0)
  }

  const files = (await readdir(SYSOp)).sort()
  assert.ok(files.includes("audit.log"), "active audit log exists")
  assert.ok(files.includes("audit.log.1"), "newest rotated generation stays plain")
  assert.ok(files.includes("audit.log.2.gz"), "older generations are gzipped")

  const active = parseLines(await readFile(join(SYSOp, "audit.log"), "utf8"))
  const notice = active.find((e) => e.cmd === "log-rotation")
  assert.ok(notice, "a rotation notice is written into the fresh active log")
  assert.equal(notice.agent, "audit-logger")
  assert.deepEqual(Object.keys(notice), ["ts", "agent", "cmd", "exit", "root", "sandbox", "dry"])
  await rm(dir, { recursive: true, force: true })
})

test("audit-hook appends concurrently without interleaving lines", async () => {
  const dir = await freshProject({ rotateBytes: 0 })
  const hook = await createHook({ directory: dir } as any)
  await hook["chat.message"]({ sessionID: "ses_main", agent: "sysop" } as any)

  await Promise.all(
    Array.from({ length: 20 }, (_, i) => bash(hook, `echo concurrent-${i}`, 0)),
  )
  const entries = parseLines(await readFile(join(SYSOp, "audit.log"), "utf8"))
  assert.equal(entries.length, 20)
  await rm(dir, { recursive: true, force: true })
})

test("audit-hook respects audit.enabled: false", async () => {
  const dir = await tempDir("audit-hook-off-")
  await writeSection(dir, "audit", ["enabled: false"])
  const hook = await createHook({ directory: dir } as any)
  assert.deepEqual(Object.keys(hook), [], "no handlers registered when disabled")
  await rm(dir, { recursive: true, force: true })
})
