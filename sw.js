// sw.js — Service Worker:快取 App 殼層,讓 PWA 可離線開啟、可安裝。
const CACHE = 'signaldesk-v1';
const SHELL = [
  './', './index.html',
  './css/styles.css',
  './js/app.js', './js/data.js', './js/sectors.js',
  './js/strategy.js', './js/portfolio.js', './js/backtest.js',
  './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// App 殼層走 cache-first;真實行情 API 請求應改走 network-first (見 README)。
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
