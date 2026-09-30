/* Hors ligne : l'application et les leçons sont gardées sur la tablette.
   Les leçons sont d'abord demandées au réseau (pour recevoir la semaine suivante), puis prises dans le cache si pas de connexion. */
const CACHE = 'kono-0.1.0';
const CORE = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'fonts/andika-400.woff2', 'fonts/andika-700.woff2', 'fonts/nunito-800.woff2',
  'icons/icon-192.png', 'icons/icon-512.png', 'lessons/index.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const url = new URL(req.url);
  if (url.pathname.includes('/lessons/') || url.pathname.endsWith('app.js') || url.pathname.endsWith('styles.css') || req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
    return;
  }
  e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; })));
});
