import { test } from "node:test"
import assert from "node:assert/strict"

import {
  peekWrites,
  recordWrite,
  resetVerification,
  takeWrites,
  blockingIssues,
  recordIssue,
  takeIssues,
} from "./verification.ts"

test("recordWrite/takeWrites tracks paths per session and consumes on take", () => {
  resetVerification()
  recordWrite("ses_a", "/vault/AI/Note.md")
  recordWrite("ses_a", "/vault/meta/log.md")
  recordWrite("ses_a", "/vault/meta/log.md") // deduped
  recordWrite("ses_b", "/vault/Other.md")

  assert.deepEqual(peekWrites("ses_a").sort(), ["/vault/AI/Note.md", "/vault/meta/log.md"].sort())

  const taken = takeWrites("ses_a")
  assert.equal(taken.length, 2)
  assert.ok(taken.includes("/vault/meta/log.md"))
  // Consumed: a second take is empty, ses_b untouched.
  assert.deepEqual(takeWrites("ses_a"), [])
  assert.deepEqual(takeWrites("ses_b"), ["/vault/Other.md"])
  assert.deepEqual(takeWrites("ses_missing"), [])
})

test("recordWrite ignores empty session/path", () => {
  resetVerification()
  recordWrite("", "/x")
  recordWrite("ses_a", "")
  assert.deepEqual(peekWrites("ses_a"), [])
})

test("resetVerification clears both issues and writes", () => {
  resetVerification()
  recordWrite("ses_a", "/x")
  recordIssue("ses_a", { path: "x", kind: "date", detail: "d", repaired: true })
  resetVerification()
  assert.deepEqual(peekWrites("ses_a"), [])
  assert.deepEqual(takeIssues("ses_a"), [])
})

test("blockingIssues filters repaired entries and demotes ambiguous", () => {
  resetVerification()
  recordIssue("ses_a", { path: "x", kind: "date", detail: "d", repaired: true })
  recordIssue("ses_a", { path: "y", kind: "ambiguous", detail: "d", repaired: false })
  recordIssue("ses_a", { path: "z", kind: "escaped-wikilink", detail: "repair write failed", repaired: false })
  const blocking = blockingIssues(takeIssues("ses_a"))
  // Only the genuinely-unrepaired, non-ambiguous issue blocks the drain.
  assert.equal(blocking.length, 1)
  assert.equal(blocking[0].path, "z")
})
