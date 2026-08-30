const STATIC_CACHE = "indexd-static-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("indexd-static-") && key !== STATIC_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function cacheableStatic(request, url) {
  if (request.method !== "GET" || url.origin !== self.location.origin) return false;
  if (url.pathname === "/icon.svg") return true;
  if (url.pathname.startsWith("/_next/static/")) return true;
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/fonts/")) return true;
  return false;
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!cacheableStatic(event.request, url)) return;

  event.respondWith(
    caches.open(STATIC_CACHE).then(async (cache) => {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    }),
  );
});
