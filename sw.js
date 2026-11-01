/*
 * sotto voce — sw.js
 * ⛔ BUMP CACHE ON EVERY DEPLOY. A cache-first SW with an unchanged name serves
 * the old app forever and she concludes nothing shipped.
 *
 * ⚠️ Only same-origin GETs are handled. The Google Identity Services script comes
 * from accounts.google.com — never intercept or cache it, or silent re-auth breaks.
 */
const CACHE = 'sotto-voce-v5';
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

  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return r;
    }).catch(() => caches.match('./index.html')))
  );
});
