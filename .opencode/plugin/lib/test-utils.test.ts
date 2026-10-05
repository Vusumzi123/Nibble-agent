import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { parseNdjson, mockClient, tempDir, tempHome, writeSection } from "./test-utils.ts"

test("tempHome creates a dir and points HOME at it", () => {
  const dir = tempHome("tu-home-")
  assert.equal(homedir(), dir)
  assert.equal(process.env.HOME, dir)
})

test("parseNdjson parses non-blank lines", () => {
  assert.deepEqual(parseNdjson('{"a":1}\n\n{"b":2}\n'), [{ a: 1 }, { b: 2 }])
  assert.deepEqual(parseNdjson(""), [])
})

test("writeSection writes an indented block and returns the path", async () => {
  const dir = await tempDir("tu-proj-")
  const path = await writeSection(dir, "other", ["file: Other.md", "enabled: true"])
  assert.match(path, /\.opencode\/sysop-config\.yaml$/)
  assert.equal(await readFile(path, "utf8"), "other:\n  file: Other.md\n  enabled: true\n")
})

test("mockClient records spawns, prompts and toasts", async () => {
  const client = mockClient({ childParent: { child: "parent" } })
  assert.deepEqual((await client.session.get({ path: { id: "child" } } as any)).data, {
    parentID: "parent",
  })
  assert.deepEqual((await client.session.get({ path: { id: "top" } } as any)).data, {})
  await client.session.create({} as any)
  await client.session.promptAsync({ x: 1 } as any)
  await client.tui.showToast({ y: 2 } as any)
  assert.equal(client.calls.create, 1)
  assert.equal(client.calls.prompts.length, 1)
  assert.equal(client.calls.toasts.length, 1)
})
