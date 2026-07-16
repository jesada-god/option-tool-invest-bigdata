/* Quantora caches the application shell only. Authentication and cloud data
   are intentionally never stored by this worker. */
// Bump this whenever the application shell changes so an older offline page
// cannot mask a newly deployed UI after the worker activates.
const CACHE_NAME = 'quantora-shell-v7';
const SHELL = [
  '/', '/app.webmanifest', '/assets/app-shell.js',
  '/assets/vendor/lightweight-charts.standalone.production.js',
  '/assets/utils/load-classic.js',
  '/assets/components/indicators.js',
  '/assets/api/resilience.js', '/assets/api/cache.js', '/assets/api/auth.js',
  '/assets/state/store.js', '/assets/state/app.js', '/assets/state/auth.js',
  '/assets/state/session.js', '/assets/state/market.js', '/assets/state/portfolio.js',
  '/assets/state/watchlist.js', '/assets/state/search.js', '/assets/state/analysis.js',
  '/assets/state/preferences.js', '/assets/state/notifications.js', '/assets/state/legacy-bridge.js',
  '/assets/app-shell/storage.js', '/assets/app-shell/router.js', '/assets/app-shell/auth.js',
  '/assets/app-shell/navigation.js', '/assets/app-shell/profile.js', '/assets/app-shell/theme.js',
  '/assets/app-shell/workspace.js', '/assets/app-shell/preferences.js', '/assets/app-shell/feedback.js',
  '/assets/app-shell/notifications.js', '/assets/app-shell/session.js', '/assets/app-shell/interaction.js',
  '/assets/app-shell/accessibility.js', '/assets/app-shell/boot.js',
  '/assets/routes/home.js', '/assets/routes/watchlist.js', '/assets/routes/search.js',
  '/assets/routes/analysis.js', '/assets/routes/tools.js', '/assets/routes/portfolio.js',
  '/assets/pages/home.js', '/assets/pages/watchlist.js', '/assets/pages/tools.js',
  '/assets/analysis/market-terminal.js', '/assets/analysis/gauges.js', '/assets/analysis/advanced-simulator.js',
  '/assets/portfolio/terminal.js',
  '/assets/services/live-price.js',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(async cache => {
    await cache.addAll(SHELL);
  }));
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
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith((async () => {
    const isShellAsset = url.origin === self.location.origin
      && (url.pathname === '/' || url.pathname === '/app.webmanifest' || url.pathname.startsWith('/assets/'));
    const bypassCache = event.request.cache === 'reload';
    // The shell is revisioned with CACHE_NAME, so cache-first avoids a
    // network round-trip for each route module. A hard refresh must still
    // revalidate the shell so it can receive a newly activated worker's files.
    if (isShellAsset && !bypassCache) {
      const cached = await caches.match(event.request);
      if (cached) return cached;
    }
    try {
      const response = await fetch(event.request);
      // Keep static assets available after their first successful load. This
      // covers future shell modules without ever caching market or account data.
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
