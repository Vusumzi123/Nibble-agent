// Dashboard HTTP server (kanban card 8 — autonomy-harness plan §9.2).
//
// Single-origin local web UI backend: serves the static UI, the schema-
// validated config API, metrics/ledger/backlog reads, and a streaming proxy
// to `opencode serve` so chat/SSE share one origin (direct browser→serve is
// never served — rejected by construction). CSRF is the whole mutation gate
// today; login/2FA/TLS semantics are card 11.
//
// Request guards (every request): Host must be loopback (DNS-rebinding
// defense). Every non-idempotent request additionally needs a same-origin
// Origin header (when present) and a valid `X-CSRF-Token` from GET /api/csrf.
//
// Runnable: `node .opencode/plugin/lib/dashboard-server.ts [project-dir]`
// (launchers: scripts/run.sh, scripts/dashboard-ctl.sh). Port and proxy target
// resolve as opts > env (DASHBOARD_PORT / OPENCODE_SERVE_URL) >
// dashboard.port / dashboard.serve_port / dashboard.serve_url config >
// defaults (0 = auto / auto). The bound URL is published to
// `state/dashboard-url`; an automatic proxy target is liveness-checked per
// request and a dead one answers 503 instead of a stale 502.
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { request as httpsRequest } from "node:https"
import { readFile, stat, unlink } from "node:fs/promises"
import { extname, join, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { errText } from "./util.ts"
import { NESTED_WRITABLE_SECTIONS, readDashboardConfig } from "./autonomy.ts"
import { atomicWrite } from "./fsx.ts"
import { readResolvedPaths } from "./paths.ts"
import { firstReachable, probeServe } from "./serve-target.ts"
import {
  DashboardError,
  backlogSnapshot,
  configSnapshot,
  createCsrfStore,
  heartbeatSnapshot,
  isLoopback,
  drainSnapshot,
  listLedgers,
  memoryPendingSnapshot,
  metricsSnapshot,
  missionsSnapshot,
  queuesSnapshot,
  runsSnapshot,
  setMissionEnabled,
  tailLedger,
  tokenSeriesSnapshot,
  writeConfig,
  type CsrfStore,
} from "./dashboard.ts"

const CSRF_HEADER = "x-csrf-token"
const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS"])
const MAX_BODY_BYTES = 1024 * 1024

export type DashboardServerOpts = {
  directory: string
  /** 0 = ephemeral (default). Else DASHBOARD_PORT env, else dashboard.port. */
  port?: number
  /** Defaults to the `dashboard.bind_address` config value. */
  host?: string
  /** Explicit proxy target. Default OPENCODE_SERVE_URL env, else the live pointer, else dashboard.serve_url. */
  serveUrl?: string
  /** Bind an ephemeral port when the requested one is busy (default true). */
  portFallback?: boolean
  /** Static UI root. Default `<directory>/dashboard/static`. */
  staticDir?: string
  csrfTtlMs?: number
}

export type DashboardHandle = {
  server: Server
  host: string
  port: number
  url: string
  serveUrl: string
  csrf: CsrfStore
  close(): Promise<void>
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(text)
}

function fail(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  if (err instanceof DashboardError) {
    json(res, err.status, { error: err.code, message: err.message, detail: err.detail ?? null })
    return
  }
  json(res, 500, { error: "internal", message: errText(err) })
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new DashboardError(413, "body_too_large", "request body too large")
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new DashboardError(400, "bad_json", "request body is not valid JSON")
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])

/** Env var → port, or null when unset/invalid (config wins over garbage). */
function envInt(name: string): number | null {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return null
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : null
}

function hostIsLoopback(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (typeof host !== "string" || host === "") return false
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]
  return LOOPBACK_HOSTS.has(hostname.toLowerCase())
}

function originOk(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true // non-browser client (curl) — CSRF still required
  if (typeof origin !== "string") return false
  return origin.toLowerCase() === `http://${String(req.headers.host).toLowerCase()}`
}

function csrfOk(req: IncomingMessage, csrf: CsrfStore): boolean {
  const header = req.headers[CSRF_HEADER]
  const token = Array.isArray(header) ? header[0] : header
  if (!csrf.verify(token)) return false
  // Double-submit: when the browser sends the cookie, it must match the header.
  const cookie = req.headers.cookie ?? ""
  const m = /(?:^|;\s*)nibble_csrf=([0-9a-f]+)/.exec(cookie)
  if (m && m[1] !== token) return false
  return true
}

// Stream a request through to `opencode serve` (plan §9.2 chat path). Drops
// dashboard-origin headers so the upstream sees a clean single-origin call.
async function proxyServe(req: IncomingMessage, res: ServerResponse, pathSuffix: string, serveBase: URL): Promise<void> {
  const target = new URL(pathSuffix === "" ? "/" : pathSuffix, serveBase)
  const headers: Record<string, string | string[] | undefined> = { ...req.headers }
  delete headers.host
  delete headers.cookie
  delete headers.origin
  delete headers.referer
  delete headers["content-length"] // re-set by the client below only when piped

  const transport = serveBase.protocol === "https:" ? httpsRequest : httpRequest
  const hasBody = !IDEMPOTENT.has(req.method ?? "GET")
  if (hasBody && typeof req.headers["content-length"] === "string") {
    headers["content-length"] = req.headers["content-length"]
  }

  const up = transport(
    {
      protocol: serveBase.protocol,
      hostname: serveBase.hostname,
      port: serveBase.port || (serveBase.protocol === "https:" ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      headers,
    },
    (upRes) => {
      const respHeaders: Record<string, string | string[] | number> = {}
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (v === undefined) continue
        const key = k.toLowerCase()
        if (key === "connection" || key === "transfer-encoding" || key === "keep-alive") continue
        respHeaders[k] = v
      }
      res.writeHead(upRes.statusCode ?? 502, respHeaders)
      upRes.pipe(res)
    },
  )
  up.on("error", (err) => {
    if (!res.headersSent) json(res, 502, { error: "serve_unreachable", message: errText(err) })
    else res.destroy()
  })
  if (hasBody) req.pipe(up)
  else up.end()
}

// ---------------------------------------------------------------------------
// Static SPA assets (kanban card 9): the dashboard UI ships as a separate
// project (e.g. a built Angular app) and points here via DASHBOARD_STATIC_DIR.
// Only non-API GET/HEAD paths reach this; the path is resolved under the
// static root and traversal outside it is refused. An unknown path falls back
// to index.html (client-side routing) — 404 only when the root has no UI.

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
}

async function serveStatic(res: ServerResponse, staticDir: string, urlPath: string): Promise<void> {
  const baseDir = resolve(staticDir)
  let decoded = urlPath
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    // malformed percent-encoding — use the raw path (will 404/fall back)
  }
  let target = resolve(baseDir, "." + decoded)
  if (target !== baseDir && !target.startsWith(baseDir + sep)) {
    throw new DashboardError(403, "path", "path traversal refused")
  }
  try {
    const info = await stat(target)
    if (info.isDirectory()) target = join(target, "index.html")
    const data = await readFile(target)
    res.writeHead(200, {
      "content-type": MIME_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    })
    res.end(data)
    return
  } catch (err) {
    if (err instanceof DashboardError) throw err
    // SPA fallback: an unknown path is a client-side route -> index.html.
    try {
      const html = await readFile(join(baseDir, "index.html"))
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      res.end(html)
    } catch {
      json(res, 404, { error: "no_ui", message: "static UI missing (dashboard/static/index.html)" })
    }
  }
}

export async function createDashboardServer(opts: DashboardServerOpts): Promise<DashboardHandle> {
  const directory = opts.directory
  const dash = await readDashboardConfig(directory)
  const host = opts.host ?? dash.bind_address
  if (!isLoopback(host)) {
    throw new DashboardError(403, "bind_requires_auth", `refusing to bind non-loopback ${host} while auth is card 11`)
  }
  const port = opts.port ?? envInt("DASHBOARD_PORT") ?? dash.port

  // Static target (no probing) for `handle.serveUrl`, `/api/health`, and the
  // startup log: opts > env > live pointer > config. The proxy uses
  // `resolveLiveServeUrl` so an automatic target is never trusted blindly.
  const pointerFile = async (): Promise<string> =>
    join((await readResolvedPaths(directory)).stateDir, "serve-url")
  const readPointer = async (): Promise<string> => {
    try {
      return (await readFile(await pointerFile(), "utf8")).trim()
    } catch {
      return ""
    }
  }
  const staticServeUrl = (await readPointer()) || dash.serve_url
  const serveUrl = opts.serveUrl ?? process.env.OPENCODE_SERVE_URL ?? staticServeUrl

  // An explicit target (opts/env) is honoured as-is: a caller that pinned a URL
  // wants the real proxy error, not a discovery fallback. Otherwise probe the
  // pointer/config and fall back to a process discovered in this directory.
  const pinned = opts.serveUrl !== undefined || process.env.OPENCODE_SERVE_URL !== undefined
  let liveCache: { at: number; url: string | null } | null = null
  async function resolveLiveServeUrl(force = false): Promise<string | null> {
    if (pinned) return serveUrl || null
    const now = Date.now()
    if (!force && liveCache && now - liveCache.at < 2000) return liveCache.url
    const found = await firstReachable([await readPointer(), dash.serve_url], directory)
    liveCache = { at: now, url: found }
    return found
  }

  const staticDir = opts.staticDir ?? join(directory, "dashboard", "static")
  const csrf = createCsrfStore(opts.csrfTtlMs !== undefined ? { ttlMs: opts.csrfTtlMs } : {})

  const server = createServer((req, res) => {
    void route(req, res).catch((err) => fail(res, err))
  })

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase()
    const url = new URL(req.url ?? "/", "http://placeholder")
    const path = url.pathname

    // DNS-rebinding defense: loopback Host or nothing.
    if (!hostIsLoopback(req)) throw new DashboardError(403, "host", "loopback Host header required")

    // Mutations: same-origin Origin (when present) + CSRF token.
    if (!IDEMPOTENT.has(method)) {
      if (!originOk(req)) throw new DashboardError(403, "origin", "cross-origin request refused")
      if (!csrfOk(req, csrf)) throw new DashboardError(403, "csrf", "missing or invalid X-CSRF-Token (GET /api/csrf)")
    }

    if (method === "OPTIONS") throw new DashboardError(405, "method", "OPTIONS not allowed")

    // --- static UI (single origin) ---
    if (method === "GET" && (path === "/" || path === "/index.html")) {
      try {
        const html = await readFile(join(staticDir, "index.html"), "utf8")
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        res.end(html)
      } catch {
        json(res, 404, { error: "no_ui", message: "static UI missing (dashboard/static/index.html)" })
      }
      return
    }
    if (path === "/favicon.ico") {
      res.writeHead(204)
      res.end()
      return
    }

    // --- API ---
    if (path === "/api/health" && method === "GET") {
      const live = await resolveLiveServeUrl()
      // A pinned target is not probed by the resolver (its proxy error must
      // surface as 502), but health still reports the truth.
      const serveOk = live === null ? false : pinned ? await probeServe(live) : true
      json(res, 200, {
        ok: true,
        directory,
        serve_url: live ?? serveUrl,
        serve_ok: serveOk,
        writable_sections: [...NESTED_WRITABLE_SECTIONS],
        auth: "csrf",
      })
      return
    }

    if (path === "/api/csrf" && method === "GET") {
      const issue = csrf.issue()
      res.setHeader("set-cookie", issue.cookie)
      json(res, 200, { token: issue.token })
      return
    }

    if (path === "/api/config" && method === "GET") {
      json(res, 200, await configSnapshot(directory))
      return
    }

    if (path === "/api/config" && method === "PUT") {
      const body = (await readJsonBody(req)) as { section?: unknown; values?: unknown }
      if (typeof body.section !== "string" || typeof body.values !== "object" || body.values === null) {
        throw new DashboardError(400, "bad_request", "expected { section: string, values: object }")
      }
      const result = await writeConfig(directory, body.section, body.values, {
        origin: typeof req.headers.origin === "string" ? req.headers.origin : null,
        ip: req.socket.remoteAddress ?? null,
      })
      json(res, 200, result)
      return
    }

    if (path === "/api/metrics" && method === "GET") {
      json(res, 200, await metricsSnapshot(directory))
      return
    }

    // Unconsumed memory turns (drain backlog) for the header indicator.
    if (path === "/api/memory/pending" && method === "GET") {
      json(res, 200, await memoryPendingSnapshot(directory))
      return
    }

    // Drain consumer loop (plan §6.1): live marker + last wake/pass.
    if (path === "/api/drain" && method === "GET") {
      json(res, 200, await drainSnapshot(directory))
      return
    }

    if (path === "/api/heartbeat" && method === "GET") {
      json(res, 200, await heartbeatSnapshot(directory))
      return
    }

    // Lane queues + run history (queue-monitoring plan): what is queued, what
    // ran recently (with its session), and token spend against the budget.
    if (path === "/api/queues" && method === "GET") {
      json(res, 200, await queuesSnapshot(directory))
      return
    }

    if (path === "/api/runs" && method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 50)
      json(
        res,
        200,
        await runsSnapshot(directory, {
          limit: Number.isFinite(limit) ? limit : 50,
          mission: url.searchParams.get("mission"),
          lane: url.searchParams.get("lane"),
          outcome: url.searchParams.get("outcome"),
        }),
      )
      return
    }

    if (path === "/api/metrics/tokens" && method === "GET") {
      const hours = Number(url.searchParams.get("hours") ?? 24)
      json(
        res,
        200,
        await tokenSeriesSnapshot(directory, {
          bucket: url.searchParams.get("bucket"),
          hours: Number.isFinite(hours) ? hours : 24,
          mission: url.searchParams.get("mission"),
          lane: url.searchParams.get("lane"),
          type: url.searchParams.get("type"),
        }),
      )
      return
    }

    if (path === "/api/ledgers" && method === "GET") {
      const { logDir } = await readResolvedPaths(directory)
      json(res, 200, { ledgers: await listLedgers(logDir) })
      return
    }

    if (path.startsWith("/api/ledgers/") && method === "GET") {
      const { logDir } = await readResolvedPaths(directory)
      const name = decodeURIComponent(path.slice("/api/ledgers/".length))
      const limit = Number(url.searchParams.get("limit") ?? 100)
      json(res, 200, { name, entries: await tailLedger(logDir, name, Number.isFinite(limit) ? limit : 100) })
      return
    }

    if (path === "/api/backlog" && method === "GET") {
      json(res, 200, await backlogSnapshot(directory))
      return
    }

    if (path === "/api/missions" && method === "GET") {
      json(res, 200, await missionsSnapshot(directory))
      return
    }

    // Toggle a mission's enabled state via the restrict-only overlay. CSRF is
    // enforced by the mutation guard above (PUT is non-idempotent).
    if (path === "/api/missions" && method === "PUT") {
      const body = (await readJsonBody(req)) as { id?: unknown; enabled?: unknown }
      const result = await setMissionEnabled(directory, body.id, body.enabled, {
        origin: typeof req.headers.origin === "string" ? req.headers.origin : null,
        ip: req.socket.remoteAddress ?? null,
      })
      json(res, 200, result)
      return
    }

    // --- proxy to opencode serve (chat, SSE, OpenAPI) ---
    if (path === "/api/serve" || path.startsWith("/api/serve/")) {
      const suffix = path.slice("/api/serve".length) + url.search
      const target = await resolveLiveServeUrl()
      if (!target) {
        throw new DashboardError(
          503,
          "serve_unavailable",
          "no live opencode server for this project — start one with scripts/run.sh",
        )
      }
      await proxyServe(req, res, suffix, new URL(target))
      return
    }

    // --- static SPA assets (any non-API GET/HEAD) ---
    if ((method === "GET" || method === "HEAD") && path !== "/api" && !path.startsWith("/api/")) {
      await serveStatic(res, staticDir, path)
      return
    }

    json(res, 404, { error: "not_found", message: `${method} ${path}` })
  }

  function listenOn(requested: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: unknown): void => {
        server.removeListener("listening", onListening)
        reject(err)
      }
      const onListening = (): void => {
        server.removeListener("error", onError)
        const address = server.address()
        resolve(typeof address === "object" && address !== null ? address.port : requested)
      }
      server.once("error", onError)
      server.once("listening", onListening)
      server.listen(requested, host)
    })
  }

  let actualPort: number
  try {
    actualPort = await listenOn(port)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === "EADDRINUSE" && port !== 0 && opts.portFallback !== false) {
      process.stderr.write(`[dashboard] port ${port} is in use; binding an ephemeral port\n`)
      actualPort = await listenOn(0)
    } else {
      throw err
    }
  }
  const urlHost = host.includes(":") ? `[${host}]` : host
  const url = `http://${urlHost}:${actualPort}`

  // Publish the bound URL so launchers/hooks/status resolve a dynamic port.
  // Best effort: a read-only/unwritable state dir must not break the server.
  let dashboardUrlFile: string | null = null
  try {
    dashboardUrlFile = join((await readResolvedPaths(directory)).stateDir, "dashboard-url")
    await atomicWrite(dashboardUrlFile, `${url}\n`)
  } catch {
    dashboardUrlFile = null
  }

  return {
    server,
    host,
    port: actualPort,
    url,
    serveUrl,
    csrf,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err)
            return
          }
          const pointer = dashboardUrlFile
          if (pointer) {
            void readFile(pointer, "utf8")
              .then((current) => (current.trim() === url ? unlink(pointer) : undefined))
              .catch(() => {})
              .finally(() => resolve())
            return
          }
          resolve()
        })
        server.closeAllConnections?.()
      }),
  }
}

// ---------------------------------------------------------------------------
// CLI: `node .opencode/plugin/lib/dashboard-server.ts [project-dir]`

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const directory = process.argv[2] ?? process.cwd()
  // DASHBOARD_STATIC_DIR lets a separately-hosted UI (e.g. the Nibble-Dashboard
  // Angular build) be served from this same origin — same-origin keeps the
  // Host/Origin/CSRF guards intact. Unset → the legacy `<dir>/dashboard/static`.
  const staticDir = process.env.DASHBOARD_STATIC_DIR
  const handle = await createDashboardServer({ directory, ...(staticDir ? { staticDir } : {}) })
  console.log(
    `autonomy-dashboard-api listening on ${handle.url} (proxy -> ${handle.serveUrl || "<auto>"}${staticDir ? `, ui -> ${staticDir}` : ""})`,
  )
  const shutdown = () => {
    void handle.close().then(() => process.exit(0))
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}
