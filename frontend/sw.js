const CACHE_NAME = 'goldensignage-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/reset.css',
  '/css/variables.css',
  '/css/main.css',
  '/js/app.js',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  'https://fonts.googleapis.com/css2?family=Goldman:wght@400;700&family=Michroma&display=swap'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Cache-First Strategy
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then((networkResponse) => {
        // Cache dynamic assets if needed, but for now just return network response
        return networkResponse;
      }).catch(() => {
        // Handle offline fallback if needed
      });
    })
  );
});
