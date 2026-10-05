import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_AUDIT,
  auditRotationEntry,
  coerceEntry,
  parseAuditConfig,
  redact,
} from "./audit.ts"

// Expected outputs captured from the retired audit-logger.py so the TS port is
// byte-for-byte equivalent on the redaction patterns.
const REDACT_CASES: Array<[string, string]> = [
  ["curl --password=secret123 https://x", "curl --password=*** https://x"],
  ["curl --password supersecret https://x", "curl --password *** https://x"],
  ["mysql -u root --token=abc123 -e 'select 1'", "mysql -u root --token=*** -e 'select 1'"],
  ["export API_KEY=deadbeef; run", "export API_KEY=*** run"],
  ["curl -H 'Authorization: Bearer xyz.abc' https://x", "curl -H 'Authorization: ***' https://x"],
  ["curl -H 'X-API-Key: 12345' https://x", "curl -H 'X-API-Key: ***' https://x"],
  ["echo hunter2 | sudo -S rm -rf /tmp/x", "echo *** | sudo -S rm -rf /tmp/x"],
  ["psql password=pgpass123", "psql password=***"],
  ["Authorization=authval other", "Authorization=*** other"],
  ["plain command with no secrets", "plain command with no secrets"],
]

test("redact matches the retired Python implementation", () => {
  for (const [input, expected] of REDACT_CASES) {
    assert.equal(redact(input), expected, `redact(${JSON.stringify(input)})`)
  }
})

test("coerceEntry normalizes fields and preserves order", () => {
  const entry = coerceEntry({
    agent: "",
    cmd: "echo hi",
    exit: "3.9",
    root: "yes",
    sandbox: "",
    dry: 1,
  })
  assert.deepEqual(Object.keys(entry), ["ts", "agent", "cmd", "exit", "root", "sandbox", "dry"])
  assert.equal(entry.agent, "sysop")
  assert.equal(entry.exit, 3)
  assert.equal(entry.root, true)
  assert.equal(entry.sandbox, "opencode")
  assert.equal(entry.dry, true)
  assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T.*Z$/)
  assert.equal(redact(entry.cmd), "echo hi")
})

test("coerceEntry redacts the command and rejects a non-string cmd", () => {
  const entry = coerceEntry({ cmd: "run --token=abc123" })
  assert.equal(entry.cmd, "run --token=***")
  assert.throws(() => coerceEntry({ cmd: 42 }), /cmd must be a string/)
})

test("coerceEntry leaves a missing exit as null and keeps false booleans", () => {
  const entry = coerceEntry({ cmd: "ls", exit: null, root: false, dry: false })
  assert.equal(entry.exit, null)
  assert.equal(entry.root, false)
  assert.equal(entry.dry, false)
})

test("auditRotationEntry preserves the Python notice shape", () => {
  assert.deepEqual(auditRotationEntry("2026-01-01T00:00:00.000Z"), {
    ts: "2026-01-01T00:00:00.000Z",
    agent: "audit-logger",
    cmd: "log-rotation",
    exit: 0,
    root: false,
    sandbox: "none",
    dry: false,
  })
})

test("parseAuditConfig reads bare keys and ignores unknown ones", () => {
  const cfg = parseAuditConfig(
    [
      "audit:",
      "  enabled: false",
      "  log: custom.log",
      "  rotate_bytes: 2048",
      "  keep_generations: 2",
      "  retention_days: 30",
      "  compress: false",
      "  compress_after: 3",
      "  compress_level: 9",
      "  rotate_by: weekly",
      "  bogus_key: 1",
    ].join("\n"),
  )
  assert.deepEqual(cfg, {
    enabled: false,
    log: "custom.log",
    rotate_bytes: 2048,
    keep_generations: 2,
    retention_days: 30,
    compress: false,
    compress_after: 3,
    compress_level: 9,
    rotate_by: "weekly",
  })
  assert.equal(DEFAULT_AUDIT.rotate_bytes, 10485760)
})
