const SHELL_CACHE = 'cn-shell-v3';
const RUNTIME_CACHE = 'cn-runtime';

const SHELL_FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isShellRequest(url) {
  return SHELL_FILES.some(f => url.endsWith(f.replace('./', '')));
}

function isApiRequest(url) {
  return url.includes('api.github.com');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = req.url;

  // GitHub folder listing: network-first, fall back to last cached copy when offline
  if (isApiRequest(url)) {
    event.respondWith(
      fetch(req).then(res => {
        const clone = res.clone();
        caches.open(RUNTIME_CACHE).then(c => c.put(req, clone));
        return res;
      }).catch(() =>
        caches.open(RUNTIME_CACHE).then(c => c.match(req, { ignoreVary: true }))
      )
    );
    return;
  }

  // App shell: cache-first, refresh in background
  if (isShellRequest(url) || req.mode === 'navigate') {
    event.respondWith(
      caches.match(req).then(cached => {
        const fetchPromise = fetch(req).then(res => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(SHELL_CACHE).then(c => c.put(req, clone));
          }
          return res;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Everything else (attachments: images, pdf, etc.): cache-first, runtime cache on success
  event.respondWith(
    caches.open(RUNTIME_CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreVary: true });
      if (cached) return cached;
      try {
        const res = await fetch(req);
        cache.put(req, res.clone());
        return res;
      } catch (e) {
        return cached || Response.error();
      }
    })
  );
});
