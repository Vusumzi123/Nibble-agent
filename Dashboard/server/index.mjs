// Nibble Dashboard v2 backend — thin read/write API over the live agent
// harness. Serves the built Angular app and proxies the opencode serve API.
//
//   node --no-warnings server/index.mjs
//
// Env: KAEL_DIR (default: repo root), DASHBOARD_PORT (4097), DASHBOARD_HOST
// (127.0.0.1), DASHBOARD_DB (opencode.db), DASHBOARD_DIST.

import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  activityReport,
  costReport,
  errorReport,
  healthInfo,
  loadPaths,
  listLedgers,
  overview,
  queueWaitReport,
  readBacklog,
  readDrain,
  readHeartbeat,
  readIdea,
  readLocks,
  readMood,
  readQueue,
  readRunDetail,
  readRuns,
  readSleep,
  readState,
  sessionsSince,
  tailLedger,
  throughputReport,
  tokenSeries,
} from './data.mjs';
import {
  applySettings,
  readConfig,
  readMissions,
  settingsResponse,
  updateMission,
} from './settings.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DIR = resolve(process.env['KAEL_DIR'] || join(HERE, '..', '..'));
const CONFIG_PORT = (() => {
  try {
    const port = readConfig(DIR).data?.dashboard?.port;
    return typeof port === 'number' ? port : null;
  } catch {
    return null;
  }
})();
const PORT = Number(process.env['DASHBOARD_PORT'] || (CONFIG_PORT ?? 4097));
const HOST = process.env['DASHBOARD_HOST'] || '127.0.0.1';
const DIST = resolve(process.env['DASHBOARD_DIST'] || join(HERE, '..', 'dist'));

const TOKEN = randomBytes(24).toString('hex');
const STARTED = Date.now();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

const error = (res, status, code, message) => json(res, status, { error: code, message });

function ctx() {
  const config = readConfig(DIR);
  const paths = loadPaths(DIR);
  const state = readState(paths);
  const missions = readMissions(DIR);
  return { config, paths, state, missions, now: Date.now() };
}

function loopbackHost(req) {
  const raw = String(req.headers.host || '').toLowerCase();
  if (!raw) return true;
  const host = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0];
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function guardMutation(req) {
  if (!loopbackHost(req)) return 'loopback only';
  if (req.headers['x-csrf-token'] !== TOKEN) return 'missing or invalid CSRF token';
  const origin = req.headers.origin;
  if (origin) {
    try {
      const url = new URL(origin);
      if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) return 'origin not allowed';
    } catch {
      return 'invalid origin';
    }
  }
  return null;
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_048_576) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function staticFile(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = normalize(join(DIST, rel));
  if (!file.startsWith(DIST + sep) && file !== join(DIST, 'index.html')) return false;
  if (!existsSync(file) || !statSync(file).isFile()) {
    const index = join(DIST, 'index.html');
    if (!existsSync(index)) return false;
    return sendFile(res, index, true);
  }
  return sendFile(res, file, false);
}

function sendFile(res, file, fallback) {
  const ext = extname(file);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': fallback ? 'no-store' : ext === '.html' ? 'no-store' : 'public, max-age=3600',
  });
  createReadStream(file).pipe(res);
  return true;
}

function serveUrlFrom(state, config) {
  const direct = (state.serveUrl || '').trim();
  if (direct) return direct;
  const cfg = config?.data?.dashboard?.serve_url;
  if (typeof cfg === 'string' && cfg.trim()) return cfg.trim();
  const runtime = state.runtime?.opencode?.url;
  if (typeof runtime === 'string' && runtime.trim()) return runtime.trim();
  return null;
}

let probe = { url: null, ok: null, at: 0 };

async function probeServe(url) {
  if (!url) return null;
  if (probe.url === url && Date.now() - probe.at < 5000) return probe.ok;
  let ok = false;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 900);
    const res = await fetch(url, { method: 'HEAD', signal: ctl.signal }).catch(() =>
      fetch(url, { method: 'GET', signal: ctl.signal }),
    );
    ok = Boolean(res);
    clearTimeout(timer);
  } catch {
    ok = false;
  }
  probe = { url, ok, at: Date.now() };
  return ok;
}

function proxyServe(req, res, suffix) {
  const { state, config } = ctx();
  const target = serveUrlFrom(state, config);
  if (!target) return error(res, 503, 'serve_unavailable', 'opencode serve URL is not known yet');
  let base;
  try {
    base = new URL(target);
  } catch {
    return error(res, 503, 'serve_unavailable', 'invalid serve URL');
  }
  const send = base.protocol === 'https:' ? httpsRequest : httpRequest;
  const path = `${base.pathname.replace(/\/$/, '')}${suffix || '/'}`;
  const headers = { ...req.headers, host: base.host };
  delete headers['x-csrf-token'];
  const upstream = send(
    {
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port,
      method: req.method,
      path,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.setTimeout(30_000, () => upstream.destroy(new Error('serve timeout')));
  upstream.on('error', () => {
    if (!res.headersSent) error(res, 502, 'serve_unreachable', 'opencode serve is unreachable');
    else res.destroy();
  });
  req.pipe(upstream);
}

const routes = {
  'GET /api/health': async (req, res) => {
    const c = ctx();
    const health = healthInfo(DIR, c.state, c.paths);
    health.serve_url = serveUrlFrom(c.state, c.config);
    health.serve_ok = await probeServe(health.serve_url);
    health.uptime_ms = Date.now() - STARTED;
    health.now = new Date().toISOString();
    json(res, 200, health);
  },

  'GET /api/overview': async (req, res) => {
    const c = ctx();
    json(res, 200, overview(DIR, c.paths, c.state));
  },

  'GET /api/heartbeat': async (req, res) => {
    const c = ctx();
    json(res, 200, readHeartbeat(DIR, c.state));
  },

  'GET /api/mood': async (req, res) => {
    const c = ctx();
    json(res, 200, readMood(c.paths));
  },

  'GET /api/sleep': async (req, res) => {
    const c = ctx();
    json(res, 200, readSleep(DIR, c.paths));
  },

  'GET /api/idea': async (req, res) => {
    const c = ctx();
    json(res, 200, readIdea(c.paths));
  },

  'GET /api/queues': async (req, res) => {
    const c = ctx();
    const queue = readQueue(c.paths, c.missions);
    json(res, 200, {
      ts: new Date().toISOString(),
      items: queue.items,
      counts: queue.counts,
      total: queue.total,
      due: queue.due,
      oldest_ms: queue.oldest_ms,
      scheduler: queue.scheduler,
      running: readHeartbeat(DIR, c.state).current,
      drain: readDrain(DIR, c.paths, c.state),
      available: true,
    });
  },

  'GET /api/drain': async (req, res) => {
    const c = ctx();
    json(res, 200, readDrain(DIR, c.paths, c.state));
  },

  'GET /api/runs': async (req, res, url) => {
    const c = ctx();
    json(res, 200, readRuns(DIR, c.paths, {
      limit: url.searchParams.get('limit'),
      mission: url.searchParams.get('mission'),
      kind: url.searchParams.get('kind'),
      outcome: url.searchParams.get('outcome'),
      hours: url.searchParams.get('hours'),
    }));
  },

  'GET /api/runs/detail': async (req, res, url) => {
    const c = ctx();
    json(res, 200, readRunDetail(DIR, c.paths, {
      session: url.searchParams.get('session'),
      tick: url.searchParams.get('tick'),
      mission: url.searchParams.get('mission'),
    }));
  },

  'GET /api/metrics/tokens': async (req, res, url) => {
    const c = ctx();
    const hours = Math.min(24 * 30, Math.max(1, Number(url.searchParams.get('hours')) || 24));
    const bucket = ['tick', 'hour', 'day'].includes(url.searchParams.get('bucket') || '')
      ? url.searchParams.get('bucket')
      : 'hour';
    json(res, 200, tokenSeries(DIR, c.paths, hours, bucket));
  },

  'GET /api/metrics/cost': async (req, res, url) => {
    const c = ctx();
    const hours = Math.min(24 * 30, Math.max(1, Number(url.searchParams.get('hours')) || 24));
    json(res, 200, costReport(DIR, c.paths, hours));
  },

  'GET /api/metrics/errors': async (req, res, url) => {
    const c = ctx();
    const hours = Math.min(24 * 30, Math.max(1, Number(url.searchParams.get('hours')) || 24));
    json(res, 200, errorReport(DIR, c.paths, hours));
  },

  'GET /api/metrics/throughput': async (req, res, url) => {
    const c = ctx();
    const hours = Math.min(24 * 30, Math.max(1, Number(url.searchParams.get('hours')) || 24));
    json(res, 200, throughputReport(DIR, c.paths, hours));
  },

  'GET /api/metrics/queue-wait': async (req, res) => {
    const c = ctx();
    json(res, 200, queueWaitReport(c.paths, c.missions));
  },

  'GET /api/models': async (req, res, url) => {
    const c = ctx();
    const hours = Math.min(24 * 30, Math.max(1, Number(url.searchParams.get('hours')) || 24));
    const report = costReport(DIR, c.paths, hours);
    json(res, 200, { ts: report.ts, hours, models: report.models, total: report.total, sessions: report.sessions });
  },

  'GET /api/activity': async (req, res, url) => {
    const c = ctx();
    const hours = Math.min(24 * 7, Math.max(1, Number(url.searchParams.get('hours')) || 6));
    json(res, 200, activityReport(c.paths, hours));
  },

  'GET /api/settings': async (req, res) => {
    json(res, 200, settingsResponse(DIR));
  },

  'PUT /api/settings': async (req, res) => {
    const guard = guardMutation(req);
    if (guard) return error(res, 403, 'forbidden', guard);
    const payload = await body(req);
    const result = applySettings(DIR, payload?.updates ?? []);
    if (!result.ok) return error(res, result.status, 'settings_rejected', result.error);
    json(res, 200, { ok: true, applied: result.applied, settings: settingsResponse(DIR) });
  },

  'GET /api/config': async (req, res) => {
    const c = ctx();
    json(res, 200, { file: c.config.file, config: c.config.data });
  },

  'GET /api/missions': async (req, res) => {
    const c = ctx();
    json(res, 200, { file: c.config.file, missions: c.missions });
  },

  'PUT /api/missions': async (req, res) => {
    const guard = guardMutation(req);
    if (guard) return error(res, 403, 'forbidden', guard);
    const payload = await body(req);
    const result = updateMission(DIR, payload);
    if (!result.ok) return error(res, result.status, 'mission_rejected', result.error);
    json(res, 200, { ok: true, mission: result.mission, missions: readMissions(DIR) });
  },

  'GET /api/backlog': async (req, res, url) => {
    const c = ctx();
    json(res, 200, readBacklog(DIR, c.paths, Math.min(500, Number(url.searchParams.get('limit')) || 100)));
  },

  'GET /api/ledgers': async (req, res) => {
    const c = ctx();
    json(res, 200, { ledgers: listLedgers(c.paths) });
  },

  'GET /api/locks': async (req, res) => {
    const c = ctx();
    json(res, 200, { ts: new Date().toISOString(), locks: readLocks(c.paths) });
  },

  'GET /api/sessions': async (req, res, url) => {
    const hours = Math.min(24 * 30, Math.max(1, Number(url.searchParams.get('hours')) || 24));
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
    json(res, 200, {
      ts: new Date().toISOString(),
      hours,
      sessions: sessionsSince(DIR, Date.now() - hours * 3_600_000, limit),
    });
  },

  'GET /api/csrf': async (req, res) => {
    res.setHeader('set-cookie', `nibble_csrf=${TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
    json(res, 200, { token: TOKEN });
  },

  'GET /api/meta': async (req, res) => {
    json(res, 200, {
      directory: DIR,
      dist: DIST,
      port: PORT,
      started: new Date(STARTED).toISOString(),
      node: process.version,
      ui: existsSync(join(DIST, 'index.html')),
      csrf: true,
    });
  },
};

const server = createServer(async (req, res) => {
  try {
    if (!loopbackHost(req)) return error(res, 403, 'forbidden', 'loopback hosts only');

    const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
    const pathname = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': req.headers.origin ?? '',
        'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, x-csrf-token',
      });
      return res.end();
    }

    if (pathname === '/api/serve' || pathname.startsWith('/api/serve/')) {
      return proxyServe(req, res, pathname.slice('/api/serve'.length) + url.search);
    }

    if (pathname.startsWith('/api/ledgers/')) {
      const name = decodeURIComponent(pathname.slice('/api/ledgers/'.length));
      const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      const c = ctx();
      return json(res, 200, tailLedger(c.paths, name, limit));
    }

    const key = `${req.method} ${pathname}`;
    const handler = routes[key];
    if (handler) return await handler(req, res, url);

    if (pathname.startsWith('/api/')) return error(res, 404, 'not_found', `no route for ${key}`);

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (staticFile(res, pathname)) return;
      return error(res, 404, 'not_found', 'static asset not found');
    }

    return error(res, 405, 'method_not_allowed', 'unsupported method');
  } catch (err) {
    if (!res.headersSent) {
      error(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
    } else {
      res.destroy();
    }
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`[dashboard] ${url} · dir=${DIR} · dist=${existsSync(join(DIST, 'index.html')) ? 'yes' : 'missing'}`);
  console.log(`[dashboard] opencode serve → ${serveUrlFrom(readState(loadPaths(DIR)), readConfig(DIR)) ?? 'unknown'}`);
});
