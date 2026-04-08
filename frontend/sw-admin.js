const CACHE = 'rd-admin-v1';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll([
    '/', '/index.html', '/css/variables.css', '/css/reset.css', '/css/main.css',
    '/js/app.js', '/js/api.js', '/js/socket.js', '/js/i18n.js',
    '/js/components/toast.js'
  ])));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Network first for API, cache first for static
  if (e.request.url.includes('/api/') || e.request.url.includes('/socket.io/')) return;
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
