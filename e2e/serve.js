// Tiny static server for the browser tests: serves the e2e build (build-e2e/,
// made by `npm run e2e:build`) with an SPA fallback to index.html, and sends
// the SAME security headers production gets from vercel.json — so a test page
// runs under the real Content-Security-Policy (an inline <script>, eval or an
// onclick= attribute breaks the test exactly as it would break the live site).
//
// Two CSP edits, both test-only: the fake Supabase host is added to
// connect-src (the tests answer it with page.route), and upgrade-insecure-
// requests / HSTS are dropped because this server is plain http on localhost.
//
// Usage: node e2e/serve.js            (port 4173, or E2E_PORT)
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', process.env.E2E_BUILD_DIR || 'build-e2e');
const PORT = Number(process.env.E2E_PORT || 4173);
const FAKE_SUPABASE = process.env.E2E_SUPABASE_URL || 'https://e2e.supabase.test';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

function productionHeaders() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'vercel.json'), 'utf8'));
    const rule = (cfg.headers || []).find(h => h.source === '/(.*)');
    const out = {};
    for (const { key, value } of (rule && rule.headers) || []) out[key] = value;
    return out;
  } catch {
    return {};
  }
}

function testHeaders() {
  const h = productionHeaders();
  delete h['Strict-Transport-Security'];
  const csp = h['Content-Security-Policy'];
  if (csp) {
    const host = new URL(FAKE_SUPABASE).host;
    h['Content-Security-Policy'] = csp
      .split(';')
      .map(d => d.trim())
      .filter(d => d && d !== 'upgrade-insecure-requests')
      .map(d => (d.startsWith('connect-src ') ? `${d} https://${host} wss://${host}` : d))
      .join('; ');
  }
  return h;
}

const HEADERS = testHeaders();

function send(res, status, body, type) {
  res.writeHead(status, { ...HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { urlPath = '/'; }
  const file = path.resolve(ROOT, '.' + urlPath);
  if (!file.startsWith(ROOT)) { send(res, 403, 'forbidden', 'text/plain'); return; }
  fs.stat(file, (err, st) => {
    if (!err && st.isFile()) {
      fs.readFile(file, (e2, buf) => {
        if (e2) { send(res, 500, 'read error', 'text/plain'); return; }
        send(res, 200, buf, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
      });
      return;
    }
    // Missing asset with an extension → 404; anything else is an app route.
    if (path.extname(urlPath)) { send(res, 404, 'not found', 'text/plain'); return; }
    fs.readFile(path.join(ROOT, 'index.html'), (e3, buf) => {
      if (e3) { send(res, 500, `No build at ${ROOT} - run "npm run e2e:build" first.`, 'text/plain'); return; }
      send(res, 200, buf, TYPES['.html']);
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`e2e static server on http://127.0.0.1:${PORT} serving ${ROOT}`);
});
