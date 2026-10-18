// Caches the app so it opens offline. Card data and images come from Scryfall
// and are cached by the browser; searching still needs a connection.
// App files are fetched fresh whenever you're online (so updates show up on the
// next load) and the saved copy is only used when you're offline.
const CACHE = 'deckbuilder-v5';
const SHELL = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './src/app.js', './src/parser.js', './src/scryfall.js', './src/deck.js', './src/store.js',
  './src/query.js', './src/version.js', './src/sync.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch (_) {
        return (await cache.match(req, { ignoreSearch: true })) || Response.error();
      }
    })()
  );
});
