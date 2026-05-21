/* Service Worker — RFN Tracker PWA */
const CACHE = 'rfn-v1';
const ASSETS = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './formes-des-lignes-du-rfn.geojson',
  './liste-des-gares.csv',
  './liste-des-pks.csv',
  './liste-des-installations-terminales-embranchees.csv',
  './liste-des-triages.csv',
  './vitesse-maximale-nominale-sur-ligne.csv',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => {
      // Cache app shell; data files cached on first fetch
      return c.addAll(['./rfn-tracker.html','./manifest.json','./icon-192.png','./icon-512.png']);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Network first for GPS/map tiles, cache first for local data files
  const url = new URL(e.request.url);
  if (url.hostname === 'tile.openstreetmap.org' || url.hostname.includes('cdn.jsdelivr.net')) {
    e.respondWith(
      caches.open(CACHE).then(c =>
        c.match(e.request).then(cached => {
          const net = fetch(e.request).then(r => { c.put(e.request, r.clone()); return r; });
          return cached || net;
        })
      )
    );
    return;
  }
  // Local files: cache first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(r => {
        if (r.ok) {
          const clone = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return r;
      });
    })
  );
});
