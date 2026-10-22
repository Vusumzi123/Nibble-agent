// Integration tests for the dashboard HTTP server (kanban card 8 — plan §9.2):
// request guards (Host/Origin/CSRF), config API refusals, hot-config reads,
// the single-origin streaming proxy, static UI, and ledger endpoints.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse, type Server } from "node:http"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createDashboardServer, type DashboardHandle } from "./dashboard-server.ts"

const CONFIG = `paths:
  vault: Brain
  diagrams: diagrams
  log: .opencode/logs
  state: .opencode/state

autonomy:
  level: 1                     # 0..4 capability dial
  gate_scope: main
  heartbeat:
    frequency: 12h
    in_progress_lock: true

mood:
  dispatch_influence: true
  decay_half_life: 6h

comms:
  default_channel: telegram
  session_ttl: 24h
  telegram:
    enabled: false
    bot_token_file: ""
    chat_id_file: ""
  email:
    enabled: false
    account: ""
    reply_window_hours: 48

dashboard:
  bind_address: 127.0.0.1      # loopback only
  auth:
    mode: off
    require_tls: false
`

// --- fake opencode serve ---------------------------------------------------

let upstream: Server
let upstreamSaw: { url?: string; method?: string; cookie?: string; origin?: string; host?: string; body?: string } = {}
let releaseStream: (() => void) | null = null
let streamGate: Promise<void> | null = null

function makeUpstream(): Promise<number> {
  return new Promise((resolve) => {
    upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
        upstreamSaw = { url: req.url, method: req.method, cookie: req.headers.cookie, origin: req.headers.origin, host: req.headers.host }
        if (req.url === "/stream") {
          res.writeHead(200, { "content-type": "text/event-stream" })
          res.write("data: one\n\n")
          streamGate = new Promise((r) => (releaseStream = r))
          void streamGate.then(() => {
            res.write("data: two\n\n")
            res.end()
          })
          return
        }
        const chunks: Buffer[] = []
        req.on("data", (c: Buffer) => chunks.push(c))
        req.on("end", () => {
          upstreamSaw.body = Buffer.concat(chunks).toString("utf8")
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true, url: req.url, body: upstreamSaw.body }))
        })
      },
    )
    upstream.listen(0, "127.0.0.1", () => resolve((upstream.address() as { port: number }).port))
  })
}

// --- harness ----------------------------------------------------------------

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dash-srv-"))
  await mkdir(join(dir, ".opencode"), { recursive: true })
  await writeFile(join(dir, ".opencode", "sysop-config.yaml"), CONFIG, "utf8")
  await mkdir(join(dir, "dashboard", "static"), { recursive: true })
  await writeFile(join(dir, "dashboard", "static", "index.html"), "<!doctype html><title>dash</title>placeholder-ui", "utf8")
  return dir
}

type J = { status: number; body: any; headers: import("node:http").IncomingHttpHeaders }

async function call(
  dash: DashboardHandle,
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<J> {
  const url = new URL(path, dash.url)
  const headers: Record<string, string> = { ...opts.headers }
  let payload: string | undefined
  if (opts.body !== undefined) {
    payload = JSON.stringify(opts.body)
    headers["content-type"] = "application/json"
  }
  const res = await fetch(url, { method, headers, body: payload })
  const text = await res.text()
  let body: any = text
  try {
    body = JSON.parse(text)
  } catch {
    // keep raw
  }
  return { status: res.status, body, headers: res.headers as unknown as import("node:http").IncomingHttpHeaders }
}

async function csrf(dash: DashboardHandle): Promise<string> {
  const res = await call(dash, "GET", "/api/csrf")
  assert.equal(res.status, 200)
  return res.body.token as string
}

// raw request: spoofable Host header and Cookie header (fetch forbids/omits both)
function raw(
  host: string,
  path: string,
  method = "GET",
  extraHeaders: Record<string, string> = {},
  body?: string,
): Promise<J> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: host, ...extraHeaders }
    if (body !== undefined) {
      headers["content-type"] = "application/json"
      headers["content-length"] = String(Buffer.byteLength(body))
    }
    const req = httpRequest(
      { host: "127.0.0.1", port: Number(process.env.__DASH_TEST_PORT), path, method, headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c: Buffer) => chunks.push(c))
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8")
          let parsed: any = text
          try {
            parsed = JSON.parse(text)
          } catch {}
          resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers })
        })
      },
    )
    req.on("error", reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

let dash: DashboardHandle
let dir: string

before(async () => {
  dir = await project()
  const upstreamPort = await makeUpstream()
  dash = await createDashboardServer({
    directory: dir,
    port: 0,
    host: "127.0.0.1",
    serveUrl: `http://127.0.0.1:${upstreamPort}`,
  })
  process.env.__DASH_TEST_PORT = String(dash.port)
})

after(async () => {
  await dash?.close()
  upstream?.close()
  delete process.env.__DASH_TEST_PORT
})

// --- guards -----------------------------------------------------------------

test("health + static UI served on the loopback origin", async () => {
  const health = await call(dash, "GET", "/api/health")
  assert.equal(health.status, 200)
  assert.equal(health.body.ok, true)
  assert.equal(health.body.auth, "csrf")

  const page = await fetch(`${dash.url}/`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /placeholder-ui/)
})

test("spoofed Host header refused (DNS-rebinding defense)", async () => {
  const res = await raw("evil.example.com", "/api/health")
  assert.equal(res.status, 403)
  assert.equal(res.body.error, "host")
})

test("cross-origin mutation refused even with a valid token", async () => {
  const token = await csrf(dash)
  const res = await call(dash, "PUT", "/api/config", {
    body: { section: "mood", values: { decay_half_life: "12h" } },
    headers: { "x-csrf-token": token, origin: "http://evil.example.com" },
  })
  assert.equal(res.status, 403)
  assert.equal(res.body.error, "origin")
})

test("mutation without CSRF token refused; cookie mismatch refused", async () => {
  const bare = await call(dash, "PUT", "/api/config", {
    body: { section: "mood", values: { decay_half_life: "12h" } },
  })
  assert.equal(bare.status, 403)
  assert.equal(bare.body.error, "csrf")

  const token = await csrf(dash)
  const payload = JSON.stringify({ section: "mood", values: { decay_half_life: "12h" } })
  const mismatch = await raw(
    `127.0.0.1:${dash.port}`,
    "/api/config",
    "PUT",
    { "x-csrf-token": token, cookie: `nibble_csrf=${"0".repeat(64)}` },
    payload,
  )
  assert.equal(mismatch.status, 403)
  assert.equal(mismatch.body.error, "csrf")
})

// --- config API ------------------------------------------------------------

test("PUT /api/config: valid dial change lands and is visible to the hot reader", async () => {
  const token = await csrf(dash)
  const res = await call(dash, "PUT", "/api/config", {
    body: { section: "autonomy", values: { "heartbeat.frequency": "30m", gate_scope: "all" } },
    headers: { "x-csrf-token": token },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.applied, { "heartbeat.frequency": "30m", gate_scope: "all" })

  // acceptance: the change is visible on the next read (hot config, no restart)
  const after = await call(dash, "GET", "/api/config")
  assert.equal(after.body.autonomy.heartbeat.frequency, "30m")
  assert.equal(after.body.autonomy.gate_scope, "all")

  // the journal recorded it
  const log = await import("node:fs/promises").then((fs) =>
    fs.readFile(join(dir, ".opencode", "logs", "dashboard.log"), "utf8"),
  )
  const entry = JSON.parse(log.trim().split("\n").pop()!)
  assert.equal(entry.event, "config-write")
  assert.equal(entry.section, "autonomy")
})

test("PUT /api/config: level raise without 2FA refused (Phase-4 acceptance)", async () => {
  const token = await csrf(dash)
  const res = await call(dash, "PUT", "/api/config", {
    body: { section: "autonomy", values: { level: 3 } },
    headers: { "x-csrf-token": token },
  })
  assert.equal(res.status, 403)
  assert.equal(res.body.error, "2fa_required")
  // and the level did not move
  const cfg = await call(dash, "GET", "/api/config")
  assert.equal(cfg.body.autonomy.level, 1)
})

test("PUT /api/config: invalid config refused with detail, file untouched", async () => {
  const token = await csrf(dash)
  const res = await call(dash, "PUT", "/api/config", {
    body: { section: "autonomy", values: { gate_scope: "everywhere" } },
    headers: { "x-csrf-token": token },
  })
  assert.equal(res.status, 400)
  assert.equal(res.body.error, "invalid_value")
  assert.ok(Array.isArray(res.body.detail) && res.body.detail.length > 0)
  const cfg = await call(dash, "GET", "/api/config")
  // the valid `all` from the earlier test stands; the refused write changed nothing
  assert.equal(cfg.body.autonomy.gate_scope, "all")
})

test("PUT /api/config: non-writable section and malformed bodies", async () => {
  const token = await csrf(dash)
  const ro = await call(dash, "PUT", "/api/config", {
    body: { section: "audit", values: { enabled: false } },
    headers: { "x-csrf-token": token },
  })
  assert.equal(ro.status, 403)
  assert.equal(ro.body.error, "section_readonly")

  const bad = await call(dash, "PUT", "/api/config", {
    body: { section: 42 },
    headers: { "x-csrf-token": token },
  })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error, "bad_request")
})

// --- metrics / ledgers / backlog -------------------------------------------

test("metrics + ledger endpoints", async () => {
  const logDir = join(dir, ".opencode", "logs")
  await mkdir(logDir, { recursive: true })
  await writeFile(join(logDir, "audit.log"), '{"cmd":"ls"}\n{"cmd":"pwd"}\n', "utf8")

  const metrics = await call(dash, "GET", "/api/metrics")
  assert.equal(metrics.status, 200)
  assert.equal(metrics.body.config.autonomy.level, 1)
  assert.ok(Array.isArray(metrics.body.ledgers))
  assert.ok(
    metrics.body.ledgers.some((l: { name: string }) => l.name === "audit.log" && l.lines === 2),
  )

  const list = await call(dash, "GET", "/api/ledgers")
  assert.equal(list.status, 200)
  assert.ok(list.body.ledgers.some((l: { name: string }) => l.name === "audit.log"))

  const tail = await call(dash, "GET", "/api/ledgers/audit.log?limit=1")
  assert.equal(tail.status, 200)
  assert.deepEqual(tail.body.entries, [{ cmd: "pwd" }])

  const notALedger = await call(dash, "GET", "/api/ledgers/notes.txt")
  assert.equal(notALedger.status, 400)
  assert.equal(notALedger.body.error, "bad_ledger")

  const backlog = await call(dash, "GET", "/api/backlog")
  assert.equal(backlog.status, 200)
  assert.deepEqual(backlog.body, { total: 0, entries: [] })
})

// --- heartbeat status + static SPA assets (cards 9/16) ----------------------

test("GET /api/heartbeat: idle (no marker) reads cleanly", async () => {
  const hb = await call(dash, "GET", "/api/heartbeat")
  assert.equal(hb.status, 200)
  assert.equal(hb.body.current, null)
  assert.equal(hb.body.lock, false)
})

// --- missions (canvas widget backend) ---------------------------------------

test("GET/PUT /api/missions: list missions and toggle one (CSRF-gated)", async () => {
  const mdir = join(dir, ".opencode", "missions")
  await mkdir(mdir, { recursive: true })
  await writeFile(
    join(mdir, "drain.md"),
    "---\nid: drain\ntitle: Drain the turn buffer\nfrequency: mid\nmenus: [day]\n---\nbody\n",
    "utf8",
  )

  const list = await call(dash, "GET", "/api/missions")
  assert.equal(list.status, 200)
  const drain = list.body.missions.find((m: { id: string }) => m.id === "drain")
  assert.equal(drain.enabled, true)
  assert.equal(drain.file_enabled, true)

  const noCsrf = await call(dash, "PUT", "/api/missions", { body: { id: "drain", enabled: false } })
  assert.equal(noCsrf.status, 403)
  assert.equal(noCsrf.body.error, "csrf")

  const token = await csrf(dash)
  const off = await call(dash, "PUT", "/api/missions", {
    body: { id: "drain", enabled: false },
    headers: { "x-csrf-token": token },
  })
  assert.equal(off.status, 200)
  assert.deepEqual(off.body, { id: "drain", enabled: false })

  const after = await call(dash, "GET", "/api/missions")
  assert.equal(after.body.missions.find((m: { id: string }) => m.id === "drain").enabled, false)

  const missing = await call(dash, "PUT", "/api/missions", {
    body: { id: "nope", enabled: false },
    headers: { "x-csrf-token": token },
  })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error, "no_mission")
})

test("static SPA: hashed assets served with the right type; unknown path falls back to index.html", async () => {
  await writeFile(join(dir, "dashboard", "static", "main-abc.js"), "console.log('ui')", "utf8")

  const asset = await fetch(`${dash.url}/main-abc.js`)
  assert.equal(asset.status, 200)
  assert.match(asset.headers.get("content-type") ?? "", /javascript/)
  assert.match(await asset.text(), /console\.log/)

  // client-side route with no file → SPA fallback to index.html
  const spa = await fetch(`${dash.url}/missions`)
  assert.equal(spa.status, 200)
  assert.match(await spa.text(), /placeholder-ui/)
})

test("static SPA: percent-encoded traversal outside the static root refused", async () => {
  const evil = await raw(`127.0.0.1:${dash.port}`, "/%2e%2e%2f.opencode%2fsysop-config.yaml")
  assert.equal(evil.status, 403)
  assert.equal(evil.body.error, "path")
})

// --- proxy -----------------------------------------------------------------

test("proxy: GET streams through to opencode serve with dashboard headers stripped", async () => {
  const res = await call(dash, "GET", "/api/serve/doc", {
    headers: { cookie: "nibble_csrf=abc", origin: dash.url },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.url, "/doc")
  // dashboard-context headers must not leak upstream
  assert.equal(upstreamSaw.cookie, undefined)
  assert.equal(upstreamSaw.origin, undefined)
  assert.ok(upstreamSaw.host!.includes("127.0.0.1"))
})

test("proxy: POST body forwarded; upstream never sees dashboard cookies", async () => {
  const token = await csrf(dash)
  const payload = JSON.stringify({ title: "hi" })
  const res = await raw(
    `127.0.0.1:${dash.port}`,
    "/api/serve/session",
    "POST",
    { "x-csrf-token": token, cookie: `nibble_csrf=${token}` },
    payload,
  )
  assert.equal(res.status, 200)
  assert.equal(res.body.url, "/session")
  assert.equal(res.body.body, payload)
  assert.equal(upstreamSaw.cookie, undefined)
  assert.equal(upstreamSaw.method, "POST")
})

test("proxy: SSE chunks flush incrementally (chat round-trip path)", async () => {
  const res = await fetch(`${dash.url}/api/serve/stream`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()

  const first = await reader.read()
  assert.equal(decoder.decode(first.value), "data: one\n\n")
  // the first chunk arrived before the upstream finished — no buffering
  assert.ok(releaseStream, "stream should be gated upstream")
  releaseStream!()
  const second = await reader.read()
  assert.equal(decoder.decode(second.value), "data: two\n\n")
  await reader.cancel()
})

test("proxy: unreachable serve answers 502, not a hang", async () => {
  const dead = await createDashboardServer({
    directory: dir,
    port: 0,
    host: "127.0.0.1",
    serveUrl: "http://127.0.0.1:1",
  })
  try {
    const res = await call(dead, "GET", "/api/serve/doc")
    assert.equal(res.status, 502)
    assert.equal(res.body.error, "serve_unreachable")
  } finally {
    await dead.close()
  }
})

// --- startup guard ---------------------------------------------------------

test("createDashboardServer refuses a non-loopback bind while auth is card 11", async () => {
  await assert.rejects(
    () => createDashboardServer({ directory: dir, port: 0, host: "0.0.0.0" }),
    (err: { status?: number; code?: string }) => err.status === 403 && err.code === "bind_requires_auth",
  )
})

// --- port/serve_url precedence (opts > env > config > default) -------------

test("port + serve_url resolve opts > env > dashboard.* config > default", async () => {
  const cfgDir = await project()
  const cfgPath = join(cfgDir, ".opencode", "sysop-config.yaml")
  const cfg = await readFile(cfgPath, "utf8")
  await writeFile(
    cfgPath,
    cfg.replace(
      "dashboard:\n  bind_address: 127.0.0.1      # loopback only",
      // high ports: the config path binds for real, must not collide with a
      // live instance dashboard (4097/4099)
      "dashboard:\n  bind_address: 127.0.0.1      # loopback only\n  port: 44999\n  serve_url: http://127.0.0.1:44998",
    ),
    "utf8",
  )

  // config wins when neither opts nor env are set
  const fromCfg = await createDashboardServer({ directory: cfgDir, host: "127.0.0.1" })
  try {
    assert.equal(fromCfg.port, 44999)
    assert.equal(fromCfg.serveUrl, "http://127.0.0.1:44998")
  } finally {
    await fromCfg.close()
  }

  // env overrides config: DASHBOARD_PORT beats dashboard.port (both bind
  // for real — distinct high ports), OPENCODE_SERVE_URL beats serve_url
  process.env.DASHBOARD_PORT = "44996"
  process.env.OPENCODE_SERVE_URL = "http://127.0.0.1:44995"
  const fromEnv = await createDashboardServer({ directory: cfgDir, host: "127.0.0.1" })
  try {
    assert.equal(fromEnv.port, 44996)
    assert.equal(fromEnv.serveUrl, "http://127.0.0.1:44995")
  } finally {
    await fromEnv.close()
    delete process.env.DASHBOARD_PORT
    delete process.env.OPENCODE_SERVE_URL
  }

  // opts beat env and config
  process.env.DASHBOARD_PORT = "44994"
  process.env.OPENCODE_SERVE_URL = "http://127.0.0.1:44993"
  const fromOpts = await createDashboardServer({
    directory: cfgDir,
    port: 0,
    serveUrl: "http://127.0.0.1:44992",
    host: "127.0.0.1",
  })
  try {
    // port: 0 = ephemeral — proves the opt beat both env (44994) and config (44999)
    assert.ok(fromOpts.port > 0 && fromOpts.port !== 44999 && fromOpts.port !== 44994)
    assert.equal(fromOpts.serveUrl, "http://127.0.0.1:44992")
  } finally {
    await fromOpts.close()
    delete process.env.DASHBOARD_PORT
    delete process.env.OPENCODE_SERVE_URL
  }
})
