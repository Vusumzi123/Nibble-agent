import { test } from "node:test"
import assert from "node:assert/strict"
import {
  CHARS_PER_TOKEN,
  asBool,
  asFloat,
  asInt,
  errText,
  estimateTokens,
  nowIso,
  sleep,
} from "./util.ts"

test("nowIso returns an ISO-8601 UTC timestamp", () => {
  assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
})

test("errText unwraps Errors and stringifies the rest", () => {
  assert.equal(errText(new Error("boom")), "boom")
  assert.equal(errText("plain"), "plain")
  assert.equal(errText(42), "42")
})

test("sleep resolves after roughly the requested delay", async () => {
  const start = Date.now()
  await sleep(20)
  assert.ok(Date.now() - start >= 15)
})

test("asBool coerces the usual truthy tokens", () => {
  assert.equal(asBool(true), true)
  assert.equal(asBool(false), false)
  assert.equal(asBool("yes"), true)
  assert.equal(asBool(" ON "), true)
  assert.equal(asBool("true"), true)
  assert.equal(asBool("1"), true)
  assert.equal(asBool("0"), false)
  assert.equal(asBool(""), false)
})

test("asBool honours the fallback for null/undefined and uses truthiness otherwise", () => {
  assert.equal(asBool(undefined, true), true)
  assert.equal(asBool(null, true), true)
  assert.equal(asBool(0, true), false)
  assert.equal(asBool(1, false), true)
})

test("asInt truncates numbers and rejects non-integer strings", () => {
  assert.equal(asInt(3.9, -1), 3)
  assert.equal(asInt(7, -1), 7)
  assert.equal(asInt("42", -1), 42)
  assert.equal(asInt(" -3 ", -1), -3)
  assert.equal(asInt("+8", -1), 8)
  assert.equal(asInt("3.9", -1), -1)
  assert.equal(asInt("", -1), -1)
  assert.equal(asInt("abc", -1), -1)
  assert.equal(asInt(NaN, -1), -1)
})

test("asFloat parses finite floats and rejects junk", () => {
  assert.equal(asFloat(3.14, -1), 3.14)
  assert.equal(asFloat("2.5", -1), 2.5)
  assert.equal(asFloat(" 1e3 ", -1), 1000)
  assert.equal(asFloat("", -1), -1)
  assert.equal(asFloat("abc", -1), -1)
  assert.equal(asFloat(NaN, -1), -1)
  assert.equal(asFloat(Infinity, -1), -1)
})

test("estimateTokens uses the UTF-8 byte length at CHARS_PER_TOKEN", () => {
  assert.equal(CHARS_PER_TOKEN, 4)
  assert.equal(estimateTokens(""), 0)
  assert.equal(estimateTokens("abcd"), 1)
  assert.equal(estimateTokens("abcde"), 2)
  assert.equal(estimateTokens("é"), 1)
  assert.equal(estimateTokens("ééé"), 2)
})
