/*
 * sotto voce — sw.js
 *
 * ⭐ NETWORK-FIRST for same-origin files, with the cache as the OFFLINE fallback
 * only. It used to be cache-first, which meant a new deploy needed TWO launches
 * to appear: the first one installed the new worker, the second one ran it. That
 * is why a version number in the header could not do its job — the thing that
 * tells you whether the refresh happened was itself hidden by the stale cache
 * (2026-11-01).
 *
 * These are a handful of small local files. Fetching them fresh over the network
 * costs milliseconds; serving a stale build costs a confusing afternoon. Offline
 * still works — a failed fetch falls back to the cache, then to index.html.
 *
 * ⚠️ Only same-origin GETs are handled. The Google Identity Services script comes
 * from accounts.google.com — never intercept or cache it, or silent re-auth breaks.
 */
const CACHE = 'sotto-voce-v9';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './db.js',
  './drive.js',
  './sync.js',
  './version.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never touch Google's origin

  // version.json is network-first so a deploy is always detectable
  if (url.pathname.endsWith('version.json')) {
    e.respondWith(
      fetch(req).then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return r;
      }).catch(() => caches.match(req))
    );
    return;
  }

  /* ⭐ NETWORK-FIRST, AND BYPASS THE BROWSER'S HTTP CACHE.
     GitHub Pages serves assets with `Cache-Control: max-age=600`, so a plain
     fetch() can return a ten-minute-old file even though the service worker
     itself is fresh. That is why a deploy could be live on the server and
     invisible on the phone — the version number in the header included
     (2026-11-01). `cache: 'no-store'` forces the real network.
     Offline ⇒ cache, then index.html so the app still opens with no signal. */
  e.respondWith(
    fetch(req, { cache: 'no-store' }).then(r => {
      if (r && r.ok) {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return r;
    }).catch(() =>
      caches.match(req).then(hit => hit || caches.match('./index.html'))
    )
  );
});
