// Offline support: keeps the app's own files so the shopping list opens in a
// shop with no signal. Always tries the network first, so updates show up as
// soon as you're online. API data is handled by the app (it keeps the last
// copy of your list and queues ticks made offline).
const CACHE = 'grocery-shell-v5';
const SHELL = ['/', '/theme.js', '/styles.css', '/app.js', '/vendor/chart.js/chart.umd.js', '/icon.svg', '/favicon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith((async () => {
    try {
      // Never the browser's HTTP cache: a new version shows up on the next load.
      const res = await fetch(e.request, { cache: 'no-cache' });
      if (res.ok && (SHELL.includes(url.pathname) || e.request.mode === 'navigate')) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request.mode === 'navigate' ? '/' : e.request, copy));
      }
      return res;
    } catch {
      // Offline: every page of the app is the same single page.
      return (await caches.match(e.request.mode === 'navigate' ? '/' : e.request)) || Response.error();
    }
  })());
});
