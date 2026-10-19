// A fake Supabase for the browser tests. Every request the app sends to the
// fake host (https://e2e.supabase.test) is answered here with page.route /
// page.routeWebSocket — nothing leaves the machine, no key or production row
// is involved. It speaks just enough PostgREST, GoTrue, Functions, Storage and
// Realtime for the portal to run:
//   rest/v1/<table>   GET/HEAD with eq/neq/gt/gte/lt/lte/is/in/like/ilike/not
//                     filters, order, limit, count=exact, single(); POST/PATCH/
//                     DELETE mutate a per-test in-memory copy of data.js
//   rest/v1/rpc/<fn>  answered from data.js RPC
//   auth/v1/*         password + refresh token grants, /user, /logout
//   functions/v1/*    { ok: true }
//   storage/v1/*      empty lists / dummy signed URLs
//   realtime          joins acknowledged, heartbeats answered
// Unknown tables/RPCs/functions get 200 + [] (or null) and are marked
// `known: false` in mock.log so a test can list them. Every 4xx/5xx is
// recorded; the shared test fixture fails the test on any it did not expect.
const crypto = require('crypto');
const { seedTables, RPC, AUTH_USERS, PASSWORD } = require('./data');

const SUPABASE_URL = process.env.E2E_SUPABASE_URL || 'https://e2e.supabase.test';
const SUPABASE_HOST = new URL(SUPABASE_URL).host;
const STORAGE_KEY = `sb-${SUPABASE_HOST.split('.')[0]}-auth-token`; // supabase-js v2 default

const KNOWN_FUNCTIONS = new Set([
  'notify-admins-ops', 'notify-admins', 'push-on-allocation', 'portal-assistant',
  'send-client-approval', 'send-signoff-request', 'send-worker-sms', 'send-welcome', 'approve-timesheet',
]);

// ---------- auth ----------------------------------------------------------
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function fakeJwt(u) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated',
    aal: 'aal1', amr: [{ method: 'password', timestamp: now }], session_id: `e2e-${u.id}`,
    iat: now, exp: now + 3600,
  };
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.e2e-not-a-signature`;
}

function authUserObject(u) {
  return {
    id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email,
    email_confirmed_at: '2026-01-01T00:00:00Z', phone: '', confirmed_at: '2026-01-01T00:00:00Z',
    app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {},
    identities: [], factors: [], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  };
}

function sessionFor(kind) {
  const u = AUTH_USERS[kind];
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: fakeJwt(u), token_type: 'bearer', expires_in: 3600, expires_at: now + 3600,
    refresh_token: `e2e-refresh-${kind}`, user: authUserObject(u),
  };
}

function kindByEmail(email) {
  const e = String(email || '').toLowerCase();
  return Object.keys(AUTH_USERS).find(k => AUTH_USERS[k].email === e) || null;
}

function userFromBearer(headers) {
  const h = headers.authorization || '';
  const tok = h.replace(/^Bearer\s+/i, '');
  const parts = tok.split('.');
  if (parts.length !== 3) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const kind = kindByEmail(p.email);
    return kind ? AUTH_USERS[kind] : null;
  } catch { return null; }
}

// ---------- PostgREST -----------------------------------------------------
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);

function likeToRegex(pattern, flags) {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) { i += 1; re += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    else if (ch === '%' || ch === '*') re += '.*';
    else if (ch === '_') re += '.';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, flags);
}

function parseList(v) {
  const inner = v.replace(/^\(/, '').replace(/\)$/, '');
  const out = [];
  let cur = '';
  let q = false;
  for (const ch of inner) {
    if (ch === '"') { q = !q; continue; }
    if (ch === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.length || inner.length) out.push(cur);
  return out;
}

function cmp(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function matches(row, col, expr) {
  let negate = false;
  let e = expr;
  if (e.startsWith('not.')) { negate = true; e = e.slice(4); }
  const dot = e.indexOf('.');
  if (dot < 0) return true;
  const op = e.slice(0, dot);
  const val = e.slice(dot + 1);
  const cell = row[col];
  let r;
  switch (op) {
    case 'eq': r = cell != null && String(cell) === val; break;
    case 'neq': r = cell != null && String(cell) !== val; break;
    case 'gt': r = cell != null && cmp(cell, val) > 0; break;
    case 'gte': r = cell != null && cmp(cell, val) >= 0; break;
    case 'lt': r = cell != null && cmp(cell, val) < 0; break;
    case 'lte': r = cell != null && cmp(cell, val) <= 0; break;
    case 'is': r = val === 'null' ? cell == null : val === 'true' ? cell === true : val === 'false' ? cell === false : true; break;
    case 'in': r = cell != null && parseList(val).includes(String(cell)); break;
    case 'like': r = cell != null && likeToRegex(val, '').test(String(cell)); break;
    case 'ilike': r = cell != null && likeToRegex(val, 'i').test(String(cell)); break;
    default: r = true; // cs, ov, fts… not used by the screens under test
  }
  return negate ? !r : r;
}

function applyQuery(rows, sp) {
  let out = rows.filter(row => {
    for (const [k, v] of sp) {
      if (RESERVED.has(k) || k === 'or' || k === 'and' || k.includes('.')) continue;
      if (!matches(row, k, v)) return false;
    }
    return true;
  });
  const order = sp.get('order');
  if (order) {
    const keys = order.split(',').map(s => {
      const [col, dir, nulls] = s.split('.');
      return { col, desc: dir === 'desc', nullsFirst: nulls === 'nullsfirst' };
    });
    out = [...out].sort((a, b) => {
      for (const k of keys) {
        const av = a[k.col];
        const bv = b[k.col];
        if (av == null && bv == null) continue;
        if (av == null) return k.nullsFirst ? -1 : 1;
        if (bv == null) return k.nullsFirst ? 1 : -1;
        const c = cmp(av, bv);
        if (c) return k.desc ? -c : c;
      }
      return 0;
    });
  }
  const offset = Number(sp.get('offset') || 0);
  const limit = sp.get('limit') != null ? Number(sp.get('limit')) : null;
  return limit != null ? out.slice(offset, offset + limit) : out.slice(offset);
}

// ---------- the mock ------------------------------------------------------
async function installSupabaseMock(page, context) {
  const db = seedTables();
  const log = [];
  const allowedErrors = [];   // [{ path: RegExp, status }]
  let offline = false;

  const corsHeaders = (req) => ({
    'access-control-allow-origin': req.headers().origin || '*',
    'access-control-allow-credentials': 'true',
    'access-control-expose-headers': 'content-range, content-profile, x-supabase-api-version',
    vary: 'Origin',
  });

  function record(req, url, status, known, kind, body) {
    let parsed = null;
    try { parsed = req.postData() ? JSON.parse(req.postData()) : null; } catch { parsed = req.postData(); }
    log.push({
      method: req.method(), path: decodeURIComponent(url.pathname + url.search), status, known, kind,
      body: parsed, response: body === undefined ? undefined : body,
    });
  }

  async function reply(route, req, url, { status = 200, json, text, headers = {}, known = true, kind }) {
    const body = json !== undefined ? JSON.stringify(json) : (text || '');
    record(req, url, status, known, kind, json);
    await route.fulfill({
      status,
      headers: { ...corsHeaders(req), 'content-type': 'application/json; charset=utf-8', ...headers },
      body: req.method() === 'HEAD' ? '' : body,
    });
  }

  function ctxFor(req) {
    const user = userFromBearer(req.headers());
    const worker = user ? db.workers.find(w => (w.email || '').toLowerCase() === user.email) : null;
    return { user, worker, db };
  }

  async function handleAuth(route, req, url) {
    const p = url.pathname.replace(/^\/auth\/v1/, '');
    const body = (() => { try { return JSON.parse(req.postData() || '{}'); } catch { return {}; } })();
    if (p === '/token') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password') {
        const kind = kindByEmail(body.email);
        if (kind && body.password === PASSWORD) return reply(route, req, url, { json: sessionFor(kind), kind: 'auth' });
        return reply(route, req, url, {
          status: 400, kind: 'auth',
          json: { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' },
        });
      }
      if (grant === 'refresh_token') {
        const kind = String(body.refresh_token || '').replace(/^e2e-refresh-/, '');
        if (AUTH_USERS[kind]) return reply(route, req, url, { json: sessionFor(kind), kind: 'auth' });
        return reply(route, req, url, { status: 400, kind: 'auth', json: { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' } });
      }
    }
    if (p === '/user') {
      const u = userFromBearer(req.headers());
      if (!u) return reply(route, req, url, { status: 401, kind: 'auth', json: { code: 401, msg: 'no session' } });
      return reply(route, req, url, { json: authUserObject(u), kind: 'auth' });
    }
    if (p === '/logout') return reply(route, req, url, { status: 204, text: '', kind: 'auth' });
    if (p === '/recover') return reply(route, req, url, { json: {}, kind: 'auth' });
    return reply(route, req, url, { json: {}, known: false, kind: 'auth' });
  }

  async function handleRest(route, req, url) {
    const name = url.pathname.replace(/^\/rest\/v1\//, '');
    const ctx = ctxFor(req);
    const headers = req.headers();
    const wantsObject = /vnd\.pgrst\.object/.test(headers.accept || '');
    const prefer = headers.prefer || '';
    const body = (() => { try { return JSON.parse(req.postData() || 'null'); } catch { return null; } })();

    if (name.startsWith('rpc/')) {
      const fn = name.slice(4);
      const args = body || Object.fromEntries(url.searchParams);
      if (RPC[fn]) return reply(route, req, url, { json: RPC[fn](args, ctx), kind: 'rpc' });
      return reply(route, req, url, { json: null, known: false, kind: 'rpc' });
    }

    const table = name;
    const known = Object.prototype.hasOwnProperty.call(db, table);
    if (!known) db[table] = [];
    const rows = db[table];
    const method = req.method();

    if (method === 'GET' || method === 'HEAD') {
      const out = applyQuery(rows, url.searchParams);
      const all = applyQuery(rows, new URLSearchParams([...url.searchParams].filter(([k]) => k !== 'limit' && k !== 'offset')));
      const range = all.length ? `0-${out.length - 1}/${all.length}` : '*/0';
      const extra = { 'content-range': /count=/.test(prefer) ? range : range.replace(/\/\d+$/, '/*') };
      if (wantsObject) {
        if (out.length !== 1) {
          return reply(route, req, url, {
            status: 406, known, kind: 'rest', headers: extra,
            json: { code: 'PGRST116', details: `The result contains ${out.length} rows`, hint: null, message: 'JSON object requested, multiple (or no) rows returned' },
          });
        }
        return reply(route, req, url, { json: out[0], known, kind: 'rest', headers: extra });
      }
      return reply(route, req, url, { json: out, known, kind: 'rest', headers: extra });
    }

    const representation = /return=representation/.test(prefer);
    if (method === 'POST') {
      const list = (Array.isArray(body) ? body : [body]).filter(Boolean)
        .map(r => ({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r }));
      rows.push(...list);
      if (!representation) return reply(route, req, url, { status: 201, text: '', known, kind: 'rest' });
      return reply(route, req, url, { status: 201, json: wantsObject ? list[0] : list, known, kind: 'rest' });
    }
    if (method === 'PATCH') {
      const hit = applyQuery(rows, url.searchParams);
      hit.forEach(r => Object.assign(r, body || {}));
      if (!representation) return reply(route, req, url, { status: 204, text: '', known, kind: 'rest' });
      return reply(route, req, url, { json: wantsObject ? hit[0] || null : hit, known, kind: 'rest' });
    }
    if (method === 'DELETE') {
      const hit = new Set(applyQuery(rows, url.searchParams));
      db[table] = rows.filter(r => !hit.has(r));
      return reply(route, req, url, { status: 204, text: '', known, kind: 'rest' });
    }
    return reply(route, req, url, { json: [], known: false, kind: 'rest' });
  }

  async function handleSupabase(route) {
    const req = route.request();
    const url = new URL(req.url());
    if (offline) {
      record(req, url, 0, true, 'offline');
      return route.abort('internetdisconnected');
    }
    if (req.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          ...corsHeaders(req),
          'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,HEAD,OPTIONS',
          'access-control-allow-headers': req.headers()['access-control-request-headers'] || '*',
          'access-control-max-age': '600',
        },
        body: '',
      });
    }
    const p = url.pathname;
    if (p.startsWith('/auth/v1/')) return handleAuth(route, req, url);
    if (p.startsWith('/rest/v1/')) return handleRest(route, req, url);
    if (p.startsWith('/functions/v1/')) {
      const slug = p.replace(/^\/functions\/v1\//, '');
      const json = slug === 'portal-assistant' ? { ok: true, reply: 'Test reply.' } : { ok: true };
      return reply(route, req, url, { json, known: KNOWN_FUNCTIONS.has(slug), kind: 'functions' });
    }
    if (p.startsWith('/storage/v1/')) {
      if (/\/object\/list\//.test(p)) return reply(route, req, url, { json: [], kind: 'storage' });
      if (/\/object\/sign\//.test(p)) return reply(route, req, url, { json: { signedURL: '/e2e-signed-url', signedUrls: [] }, kind: 'storage' });
      return reply(route, req, url, { json: {}, kind: 'storage' });
    }
    return reply(route, req, url, { json: [], known: false, kind: 'other' });
  }

  await page.route(url => url.host === SUPABASE_HOST, handleSupabase);

  // Lets a test swallow the browser's `online` event (iOS often never fires it
  // after a tunnel). Registered before any app script so it runs first.
  await page.addInitScript(() => {
    window.__e2eSwallowOnline = false;
    window.addEventListener('online', (e) => { if (window.__e2eSwallowOnline) e.stopImmediatePropagation(); }, true);
  });

  // Anything else off-box (Google Fonts) is answered locally so the tests
  // never depend on the internet. The app's own origin passes through.
  await page.route(url => url.host !== SUPABASE_HOST && !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(url.host), async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    record(req, url, 200, true, 'external');
    const css = req.resourceType() === 'stylesheet' || /fonts\.googleapis\.com/.test(url.host);
    await route.fulfill({
      status: 200,
      headers: { 'content-type': css ? 'text/css' : 'text/plain', 'access-control-allow-origin': '*' },
      body: '',
    });
  });

  // Realtime: acknowledge joins (echoing the postgres_changes bindings with ids,
  // as the server does) and heartbeats. Handles the v1 object and v2 array
  // message shapes.
  await page.routeWebSocket(url => url.host === SUPABASE_HOST, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== 'string') return;
      let msg;
      try { msg = JSON.parse(message); } catch { return; }
      const isArray = Array.isArray(msg);
      const [joinRef, ref, topic, event, payload] = isArray
        ? msg
        : [msg.join_ref, msg.ref, msg.topic, msg.event, msg.payload];
      if (!['phx_join', 'heartbeat', 'phx_leave', 'access_token'].includes(event)) return;
      let response = {};
      if (event === 'phx_join') {
        const pcs = payload?.config?.postgres_changes || [];
        response = { postgres_changes: pcs.map((c, i) => ({ ...c, id: i + 1 })) };
      }
      const out = { status: 'ok', response };
      ws.send(JSON.stringify(isArray
        ? [joinRef, ref, topic, 'phx_reply', out]
        : { topic, event: 'phx_reply', payload: out, ref, join_ref: joinRef }));
    });
  });

  const mock = {
    db,
    log,
    storageKey: STORAGE_KEY,
    session: sessionFor,
    // Signed-in start: write the session supabase-js persists, before any page script runs.
    async seedSession(kind) {
      await page.addInitScript(({ key, session }) => {
        try { window.localStorage.setItem(key, JSON.stringify(session)); } catch { /* storage blocked */ }
      }, { key: STORAGE_KEY, session: sessionFor(kind) });
    },
    calls(pathPart, method) {
      return log.filter(e => e.path.includes(pathPart) && (!method || e.method === method));
    },
    allowError(pathRe, status) { allowedErrors.push({ pathRe, status }); },
    unexpectedErrors() {
      return log.filter(e => e.status >= 400
        && !allowedErrors.some(a => a.pathRe.test(e.path) && (a.status == null || a.status === e.status)))
        .map(e => `${e.method} ${e.path} -> ${e.status}`);
    },
    unknownRoutes() {
      return [...new Set(log.filter(e => e.known === false).map(e => `${e.method} ${e.path.split('?')[0]}`))];
    },
    async setOffline(value) {
      offline = !!value;
      await context.setOffline(!!value);
    },
    async swallowOnlineEvent(value = true) {
      await page.evaluate(v => { window.__e2eSwallowOnline = v; }, !!value);
    },
  };
  return mock;
}

module.exports = { installSupabaseMock, SUPABASE_URL, STORAGE_KEY };
