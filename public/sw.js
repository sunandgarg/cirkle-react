const IMAGE_CACHE = "cirkle-images-v2";
const MAX_IMAGE_ENTRIES = 250;

const trimCache = async () => {
  const cache = await caches.open(IMAGE_CACHE);
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_IMAGE_ENTRIES)).map((key) => cache.delete(key)));
};

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil((async () => {
  await caches.delete("cirkle-images-v1");
  await self.clients.claim();
})()));

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.destination !== "image") return;

  const url = new URL(request.url);
  const isLocalImage = url.origin === self.location.origin;
  // Signed private-media URLs are intentionally never persisted in the
  // service-worker cache. Access revocation must take effect when the URL
  // expires instead of leaving an authorized response readable on device.
  if (!isLocalImage) return;

  event.respondWith((async () => {
    const cache = await caches.open(IMAGE_CACHE);
    const cached = await cache.match(request);
    const network = fetch(request).then((response) => {
      if (response.ok || response.type === "opaque") {
        cache.put(request, response.clone()).then(trimCache);
      }
      return response;
    }).catch(() => cached || Response.error());
    return cached || network;
  })());
});
