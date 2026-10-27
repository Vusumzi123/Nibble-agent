// Dev-server proxy: points /api at the v2 dashboard backend.
//
//   1. DASHBOARD_BACKEND_URL / DASHBOARD_URL (e.g. a remote or alternate port)
//   2. http://127.0.0.1:4097 (server/index.mjs default)
//
// The target is resolved per request so restarting the backend on another
// port with the env var is enough; the env is read at process start.

const FALLBACK = 'http://127.0.0.1:4097';

function backendUrl() {
  const env = process.env['DASHBOARD_BACKEND_URL'] || process.env['DASHBOARD_URL'];
  return (env || FALLBACK).replace(/\/+$/, '');
}

const target = backendUrl();
console.log(`[proxy] /api -> ${target}`);

module.exports = {
  '/api': {
    target,
    router: () => backendUrl(),
    secure: false,
    changeOrigin: false,
    ws: true,
    logLevel: 'warn',
  },
};
