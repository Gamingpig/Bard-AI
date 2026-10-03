const CACHE = 'bard-ai-shell-v20';
const SHELL = ['./', './index.html', './app.css', './app.js', './preview.html', './pcm-capture.js', './manifest.webmanifest', './icons/bard.svg', './icons/bard-512.png'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cached = await caches.match(request);
    try {
      const response = await fetch(request);
      if (response.ok && request.destination !== 'document') {
        const copy = response.clone();
        void caches.open(CACHE).then(cache => cache.put(request, copy));
      }
      return response;
    } catch {
      return cached || (request.destination === 'document' ? caches.match('./index.html') : Response.error());
    }
  })());
});
