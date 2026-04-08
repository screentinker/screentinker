const CACHE_NAME = 'rd-player-v1';
const STATIC_ASSETS = ['/player/', '/player/index.html', '/socket.io/socket.io.js'];

// Install: cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

// Fetch: cache content files for offline playback
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Cache content files (videos, images) on first fetch
  if (url.pathname.startsWith('/uploads/content/')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => new Response('Offline', { status: 503 }));
      })
    );
    return;
  }

  // For static assets, try cache first
  if (STATIC_ASSETS.some(a => url.pathname === a || url.pathname.endsWith(a))) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
    return;
  }

  // Everything else: network only
  event.respondWith(fetch(event.request));
});
