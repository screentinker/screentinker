const CACHE_NAME = 'rd-player-v4';
const CONTENT_CACHE = 'rd-content-v1';

// Install: skip waiting to activate immediately
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Activate: clean old caches, claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME && k !== CONTENT_CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// Fetch handler
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle GET requests — let POST/PUT/DELETE pass through
  if (event.request.method !== 'GET') return;

  // Content files (videos, images): cache-first for offline playback
  if (url.pathname.startsWith('/uploads/content/')) {
    // Skip range requests (video seeking) — serve from network, don't cache partial responses
    if (event.request.headers.get('range')) {
      return; // Let the browser handle range requests directly
    }

    event.respondWith(
      caches.open(CONTENT_CACHE).then(cache =>
        cache.match(event.request, { ignoreSearch: true }).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(response => {
            // Only cache successful, complete (non-opaque) responses
            if (response.ok && response.status === 200 && response.type !== 'opaque') {
              cache.put(event.request, response.clone());
            }
            return response;
          }).catch(() => {
            return new Response('Content unavailable offline', {
              status: 503,
              statusText: 'Service Unavailable',
              headers: { 'Content-Type': 'text/plain' }
            });
          });
        })
      ).catch(() => {
        // Cache API itself failed — fall through to network
        return fetch(event.request).catch(() =>
          new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
        );
      })
    );
    return;
  }

  // Player page and static assets: network-first, fall back to cache
  if (url.pathname.startsWith('/player') || url.pathname === '/socket.io/socket.io.js') {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response.ok && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() =>
        caches.match(event.request, { ignoreSearch: true }).then(cached =>
          cached || new Response('Offline', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/plain' }
          })
        )
      )
    );
    return;
  }

  // Everything else: network only, don't intercept failures
  // (Returning without calling event.respondWith lets the browser handle it natively)
});
