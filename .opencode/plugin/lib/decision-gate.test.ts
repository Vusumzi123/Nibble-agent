import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { openDecisionGate } from "./decision-gate.ts"
import { buildTriageRequest } from "./decisions.ts"

// A project dir with only a `.opencode/sysop-config.yaml` holding the given
// `decisions:` block (other sections pass through untouched).
async function project(decisions: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dgate-proj-"))
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(
    join(dir, ".opencode", "sysop-config.yaml"),
    ["decisions:", ...decisions.map((l) => "  " + l), ""].join("\n"),
    "utf8",
  )
  return dir
}

const REQUEST = { kind: "noul" as const, state: "turn text", assertion: "say noul", allow_abstain: false }

test("openDecisionGate returns null when decisions are disabled", async () => {
  const dir = await project(["enabled: false"])
  assert.equal(await openDecisionGate(dir), null)
  await rm(dir, { recursive: true, force: true })
})

test("openDecisionGate returns null when the config is missing entirely", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dgate-empty-"))
  assert.equal(await openDecisionGate(dir), null)
  await rm(dir, { recursive: true, force: true })
})

test("openDecisionGate exposes the effective decisions config", async () => {
  const dir = await project(["enabled: true", "mode: gate", "provider: rules", "noul_threshold: 0.9"])
  const gate = await openDecisionGate(dir)
  assert.ok(gate)
  assert.equal(gate.config.enabled, true)
  assert.equal(gate.config.mode, "gate")
  assert.equal(gate.config.noul_threshold, 0.9)
  await rm(dir, { recursive: true, force: true })
})

test("open polarity: a rules abstain falls back to the RulesProvider verdict", async () => {
  const dir = await project(["enabled: true", "provider: rules"])
  const gate = await openDecisionGate(dir)
  assert.ok(gate)
  // A non-triage request is abstained by the rules provider, so the open
  // polarity reports the fallback with its reason.
  const out = await gate.decide({ kind: "choice", state: "x", candidates: ["A", "B"] }, { fallback: "open" })
  assert.ok(out.result)
  assert.equal(out.fallback, true)
  assert.equal(out.reason, "error")
  // The substituted verdict is the RulesProvider's own abstain, carrying the
  // provider's error for the ledger.
  assert.equal(out.result.provider, "rules")
  assert.equal(out.result.abstained, true)
  await rm(dir, { recursive: true, force: true })
})

test("open polarity: a usable verdict is not a fallback", async () => {
  const dir = await project(["enabled: true", "provider: rules"])
  const gate = await openDecisionGate(dir)
  assert.ok(gate)
  const out = await gate.decide(buildTriageRequest("thanks!", 800), { fallback: "open" })
  assert.ok(out.result)
  assert.equal(out.result.value, true)
  assert.equal(out.fallback, false)
  assert.equal(out.reason, "none")
  await rm(dir, { recursive: true, force: true })
})

test("closed polarity: a rules abstain reports reason error with the result kept", async () => {
  const dir = await project(["enabled: true", "provider: rules"])
  const gate = await openDecisionGate(dir)
  assert.ok(gate)
  const out = await gate.decide(REQUEST, { fallback: "closed" })
  assert.equal(out.reason, "error")
  assert.equal(out.fallback, false)
  assert.ok(out.result)
  assert.equal(out.result.abstained, true)
  await rm(dir, { recursive: true, force: true })
})

test("closed polarity: a failed bridge reports reason error with no rules fallback", async () => {
  const dir = await project(["enabled: true", "provider: openjev"])
  const gate = await openDecisionGate(dir, {
    spawner: async () => {
      throw new Error("bridge exploded")
    },
  })
  assert.ok(gate)
  const out = await gate.decide(REQUEST, { fallback: "closed" })
  // The bridge wraps transport failures into an abstained, error-carrying
  // result; closed keeps it for the ledger but marks the gate as errored and
  // never substitutes a rules verdict.
  assert.equal(out.reason, "error")
  assert.equal(out.fallback, false)
  assert.ok(out.result)
  assert.equal(out.result.abstained, true)
  assert.match(String(out.result.error), /bridge exploded/)
  await rm(dir, { recursive: true, force: true })
})

test("spawner passthrough: the configured bridge answers the decision", async () => {
  const dir = await project(["enabled: true", "provider: openjev"])
  let received = ""
  const gate = await openDecisionGate(dir, {
    spawner: async (args) => {
      received = args.request
      return {
        code: 0,
        stdout: JSON.stringify({
          kind: "noul",
          value: true,
          confidence: 0.97,
          probabilities: { true: 0.97, false: 0.03 },
          abstained: false,
        }),
        stderr: "",
      }
    },
  })
  assert.ok(gate)
  const out = await gate.decide(REQUEST, { fallback: "closed" })
  assert.equal(out.reason, "none")
  assert.equal(out.result?.value, true)
  assert.equal(out.fallback, false)
  assert.ok(received.includes("say noul"))
  await rm(dir, { recursive: true, force: true })
})

test("timeout overlay replaces decisions.timeout_ms for this gate only", async () => {
  const dir = await project(["enabled: true", "provider: openjev", "timeout_ms: 30000"])
  let seen = 0
  const gate = await openDecisionGate(dir, {
    timeoutMs: 1234,
    spawner: async (args) => {
      seen = args.timeoutMs
      return { code: 0, stdout: "{}", stderr: "" }
    },
  })
  assert.ok(gate)
  await gate.decide(REQUEST, { fallback: "closed" })
  assert.equal(seen, 1234)
  assert.equal(gate.config.timeout_ms, 30000)
  await rm(dir, { recursive: true, force: true })
})

test("an invalid timeout overlay keeps decisions.timeout_ms", async () => {
  const dir = await project(["enabled: true", "provider: openjev", "timeout_ms: 7000"])
  let seen = 0
  const gate = await openDecisionGate(dir, {
    timeoutMs: 0,
    spawner: async (args) => {
      seen = args.timeoutMs
      return { code: 0, stdout: "{}", stderr: "" }
    },
  })
  assert.ok(gate)
  await gate.decide(REQUEST, { fallback: "closed" })
  assert.equal(seen, 7000)
  await rm(dir, { recursive: true, force: true })
})
