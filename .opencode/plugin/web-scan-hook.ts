import type { Plugin } from "@opencode-ai/plugin"
import { homedir } from "node:os"
import {
  buildWebScanLogEntry,
  buildWebUsageLogEntry,
  readBrowserConfig,
  transformWebContent,
} from "./lib/browser.ts"
import { readTelemetryConfig } from "./lib/telemetry.ts"
import { scanWeb, webVerdict } from "./lib/injection.ts"
import { getLogger, logSettingsFrom } from "./lib/logging.ts"
import { readResolvedPaths } from "./lib/paths.ts"

// Deterministic web injection scanner for the built-in webfetch/websearch
// tools. Subscribes to `tool.execute.after`, filters to those two tools, scans
// the returned content with the shared injection scanner (web variant), and
// rewrites the tool output to carry an untrusted-content fence plus a compact
// one-line [web-scan: …] brief — mirroring what the mail-hook does for mail_*.
//
// Full finding detail (family / severity / snippet) is written to an NDJSON
// audit log under <log>/<browser.scan_log>, never into the agent's context,
// so hostile snippets are not echoed back and the brief stays tiny.
//
// This hook also emits one `web-fetch` usage record for EVERY webfetch/websearch
// call to <log>/<telemetry.web_log> — tool, child session, sanitized target,
// pre-transform byte count, scan verdict, wall time, outcome. The web-usage
// ledger is gated by `telemetry.enabled` INDEPENDENTLY of `browser.enabled`
// (which gates the scan), so disabling the scan still leaves the telemetry on
// (and vice versa). No fetched text or query is stored.
//
// Only the safe-browser sub-agent is permitted to run webfetch/websearch
// (denied globally in opencode.json), so this hook only ever touches output
// destined for that read-only agent.
export default (async ({ directory }) => {
  const dir = directory ?? process.cwd()
  const cfg = await readBrowserConfig(dir)
  const telemetry = await readTelemetryConfig(dir)
  const resolved = await readResolvedPaths(dir, homedir())
  const scanLog = getLogger(logSettingsFrom(cfg, "scan_log", "log_"), {
    logDir: resolved.logDir,
    home: homedir(),
    channel: "web-scan",
  })
  const webLog = telemetry.enabled
    ? getLogger(logSettingsFrom(telemetry, "web_log", ""), {
        logDir: resolved.logDir,
        home: homedir(),
        channel: "telemetry-web",
      })
    : null

  // callID -> fetch start. Deleted on the first `after` (bounded below).
  const starts = new Map<string, number>()

  return {
    "tool.execute.before": async (input) => {
      if (input.tool !== "webfetch" && input.tool !== "websearch") return
      if (starts.size >= 512) {
        const oldest = starts.keys().next().value
        if (oldest !== undefined) starts.delete(oldest)
      }
      starts.set(input.callID, Date.now())
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "webfetch" && input.tool !== "websearch") return

      const t0 = starts.get(input.callID)
      starts.delete(input.callID)
      const wallMs = t0 == null ? null : Date.now() - t0

      const target = input.tool === "webfetch" ? input.args?.url : input.args?.query
      const raw = output.output
      const hasText = typeof raw === "string"
      // Byte count must be the PRE-transform size: transformWebContent fences
      // the text and would otherwise inflate the recorded bytes.
      const bytes = hasText ? Buffer.byteLength(raw, "utf8") : 0
      let verdict = "UNSCANNED"

      if (cfg.enabled && hasText) {
        const head = raw.slice(0, cfg.max_scan_bytes)
        const scan = scanWeb(head)
        verdict = webVerdict(scan)
        output.output = transformWebContent(
          raw,
          scan,
          cfg.injection_policy,
          typeof target === "string" ? target : undefined,
        )

        if (scan.findings.length > 0) {
          await scanLog.append(
            buildWebScanLogEntry({
              tool: input.tool,
              target: typeof target === "string" ? target : "",
              scan,
            }),
          )
        }
      }

      if (webLog) {
        await webLog.append(
          buildWebUsageLogEntry({
            tool: input.tool,
            session: input.sessionID,
            target: typeof target === "string" ? target : "",
            bytes,
            verdict,
            wallMs,
            outcome: hasText ? "ok" : "no-output",
          }),
        )
      }
    },
  }
}) satisfies Plugin
