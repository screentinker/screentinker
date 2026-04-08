const CACHE_NAME = 'rd-player-v3';
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

  // Content files (videos, images): cache on first fetch for offline playback
  if (url.pathname.startsWith('/uploads/content/')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CONTENT_CACHE).then(cache => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => new Response('Offline', { status: 503 }));
      })
    );
    return;
  }

  // Player page and static assets: network-first, fall back to cache
  if (url.pathname.startsWith('/player') || url.pathname === '/socket.io/socket.io.js') {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match(event.request).then(cached => cached || new Response('Offline', { status: 503 })))
    );
    return;
  }

  // Everything else: network only
  event.respondWith(fetch(event.request));
});
