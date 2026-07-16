/* Quantora caches the application shell only. Authentication and cloud data
   are intentionally never stored by this worker. */
// Bump this whenever the application shell changes so an older offline page
// cannot mask a newly deployed UI after the worker activates.
const CACHE_NAME = 'quantora-shell-v15';

self.addEventListener('install', event => {
  // Do not precache the entire application. Installation races the page's
  // own lazy loader and previously duplicated every startup asset request.
  // Runtime caching below still gives visited assets an offline fallback.
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
  )));
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith((async () => {
    const isShellAsset = url.pathname === '/' || url.pathname === '/app.webmanifest' || url.pathname.startsWith('/assets/');
    try {
      const response = await fetch(event.request);
      // Shell code must be fresh after a deployment. The cache is retained
      // only as an offline fallback, so a new boot fix cannot be hidden by a
      // previous worker's cached JavaScript.
      if (isShellAsset && response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(event.request, response.clone());
      }
      return response;
    } catch (_) {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      if (url.origin === self.location.origin) return (await caches.match('/'));
      throw _;
    }
  })());
});
