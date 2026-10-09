import type { Plugin } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  auditRotationEntry,
  coerceEntry,
  readAuditConfig,
} from "./lib/audit.ts"
import { readAutonomyConfig } from "./lib/autonomy.ts"
import { createDiagnostics, getLogger, logSettingsFrom } from "./lib/logging.ts"
import { readResolvedPaths } from "./lib/paths.ts"

// Auto-logs every `bash` command the agent(s) execute to the audit trail,
// without any LLM involvement. Subscribes to `tool.execute.after`, filters to
// the bash tool, builds the entry from the hook payload (command from
// `input.args.command`, exit code from `output.metadata.exit`), redacts
// secrets, and appends it through the shared NDJSON logger — the same engine
// every other structured hook log uses.
//
// The deterministic write happens in-process (the previous Python subprocess
// and its second rotation implementation are retired), so a bash command no
// longer pays a `python3` spawn and cannot race the other logs.

// root escalation wrappers (per AGENTS.md §2 escalation protocol)
const ROOT_RE = /(^|[\s;&|])(sudo|pkexec|doas|su)(\s|$)/
// sandbox engines (per SETUP.md)
const DOCKER_RE = /\bdocker\b/
const FIREJAIL_RE = /\bfirejail\b/
// dry-run markers (heuristic — best effort)
const DRY_RE =
  /--dry-run|--print|--simulate|--no-act|--just-print|--assume-no|-Sw\b|\[DRY-RUN\]/

async function recordFailure(
  stateFile: string,
  stateDir: string,
  err: unknown,
  diag: ReturnType<typeof createDiagnostics>,
): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err)
  await diag.error("[audit-hook] write failed:", msg)
  try {
    await mkdir(stateDir, { recursive: true })
    await writeFile(
      stateFile,
      JSON.stringify(
        {
          lastError: msg,
          lastFailureTime: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    )
  } catch (e) {
    await diag.error("[audit-hook] failed to write state file:", e)
  }
}

export default (async ({ directory }) => {
  const dir = directory ?? process.cwd()
  const resolved = await readResolvedPaths(dir, homedir())
  const logDir = resolved.logDir
  const stateDir = resolved.stateDir
  const audit = await readAuditConfig(dir)
  if (!audit.enabled) return {}

  const STATE_FILE = join(stateDir, "audit-hook.json")
  const diag = createDiagnostics({ logDir, home: homedir(), channel: "audit-hook" })
  // sessionID -> agent name, populated from `chat.message` (input.agent).
  const sessionAgent = new Map<string, string>()

  const logger = getLogger(logSettingsFrom(audit, "log", ""), {
    logDir,
    home: homedir(),
    channel: "audit",
    rotationEntry: auditRotationEntry,
    onError: (err) => {
      void recordFailure(STATE_FILE, stateDir, err, diag)
    },
  })

  return {
    "chat.message": async (input) => {
      if (typeof input.agent === "string" && input.agent) {
        sessionAgent.set(input.sessionID, input.agent)
      }
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "bash") return
      const cmd = input.args?.command
      if (typeof cmd !== "string" || !cmd.trim()) return

      const metadata = (output?.metadata ?? {}) as Record<string, unknown>
      let exit: number | null = null
      if (typeof metadata.exit === "number") {
        exit = metadata.exit
      } else if (metadata.exit != null) {
        const n = Number(metadata.exit)
        if (Number.isFinite(n)) exit = n
      }

      // Stamp the autonomy level live at command time — the same hot-read the
      // gate uses, so flipping autonomy.level needs no restart to show up in
      // the audit trail. A failed read degrades to null, never blocks the log.
      let autonomy_level: number | null = null
      try {
        autonomy_level = (await readAutonomyConfig(dir)).level
      } catch {
        autonomy_level = null
      }

      let entry
      try {
        entry = coerceEntry({
          ts: new Date().toISOString(),
          agent: sessionAgent.get(input.sessionID) ?? "sysop",
          cmd,
          exit,
          root: ROOT_RE.test(cmd),
          sandbox: DOCKER_RE.test(cmd)
            ? "docker"
            : FIREJAIL_RE.test(cmd)
              ? "firejail"
              : "opencode",
          dry: DRY_RE.test(cmd),
          autonomy_level,
        })
      } catch {
        // Non-string command already filtered above; nothing to log.
        return
      }

      await logger.append(entry)
    },
  }
}) satisfies Plugin
