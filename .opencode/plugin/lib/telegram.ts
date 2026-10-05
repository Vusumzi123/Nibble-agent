// Deterministic outbound Telegram notification support for the telegram-hook
// plugin. Everything here is pure and side-effect-light (no network, no LLM),
// mirroring lib/autonomy.ts: the config parser + rendering helpers are exported
// for unit testing, and the hook owns the actual HTTP dispatch.
//
// Config lives in the `telegram:` block of .opencode/sysop-config.yaml and is
// parsed with the same dependency-free flat-scalar approach used by
// parseKnowledgeConfig / parsePathsConfig. Secrets are NEVER stored here: the
// bot token and chat id are read from chmod-600 files referenced by path.
//
// Runtime event names: opencode 1.18.x emits `permission.asked` and
// `question.asked` (the project's pinned plugin SDK still types the older
// `permission.updated` union), so the normalizers accept the legacy and v2
// property shapes as well.
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.
import { parseFlatBlock, readSection, sectionCoercer } from "./config.ts"
import { readCredential } from "./secrets.ts"

// Re-exported for existing consumers (telegram-hook, tests).
export { readCredential }

// Telegram Bot API root (append `/bot<token>/sendMessage`).
export const TELEGRAM_API = "https://api.telegram.org"

// Telegram's hard per-message text limit.
export const TELEGRAM_MAX_CHARS = 4096

// Runtime event names that mean "the window is waiting on the user". Includes
// the legacy v1 name (`permission.updated`) and the v2 variants for forward
// compatibility.
export const PERMISSION_EVENT_TYPES = new Set([
  "permission.asked",
  "permission.v2.asked",
  "permission.updated",
])
export const QUESTION_EVENT_TYPES = new Set(["question.asked", "question.v2.asked"])

// ---------------------------------------------------------------------------
// Config

export type TelegramConfig = {
  enabled: boolean
  bot_token_file: string
  chat_id_file: string
  agent: string
  parse_mode: string
  max_chars: number
  header: boolean
  include_user: boolean
  notify_permissions: boolean
  notify_questions: boolean
}

// Defaults are intentionally inert: `enabled: false` means nothing is sent
// until the user opts in. Credential files are the existing update-reminder
// pair (Sysopagent_bot); token/chat id are never inlined in the repo config.
export const DEFAULT_TELEGRAM: TelegramConfig = {
  enabled: false,
  bot_token_file: "~/.config/update-reminder/telegram-token",
  chat_id_file: "~/.config/update-reminder/telegram-chat-id",
  agent: "",
  parse_mode: "Markdown",
  max_chars: TELEGRAM_MAX_CHARS,
  header: true,
  include_user: false,
  notify_permissions: true,
  notify_questions: true,
}

const KNOWN_KEYS = new Set(Object.keys(DEFAULT_TELEGRAM))
const BOOL_KEYS = new Set([
  "enabled",
  "header",
  "include_user",
  "notify_permissions",
  "notify_questions",
])
const INT_KEYS = new Set(["max_chars"])

// `telegram:` uses strict true/false, unsigned ints, and strings where a
// matched quote pair is stripped (so `""` explicitly means the empty string).
const TELEGRAM_COERCE = sectionCoercer({
  bools: BOOL_KEYS,
  ints: INT_KEYS,
  stringMode: "pair-quotes",
})

// Parse a `telegram:` block out of sysop-config.yaml text. Only flat
// `key: value` scalars are supported, which keeps this dependency-free and
// deterministic. Unrecognized keys are ignored so the section can grow safely.
export function parseTelegramConfig(yamlText: string): Partial<TelegramConfig> {
  return parseFlatBlock(yamlText, "telegram", {
    knownKeys: KNOWN_KEYS,
    coerce: TELEGRAM_COERCE,
  }) as Partial<TelegramConfig>
}

// Read the effective `telegram:` config for a project directory, overlaying the
// block (if present) on the defaults. Never throws: a missing or malformed
// config yields the defaults.
export async function readTelegramConfig(directory: string): Promise<TelegramConfig> {
  return readSection(directory, "telegram", DEFAULT_TELEGRAM, { coerce: TELEGRAM_COERCE })
}

// ---------------------------------------------------------------------------
// Message rendering

// Split text into Telegram-sized chunks, preferring a newline boundary near the
// limit. A single oversized line is still split at the hard limit.
export function chunkText(text: string, maxChars: number = TELEGRAM_MAX_CHARS): string[] {
  const limit = maxChars > 0 ? maxChars : TELEGRAM_MAX_CHARS
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit)
    if (cut < Math.floor(limit / 2)) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, "")
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

export type ReplyMeta = { agent?: string; userMessage?: string }

// Assemble the outbound reply message(s): optional header + optional quoted
// user message + assistant text, chunked to the Telegram limit.
export function buildReplyMessages(
  text: string,
  cfg: TelegramConfig,
  meta: ReplyMeta = {},
): string[] {
  const body = (text ?? "").trim()
  if (!body) return []
  const lines: string[] = []
  if (cfg.header) {
    const who = meta.agent ? `[${meta.agent}]` : "[opencode]"
    lines.push(`${who} ${new Date().toISOString()}`)
  }
  if (cfg.include_user && meta.userMessage) {
    lines.push(`> ${meta.userMessage.trim().slice(0, 500)}`, "")
  }
  lines.push(body)
  return chunkText(lines.join("\n"), cfg.max_chars)
}

// ---------------------------------------------------------------------------
// Attention alerts (permission requests + agent questions)

export type PermissionKind = "sudo" | "file-write" | "other"

// root-escalation markers (per AGENTS.md §2 escalation protocol)
const SUDO_RE = /(^|[\s;&|])(sudo|pkexec|doas|su)(\s|$)|\bsystemctl\b/

// Classify a permission request for the alert icon/label. Edit/write/patch
// permissions are file writes; bash permissions whose patterns match a root
// escalation wrapper are sudo; everything else is generic.
export function classifyPermission(permission: string, patterns: string[]): PermissionKind {
  if (permission === "edit" || permission === "write" || permission === "patch") {
    return "file-write"
  }
  const hay = (patterns ?? []).join(" ")
  if (SUDO_RE.test(hay)) return "sudo"
  return "other"
}

export type PermissionEvent = {
  id?: string
  sessionID?: string
  permission: string
  patterns: string[]
  metadata?: Record<string, unknown>
  always?: string[]
}

export type QuestionInfoLike = {
  question?: string
  header?: string
  options?: Array<{ label?: string; description?: string }>
  multiple?: boolean
}

export type QuestionEvent = {
  id?: string
  sessionID?: string
  questions: QuestionInfoLike[]
}

// Accept both the v1 shape (`permission`/`patterns`) and the v2 shape
// (`action`/`resources`) so the hook is robust across opencode versions.
export function normalizePermissionEvent(props: any): PermissionEvent {
  const p = props ?? {}
  const patterns = Array.isArray(p.patterns)
    ? p.patterns
    : Array.isArray(p.resources)
      ? p.resources
      : []
  return {
    id: typeof p.id === "string" ? p.id : undefined,
    sessionID: typeof p.sessionID === "string" ? p.sessionID : undefined,
    permission:
      typeof p.permission === "string"
        ? p.permission
        : typeof p.action === "string"
          ? p.action
          : "unknown",
    patterns: patterns.map(String),
    metadata: p.metadata && typeof p.metadata === "object" ? p.metadata : undefined,
    always: Array.isArray(p.always) ? p.always.map(String) : undefined,
  }
}

export function normalizeQuestionEvent(props: any): QuestionEvent {
  const p = props ?? {}
  return {
    id: typeof p.id === "string" ? p.id : undefined,
    sessionID: typeof p.sessionID === "string" ? p.sessionID : undefined,
    questions: Array.isArray(p.questions) ? p.questions : [],
  }
}

export function renderPermissionAlert(evt: PermissionEvent): string {
  const kind = classifyPermission(evt.permission, evt.patterns ?? [])
  const icon = kind === "sudo" ? "🛡" : kind === "file-write" ? "📝" : "⚠️"
  const label =
    kind === "sudo"
      ? "sudo / root command"
      : kind === "file-write"
        ? "file-write permission"
        : "permission request"
  const lines = [
    `${icon} *opencode needs attention — ${label}*`,
    "",
    `*Permission:* ${evt.permission || "unknown"}`,
  ]
  const patterns = evt.patterns ?? []
  if (patterns.length) {
    lines.push("*Requested:*")
    for (const p of patterns.slice(0, 10)) lines.push("- `" + p + "`")
    if (patterns.length > 10) lines.push(`- …and ${patterns.length - 10} more`)
  }
  if (evt.sessionID) lines.push("", `_Session:_ \`${evt.sessionID}\``)
  lines.push("", "_Respond in the opencode window._")
  return lines.join("\n")
}

export function renderQuestionAlert(evt: QuestionEvent): string {
  const questions = evt.questions ?? []
  const first = questions[0] ?? {}
  const header = String(first.header ?? "question")
  const question = String(first.question ?? "(no question text)")
  const lines = ["❓ *opencode is asking a question*", "", `*${header}*`, question]
  const options = Array.isArray(first.options) ? first.options : []
  if (options.length) {
    lines.push("")
    for (const o of options.slice(0, 12)) {
      const label = String(o?.label ?? "")
      const desc = o?.description ? ` — ${String(o.description)}` : ""
      lines.push(`• ${label}${desc}`)
    }
  }
  if (questions.length > 1) {
    lines.push("", `_+${questions.length - 1} more question(s)_`)
  }
  if (evt.sessionID) lines.push("", `_Session:_ \`${evt.sessionID}\``)
  lines.push("", "_Answer in the opencode window._")
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// HTTP decision helpers

// Telegram returns 400 "Bad Request: can't parse entities" when legacy Markdown
// is unbalanced (arbitrary agent output will trip this). Retrying once without
// `parse_mode` guarantees delivery. Kept pure so it is unit-testable.
export function shouldRetryPlain(status: number): boolean {
  return status === 400
}
