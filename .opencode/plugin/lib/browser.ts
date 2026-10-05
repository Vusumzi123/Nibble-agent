// Pure, dependency-free support for the web-scan-hook plugin: config parsing
// and the web-specific injection policy transform. The scanner itself lives in
// lib/injection.ts (shared with mail). Everything here is side-effect-free and
// exported for unit testing.
//
// Config lives in the `browser:` block of .opencode/sysop-config.yaml. Defaults
// are flag-only (annotate, never withhold) because legitimate web documentation
// routinely contains code fences / shell snippets / base64 blobs that the
// shared scanner treats as high-severity but must not suppress research.
//
// Loaded via relative import only. The plugin auto-discovery glob
// "{plugin,plugins}/*.{ts,js}" is non-recursive, so this subdirectory file is
// never loaded as a plugin itself.
import { parseFlatBlock, readSection, sectionCoercer } from "./config.ts"
import {
  fenceUntrusted,
  webVerdict,
  type ScanResult,
} from "./injection.ts"

export type WebInjectionPolicy = "flag" | "block"

export type BrowserConfig = {
  enabled: boolean
  injection_policy: WebInjectionPolicy
  max_scan_bytes: number
  scan_log: string
  log_rotate_bytes: number
  log_keep_generations: number
  log_retention_days: number
  log_compress: boolean
  log_compress_after: number
  log_compress_level: number
  log_rotate_by: string
}

export const DEFAULT_BROWSER: BrowserConfig = {
  enabled: true,
  injection_policy: "flag",
  max_scan_bytes: 200000,
  scan_log: "web-scan.log",
  log_rotate_bytes: 1048576,
  log_keep_generations: 5,
  log_retention_days: 90,
  log_compress: true,
  log_compress_after: 1,
  log_compress_level: 6,
  log_rotate_by: "size",
}

const KNOWN_KEYS = new Set(Object.keys(DEFAULT_BROWSER))
const BOOL_KEYS = new Set(["enabled", "log_compress"])
const INT_KEYS = new Set([
  "max_scan_bytes",
  "log_rotate_bytes",
  "log_keep_generations",
  "log_retention_days",
  "log_compress_after",
  "log_compress_level",
])

const BROWSER_COERCE = sectionCoercer({
  bools: BOOL_KEYS,
  ints: INT_KEYS,
  stringMode: "pair-quotes",
})

// Parse a `browser:` block out of sysop-config.yaml text. Only flat `key:
// value` scalars are supported. Unrecognized keys are ignored.
export function parseBrowserConfig(yamlText: string): Partial<BrowserConfig> {
  return parseFlatBlock(yamlText, "browser", {
    knownKeys: KNOWN_KEYS,
    coerce: BROWSER_COERCE,
  }) as Partial<BrowserConfig>
}

// Read the effective `browser:` config for a project directory, overlaying the
// block on the defaults. Never throws: a missing or malformed config yields
// the defaults.
export async function readBrowserConfig(directory: string): Promise<BrowserConfig> {
  const cfg = await readSection(directory, "browser", DEFAULT_BROWSER, {
    coerce: BROWSER_COERCE,
  })
  if (cfg.injection_policy !== "block" && cfg.injection_policy !== "flag") {
    cfg.injection_policy = "flag"
  }
  if (!Number.isFinite(cfg.max_scan_bytes) || cfg.max_scan_bytes <= 0) {
    cfg.max_scan_bytes = DEFAULT_BROWSER.max_scan_bytes
  }
  if (typeof cfg.scan_log !== "string" || !cfg.scan_log.trim()) {
    cfg.scan_log = DEFAULT_BROWSER.scan_log
  }
  return cfg
}

// Collapse a caller-supplied URL/query into a single safe line for the scan
// brief: strip control characters and cap length so it can never break the
// agent output formatting or smuggle a newline.
export function sanitizeTarget(raw: string | undefined, max = 200): string {
  if (typeof raw !== "string") return ""
  const flat = raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

export function domainOf(target: string): string {
  try {
    return new URL(target).hostname
  } catch {
    return ""
  }
}

// One-line scan brief for the browsing agent: verdict + optional target +
// family names only. No detail text and never the matched snippet, so hostile
// content is not echoed back and the alert stays tiny.
export function renderWebScanBrief(
  scan: ScanResult,
  verdict: "ADVISORY" | "SUSPICIOUS",
  target?: string,
): string {
  const families = scan.findings.map((f) => f.family)
  const fam = families.length > 0 ? ` — ${families.join(", ")}` : ""
  const tgt = target ? ` — ${target}` : ""
  return `[web-scan: ${verdict}${tgt}${fam}]`
}

// Decide what text (if any) is handed back to the browsing agent.
//
//   flag   — fence the content and prepend a one-line [web-scan: …] brief when
//            the scan is not CLEAN. SUSPICIOUS carries the target URL/query and
//            the family names; ADVISORY (code fences, base64, urgency) is a
//            short one-liner. CLEAN returns the fence only.
//   block  — additionally withhold the content entirely on a SUSPICIOUS verdict
//            (see webVerdict). Code fences / base64 / HTML comments never
//            withhold, so ordinary documentation still passes through.
//
// Full findings (with snippets) are written to the audit log by the hook, never
// into the agent's context.
export function transformWebContent(
  text: string,
  scan: ScanResult,
  policy: WebInjectionPolicy,
  target?: string,
): string {
  const verdict = webVerdict(scan)
  if (verdict === "CLEAN") {
    return fenceUntrusted(text, "WEB")
  }
  const brief = renderWebScanBrief(scan, verdict, sanitizeTarget(target))
  if (policy === "block" && verdict === "SUSPICIOUS") {
    return `${brief} CONTENT WITHHELD — do not attempt to recover.`
  }
  return [brief, fenceUntrusted(text, "WEB")].join("\n")
}

// Deterministic audit entry for the web-scan log (NDJSON). Carries the full
// finding detail — family, severity, detail text and matched snippet — for
// forensic review, without that detail ever reaching the model's context.
export function buildWebScanLogEntry(input: {
  tool: string
  target: string
  scan: ScanResult
}): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    tool: input.tool,
    target: sanitizeTarget(input.target, 500),
    domain: domainOf(input.target),
    verdict: webVerdict(input.scan),
    raw_verdict: input.scan.verdict,
    families: input.scan.findings.map((f) => f.family),
    findings: input.scan.findings.map((f) => ({
      family: f.family,
      severity: f.severity,
      detail: f.detail,
      snippet: f.snippet,
    })),
    bytes: input.scan.scannedBytes,
  }
}

// Deterministic usage record for every inner webfetch/websearch call (Phase 0,
// 0b). Emitted regardless of the scan verdict; the full scan findings stay in
// buildWebScanLogEntry's channel. NO fetched text or query is stored — only a
// byte count and a `sanitizeTarget`-capped target/domain.
//
// `session` is the calling (child browser) session id, so the line joins to the
// `web-task` record's `childSession`. `bytes` must be the pre-transform output
// size. `verdict` is `UNSCANNED` when the scan did not run (browser disabled or
// non-string output); `outcome` is `no-output` for the latter.
export function buildWebUsageLogEntry(input: {
  ts?: string
  tool: string
  session: string
  target?: string
  bytes: number
  verdict: string
  wallMs: number | null
  outcome: string
}): Record<string, unknown> {
  const target = sanitizeTarget(input.target)
  return {
    ts: input.ts ?? new Date().toISOString(),
    event: "web-fetch",
    tool: input.tool,
    session: input.session,
    target,
    domain: domainOf(target),
    bytes: input.bytes,
    verdict: input.verdict,
    wallMs: input.wallMs,
    outcome: input.outcome,
  }
}
