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
// (launcher: scripts/dashboard.sh). Default port 4097 (opencode serve is
// 4096); default proxy target OPENCODE_SERVE_URL or http://127.0.0.1:4096.
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { request as httpsRequest } from "node:https"
import { readFile, stat } from "node:fs/promises"
import { extname, join, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { errText } from "./util.ts"
import { NESTED_WRITABLE_SECTIONS, readDashboardConfig } from "./autonomy.ts"
import { readResolvedPaths } from "./paths.ts"
import {
  DashboardError,
  backlogSnapshot,
  configSnapshot,
  createCsrfStore,
  heartbeatSnapshot,
  isLoopback,
  listLedgers,
  metricsSnapshot,
  missionsSnapshot,
  setMissionEnabled,
  tailLedger,
  writeConfig,
  type CsrfStore,
} from "./dashboard.ts"

const CSRF_HEADER = "x-csrf-token"
const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS"])
const MAX_BODY_BYTES = 1024 * 1024

export type DashboardServerOpts = {
  directory: string
  /** 0 = ephemeral (tests). Default DASHBOARD_PORT env, else 4097. */
  port?: number
  /** Defaults to the `dashboard.bind_address` config value. */
  host?: string
  /** Proxy target for `opencode serve`. Default OPENCODE_SERVE_URL, else 4096. */
  serveUrl?: string
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
  const port = opts.port ?? Number(process.env.DASHBOARD_PORT ?? 4097)
  const serveUrl = opts.serveUrl ?? process.env.OPENCODE_SERVE_URL ?? "http://127.0.0.1:4096"
  const serveBase = new URL(serveUrl)
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
      json(res, 200, {
        ok: true,
        directory,
        serve_url: serveUrl,
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

    if (path === "/api/heartbeat" && method === "GET") {
      json(res, 200, await heartbeatSnapshot(directory))
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
      await proxyServe(req, res, suffix, serveBase)
      return
    }

    // --- static SPA assets (any non-API GET/HEAD) ---
    if ((method === "GET" || method === "HEAD") && path !== "/api" && !path.startsWith("/api/")) {
      await serveStatic(res, staticDir, path)
      return
    }

    json(res, 404, { error: "not_found", message: `${method} ${path}` })
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => {
      server.removeListener("error", reject)
      resolve()
    })
  })
  const addr = server.address()
  const actualPort = typeof addr === "object" && addr !== null ? addr.port : port
  const urlHost = host.includes(":") ? `[${host}]` : host

  return {
    server,
    host,
    port: actualPort,
    url: `http://${urlHost}:${actualPort}`,
    serveUrl,
    csrf,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
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
    `autonomy-dashboard-api listening on ${handle.url} (proxy -> ${handle.serveUrl}${staticDir ? `, ui -> ${staticDir}` : ""})`,
  )
  const shutdown = () => {
    void handle.close().then(() => process.exit(0))
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}
