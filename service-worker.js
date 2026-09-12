// ViewTube service worker — network-first, cache as offline fallback only.
const CACHE = 'viewtube-v1';
const OFFLINE_ASSETS = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  self.skipWaiting();  // activate immediately, don't wait for old tabs to close
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(OFFLINE_ASSETS).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  // Drop old caches so a new deploy never serves stale files
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // Only handle GET navigations/assets for our own origin. NEVER cache API calls,
  // Firebase, Cloudflare, or anything cross-origin — those must always hit network.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then(res => {
        // Update the cached copy of navigations/static files in the background
        if (res && res.status === 200 && (req.mode === 'navigate' || url.pathname.startsWith('/icons/') || url.pathname === '/' || url.pathname.endsWith('.html') || url.pathname.endsWith('.webmanifest'))) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('/index.html')))
  );
});
