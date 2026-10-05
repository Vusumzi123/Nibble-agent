import type { Plugin } from "@opencode-ai/plugin"
import { automationChildSessions } from "./lib/automation.ts"
import { homedir } from "node:os"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createDiagnostics } from "./lib/logging.ts"
import { readResolvedPaths } from "./lib/paths.ts"
import { createSessionTools, textOf } from "./lib/sessions.ts"
import {
  PERMISSION_EVENT_TYPES,
  QUESTION_EVENT_TYPES,
  TELEGRAM_API,
  buildReplyMessages,
  normalizePermissionEvent,
  normalizeQuestionEvent,
  readCredential,
  readTelegramConfig,
  renderPermissionAlert,
  renderQuestionAlert,
  shouldRetryPlain,
  type TelegramConfig,
} from "./lib/telegram.ts"

// Deterministic outbound Telegram notifier. Two responsibilities, both driven
// by server events (no LLM, no tool calls, so no recursion):
//
//   1. Reply forwarding — on `session.idle`, POST the top-level session's last
//      assistant reply to the configured Telegram chat. Gated by telegram.agent.
//   2. Attention alerts — on `permission.asked` (sudo/file-write/other) and
//      `question.asked` (agent questions), POST a "needs attention" message so
//      the user is pinged when the window blocks waiting on them. Alerts ignore
//      the agent filter and are notify-only: the user still answers in opencode.
//
// The `telegram:` config section is re-read on every event, so flipping
// `enabled` (or the per-category flags) takes effect without restarting
// opencode. Secrets are read from chmod-600 files at send time and never logged.

export default (async ({ client, directory }) => {
  const resolved = await readResolvedPaths(directory, homedir())
  const sysopDir = resolved.sysopDir
  const STATE_FILE = join(sysopDir, "telegram-hook.json")
  const diag = createDiagnostics({ sysopDir, home: homedir(), channel: "telegram-hook" })

  async function recordFailure(err: unknown): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err)
    await diag.error("[telegram-hook]", msg)
    try {
      await mkdir(sysopDir, { recursive: true })
      await writeFile(
        STATE_FILE,
        JSON.stringify({ lastError: msg, lastFailureTime: new Date().toISOString() }, null, 2),
        "utf8",
      )
    } catch {
      // best effort
    }
  }

  // sessionID -> agent name (from chat.message), and the latest user message
  // (only needed when telegram.include_user is on).
  const sessionAgent = new Map<string, string>()
  const sessionUserMessage = new Map<string, string>()
  // sessionID -> last assistant message id already forwarded (dedupe retries).
  const sentReplies = new Map<string, string>()
  // event ids already alerted on (dedupe repeated permission/question events).
  const alerted = new Set<string>()
  // Shared, cached child/agent lookup (lib/sessions.ts).
  const sessions = createSessionTools(client, directory, {
    onError: (err, ctx) => {
      if (ctx === "get") void diag.error("[telegram-hook] session.get failed:", err)
    },
  })

  // POST one already-rendered message. Reads credentials at send time (never
  // cached in memory / never logged). Retries once without `parse_mode` when
  // Telegram rejects the markdown, so delivery never fails on unbalanced output.
  async function send(text: string, cfg: TelegramConfig): Promise<void> {
    const token = await readCredential(cfg.bot_token_file)
    const chatId = await readCredential(cfg.chat_id_file)
    if (!token || !chatId) throw new Error("missing telegram bot token or chat id")

    const url = `${TELEGRAM_API}/bot${token}/sendMessage`
    const attempt = async (parseMode: string | null): Promise<Response> => {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }
      if (parseMode) body.parse_mode = parseMode
      return fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    }

    let res = await attempt(cfg.parse_mode || null)
    if (!res.ok && cfg.parse_mode && shouldRetryPlain(res.status)) {
      res = await attempt(null)
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      throw new Error(`telegram sendMessage ${res.status}: ${detail.slice(0, 300)}`)
    }
  }

  return {
    "chat.message": async (input, output) => {
      if (typeof input.agent === "string" && input.agent) {
        sessionAgent.set(input.sessionID, input.agent)
      }
      const userText = textOf(output?.parts ?? []).trim()
      if (userText) sessionUserMessage.set(input.sessionID, userText)
    },

    event: async ({ event }) => {
      const type = (event as any)?.type as string | undefined
      const props = (event as any)?.properties ?? {}

      // --- Attention: permission requests (sudo / file-write / other) --------
      if (type && PERMISSION_EVENT_TYPES.has(type)) {
        try {
          const cfg = await readTelegramConfig(directory)
          if (!cfg.enabled || !cfg.notify_permissions) return
          const evt = normalizePermissionEvent(props)
          const key = evt.id ?? `${evt.sessionID}:${evt.permission}:${(evt.patterns ?? []).join(",")}`
          if (alerted.has(key)) return
          alerted.add(key)
          await send(renderPermissionAlert(evt), cfg)
        } catch (err) {
          await recordFailure(err)
        }
        return
      }

      // --- Attention: agent questions ---------------------------------------
      if (type && QUESTION_EVENT_TYPES.has(type)) {
        try {
          const cfg = await readTelegramConfig(directory)
          if (!cfg.enabled || !cfg.notify_questions) return
          const evt = normalizeQuestionEvent(props)
          const key = evt.id ?? `${evt.sessionID}:question`
          if (alerted.has(key)) return
          alerted.add(key)
          await send(renderQuestionAlert(evt), cfg)
        } catch (err) {
          await recordFailure(err)
        }
        return
      }

      // --- Reply forwarding --------------------------------------------------
      if (type !== "session.idle") return
      const sid = props.sessionID as string | undefined
      if (!sid) return
      if (automationChildSessions.has(sid)) return

      try {
        const cfg = await readTelegramConfig(directory)
        if (!cfg.enabled) return
        if ((await sessions.meta(sid)).child) return

        const agent = sessionAgent.get(sid) ?? (await sessions.meta(sid)).agent ?? ""
        if (cfg.agent && agent !== cfg.agent) return

        const res = await client.session.messages({ path: { id: sid }, query: { directory } })
        const rows = Array.isArray(res?.data) ? res.data : []
        let replyText = ""
        let replyID = ""
        for (let i = rows.length - 1; i >= 0; i--) {
          const info = (rows[i] as any)?.info ?? {}
          if (info.role !== "assistant") continue
          const text = textOf((rows[i] as any)?.parts ?? []).trim()
          if (text) {
            replyText = text
            replyID = String(info.id ?? "")
            break
          }
        }
        if (!replyText) return
        if (sentReplies.get(sid) === replyID) return

        const userMessage = sessionUserMessage.get(sid) ?? ""
        const messages = buildReplyMessages(replyText, cfg, { agent, userMessage })
        for (const m of messages) await send(m, cfg)
        sentReplies.set(sid, replyID)
      } catch (err) {
        await recordFailure(err)
      }
    },
  }
}) satisfies Plugin
