import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:net"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { configScalar, resolvePort } from "../../../scripts/lib/net.mjs"

test("free-port: a preferred free port is kept, 0 asks the kernel", async () => {
  const free = await resolvePort(0)
  assert.ok(free.port > 0)
  assert.equal(free.fallback, false)

  const same = await resolvePort(free.port)
  assert.equal(same.port, free.port)
  assert.equal(same.fallback, false)
})

test("free-port: a busy preferred port falls back and says so", async () => {
  const blocker = createServer()
  const busy = await new Promise<number>((resolve) =>
    blocker.listen(0, "127.0.0.1", () => resolve((blocker.address() as { port: number }).port)),
  )
  try {
    const picked = await resolvePort(busy)
    assert.notEqual(picked.port, busy)
    assert.ok(picked.port > 0)
    assert.equal(picked.fallback, true)
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
  }
})

test("config: reads a dashboard scalar without a YAML dependency", async () => {
  const dir = await mkdtemp(join(tmpdir(), "net-cfg-"))
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(
    join(dir, ".opencode", "sysop-config.yaml"),
    [
      "dashboard:",
      "  port: 0                      # auto",
      '  serve_port: "43123"',
      "  serve_url: ''",
      "autonomy:",
      "  level: 3",
    ].join("\n"),
    "utf8",
  )
  assert.equal(await configScalar(dir, "dashboard", "port"), "0")
  assert.equal(await configScalar(dir, "dashboard", "serve_port"), "43123")
  assert.equal(await configScalar(dir, "dashboard", "serve_url"), "")
  assert.equal(await configScalar(dir, "autonomy", "level"), "3")
  assert.equal(await configScalar(dir, "dashboard", "missing"), "")
})
