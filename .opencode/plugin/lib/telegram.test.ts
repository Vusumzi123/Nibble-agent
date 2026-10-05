import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_TELEGRAM,
  TELEGRAM_MAX_CHARS,
  PERMISSION_EVENT_TYPES,
  QUESTION_EVENT_TYPES,
  parseTelegramConfig,
  readTelegramConfig,
  readCredential,
  chunkText,
  buildReplyMessages,
  classifyPermission,
  normalizePermissionEvent,
  normalizeQuestionEvent,
  renderPermissionAlert,
  renderQuestionAlert,
  shouldRetryPlain,
  type TelegramConfig,
} from "./telegram.ts"

const cfg = (over: Partial<TelegramConfig> = {}): TelegramConfig => ({
  ...DEFAULT_TELEGRAM,
  ...over,
})

// ---------------------------------------------------------------------------
// Config parsing

test("parseTelegramConfig: absent section yields empty overlay", () => {
  assert.deepEqual(parseTelegramConfig("other:\n  enabled: true\n"), {})
})

test("parseTelegramConfig: coerces booleans, ints, and strings", () => {
  const yaml = [
    "telegram:",
    "  enabled: true",
    "  max_chars: 2000",
    "  agent: kael",
    "  parse_mode: Markdown",
    "  header: false",
    "  notify_questions: false",
    "",
  ].join("\n")
  const parsed = parseTelegramConfig(yaml)
  assert.equal(parsed.enabled, true)
  assert.equal(parsed.max_chars, 2000)
  assert.equal(parsed.agent, "kael")
  assert.equal(parsed.parse_mode, "Markdown")
  assert.equal(parsed.header, false)
  assert.equal(parsed.notify_questions, false)
})

test("parseTelegramConfig: quoted empty string is preserved, comments stripped", () => {
  const yaml = [
    "telegram:",
    '  agent: ""            # all agents',
    "  enabled: true        # master on/off",
    "",
  ].join("\n")
  const parsed = parseTelegramConfig(yaml)
  assert.equal(parsed.agent, "")
  assert.equal(parsed.enabled, true)
})

test("parseTelegramConfig: ignores unknown keys and non-scalar garbage", () => {
  const yaml = ["telegram:", "  nonsense: 42", "  enabled: maybe", ""].join("\n")
  const parsed = parseTelegramConfig(yaml)
  assert.equal(parsed.nonsense, undefined)
  assert.equal(parsed.enabled, undefined)
})

test("readTelegramConfig: missing file yields defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tg-"))
  assert.deepEqual(await readTelegramConfig(dir), DEFAULT_TELEGRAM)
})

test("readTelegramConfig: overlay applied over defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tg-"))
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(
    join(dir, ".opencode", "sysop-config.yaml"),
    "telegram:\n  enabled: true\n  agent: kael\n",
    "utf8",
  )
  const read = await readTelegramConfig(dir)
  assert.equal(read.enabled, true)
  assert.equal(read.agent, "kael")
  // untouched keys fall back to defaults
  assert.equal(read.max_chars, DEFAULT_TELEGRAM.max_chars)
})

test("readCredential: trims trailing newline and expands ~", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tg-"))
  const file = join(dir, "telegram-token")
  await writeFile(file, "123456:ABC\n", "utf8")
  assert.equal(await readCredential(file), "123456:ABC")
  assert.equal(await readCredential(file, dir), "123456:ABC")
  assert.equal(await readCredential("~/does-not-exist", dir), "")
})

// ---------------------------------------------------------------------------
// Chunking / reply assembly

test("chunkText: short text is a single chunk", () => {
  assert.deepEqual(chunkText("hello", 100), ["hello"])
  assert.deepEqual(chunkText("", 100), [])
})

test("chunkText: every chunk respects the limit", () => {
  const text = "x".repeat(10) + "\n" + "y".repeat(10) + "\n" + "z".repeat(10)
  const parts = chunkText(text, 12)
  assert.ok(parts.length >= 3)
  for (const p of parts) assert.ok(p.length <= 12, `chunk too long: ${p.length}`)
  assert.equal(parts.join("").replace(/\n/g, ""), text.replace(/\n/g, ""))
})

test("chunkText: a single oversized line is hard-split", () => {
  const parts = chunkText("a".repeat(25), 10)
  assert.equal(parts.length, 3)
  assert.deepEqual(parts, ["a".repeat(10), "a".repeat(10), "a".repeat(5)])
})

test("buildReplyMessages: header + user prefix + chunking", () => {
  const text = "b".repeat(TELEGRAM_MAX_CHARS + 5)
  const msgs = buildReplyMessages(text, cfg({ header: false, include_user: false }))
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0].length, TELEGRAM_MAX_CHARS)
  assert.equal(msgs[1].length, 5)

  const withMeta = buildReplyMessages("done", cfg({ header: true, include_user: true }), {
    agent: "kael",
    userMessage: "install htop",
  })
  assert.equal(withMeta.length, 1)
  assert.match(withMeta[0], /^\[kael\] /)
  assert.match(withMeta[0], /> install htop/)
  assert.match(withMeta[0], /\ndone$/)
})

test("buildReplyMessages: empty body yields no messages", () => {
  assert.deepEqual(buildReplyMessages("   ", cfg()), [])
})

// ---------------------------------------------------------------------------
// Permission / question rendering

test("classifyPermission: edit is file-write, root wrappers are sudo", () => {
  assert.equal(classifyPermission("edit", ["/etc/hosts"]), "file-write")
  assert.equal(classifyPermission("write", []), "file-write")
  assert.equal(classifyPermission("bash", ["pkexec pacman -S htop"]), "sudo")
  assert.equal(classifyPermission("bash", ["sudo systemctl restart nginx"]), "sudo")
  assert.equal(classifyPermission("bash", ["systemctl stop foo"]), "sudo")
  assert.equal(classifyPermission("bash", ["paru -S htop"]), "other")
})

test("normalizePermissionEvent: accepts v1 and v2 shapes", () => {
  const v1 = normalizePermissionEvent({
    id: "per_1",
    sessionID: "ses_1",
    permission: "bash",
    patterns: ["pkexec pacman -Syu"],
  })
  assert.equal(v1.id, "per_1")
  assert.equal(v1.permission, "bash")
  assert.deepEqual(v1.patterns, ["pkexec pacman -Syu"])

  const v2 = normalizePermissionEvent({
    id: "per_2",
    sessionID: "ses_2",
    action: "edit",
    resources: ["/etc/hosts"],
  })
  assert.equal(v2.permission, "edit")
  assert.deepEqual(v2.patterns, ["/etc/hosts"])
})

test("renderPermissionAlert: contains kind label, patterns and session", () => {
  const sudo = renderPermissionAlert(
    normalizePermissionEvent({
      id: "p",
      sessionID: "ses_abc",
      permission: "bash",
      patterns: ["pkexec pacman -Syu"],
    }),
  )
  assert.match(sudo, /needs attention/)
  assert.match(sudo, /sudo \/ root command/)
  assert.match(sudo, /pkexec pacman -Syu/)
  assert.match(sudo, /ses_abc/)

  const edit = renderPermissionAlert(
    normalizePermissionEvent({ permission: "edit", patterns: ["/etc/hosts"] }),
  )
  assert.match(edit, /file-write permission/)
})

test("normalizeQuestionEvent + renderQuestionAlert", () => {
  const evt = normalizeQuestionEvent({
    id: "q1",
    sessionID: "ses_q",
    questions: [
      {
        header: "Backend",
        question: "Which package manager?",
        options: [{ label: "pacman" }, { label: "flatpak", description: "sandboxed" }],
      },
    ],
  })
  const text = renderQuestionAlert(evt)
  assert.match(text, /asking a question/)
  assert.match(text, /Backend/)
  assert.match(text, /Which package manager\?/)
  assert.match(text, /pacman/)
  assert.match(text, /flatpak — sandboxed/)
  assert.match(text, /ses_q/)
})

test("event type sets cover new and legacy names", () => {
  assert.ok(PERMISSION_EVENT_TYPES.has("permission.asked"))
  assert.ok(PERMISSION_EVENT_TYPES.has("permission.updated"))
  assert.ok(QUESTION_EVENT_TYPES.has("question.asked"))
  assert.ok(QUESTION_EVENT_TYPES.has("question.v2.asked"))
})

test("shouldRetryPlain: only 400 retries", () => {
  assert.equal(shouldRetryPlain(400), true)
  assert.equal(shouldRetryPlain(200), false)
  assert.equal(shouldRetryPlain(429), false)
})
