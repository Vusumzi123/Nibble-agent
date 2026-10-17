import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_MEMORY,
  parseMemoryConfig,
  readMemoryConfig,
  resetMemoryWarnings,
} from "./config.ts"

test("missing config yields the default provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-config-"))
  assert.deepEqual(await readMemoryConfig(dir), DEFAULT_MEMORY)
})

test("missing provider key keeps the default", () => {
  assert.deepEqual(parseMemoryConfig("memory:\n  other: 1\n"), { provider: "both" })
})

test("all four profiles parse", () => {
  for (const provider of ["both", "rag-brain", "memory-explorer", "none"] as const) {
    assert.equal(parseMemoryConfig(`memory:\n  provider: ${provider}\n`).provider, provider)
  }
})

test("quoted values and trailing comments are accepted", () => {
  assert.equal(parseMemoryConfig('memory:\n  provider: "rag-brain" # vault only\n').provider, "rag-brain")
})

test("an unknown provider fails closed to none with a diagnostic", () => {
  const cfg = parseMemoryConfig("memory:\n  provider: mnemosyne\n")
  assert.equal(cfg.provider, "none")
  assert.match(cfg.invalid ?? "", /unknown memory\.provider "mnemosyne"/)
})

test("readMemoryConfig warns once per project directory", async () => {
  resetMemoryWarnings()
  const dir = await mkdtemp(join(tmpdir(), "memory-config-"))
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(join(dir, ".opencode", "sysop-config.yaml"), "memory:\n  provider: nope\n", "utf8")

  const warnings: string[] = []
  const first = await readMemoryConfig(dir, (m) => warnings.push(m))
  await readMemoryConfig(dir, (m) => warnings.push(m))
  assert.equal(first.provider, "none")
  assert.equal(warnings.length, 1)
})
