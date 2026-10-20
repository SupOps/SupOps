/*
 * SupOps service worker.
 *
 * Deliberately small. It makes the app installable and quick to open, and nothing
 * more: live data is never cached. /api and /socket.io always go to the network,
 * so an approval card, a run's status or a health state can never be served stale.
 *
 * - Built assets (/assets/*, content-hashed) are cache-first: a hash change is a
 *   new URL, so a cached copy is always correct.
 * - Page loads are network-first, falling back to the cached app shell when the
 *   server is unreachable, so the window still opens and says it is offline.
 */
const VERSION = 'supops-v2';
const SHELL = ['/', '/pwa-launch.js', '/manifest.webmanifest', '/brand-mark.png', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/socket.io')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          if (res.ok) caches.open(VERSION).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/') || SHELL.includes(url.pathname)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(VERSION).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});
