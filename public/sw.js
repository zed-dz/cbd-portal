/* Minimal app-shell service worker: makes the portal installable and instant on
 * repeat opens. Static build assets are served cache-first (they're content-
 * hashed so stale files are impossible); navigations are network-first with a
 * cached fallback so the shell still opens on flaky site connections.
 * Supabase (API/auth/functions) traffic is NEVER intercepted or cached. */
const CACHE = 'portal-shell-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Web push ──────────────────────────────────────────────────────────────
// Payload (JSON, encrypted end-to-end by the send-push function):
//   { title, body, url?, tag? }  — url is opened (or focused) on tap.
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data ? e.data.text() : '' }; }
  const title = data.title || 'Portal';
  const opts = {
    body: data.body || '',
    icon: '/logo192.png',
    badge: '/logo192.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { url: data.url || '/' },
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.startsWith(self.location.origin) && 'focus' in c) {
          if ('navigate' in c && c.url !== target) c.navigate(target).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // App navigation: network first, fall back to the cached shell when offline.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Hashed static assets: cache first.
  if (url.pathname.startsWith('/static/') || /\.(png|ico|svg|woff2?)$/.test(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      }))
    );
  }
});
