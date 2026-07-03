// Network-only service worker. It exists solely to make the app installable as
// a PWA (Chrome requires a fetch handler); it intentionally caches nothing, so
// the app always loads fresh content and never serves stale assets offline.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  // Pass through to the network untouched. No cache reads, no cache writes.
  if (event.request.method === "GET") {
    event.respondWith(fetch(event.request));
  }
});
