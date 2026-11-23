/* global self, caches, fetch, URL, Request, Response */
const CACHE = "dziennik-public-__PUBLIC_CACHE_VERSION__";
const PUBLIC_ASSETS = new Set(/* __PUBLIC_ASSETS__ */ []);
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        cache.addAll(
          [...PUBLIC_ASSETS]
            .filter(
              (url) =>
                url === "/offline.html" ||
                url === "/offline.css" ||
                url === "/manifest.webmanifest" ||
                url.startsWith("/icons/"),
            )
            .map((url) => new Request(url, { credentials: "omit", cache: "reload" })),
        ),
      ),
  );
  // Updates wait. No automatic skipWaiting or reload can discard an open draft.
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith("dziennik-public-") && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Do not call respondWith for API, other origins or writes, even when offline.
  if (
    url.origin !== self.location.origin ||
    url.pathname === "/api" ||
    url.pathname.startsWith("/api/") ||
    event.request.method !== "GET"
  )
    return;
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(async () => {
        const offline = await caches.match("/offline.html", { cacheName: CACHE });
        // Static Assets may redirect .html to a clean URL. A navigation cannot
        // reuse a redirected cached response with redirect mode "manual".
        return new Response(offline?.body ?? "Brak połączenia z internetem.", {
          status: offline?.status ?? 503,
          headers: offline?.headers ?? { "Content-Type": "text/plain; charset=utf-8" },
        });
      }),
    );
    return;
  }
  if (url.search || !PUBLIC_ASSETS.has(url.pathname)) return;
  event.respondWith(
    caches
      .match(event.request, { cacheName: CACHE })
      .then((cached) => cached || fetch(event.request)),
  );
});
self.addEventListener("message", (event) => {
  if (event.data?.type !== "ACTIVATE_WHEN_ALONE" || !event.ports[0]) return;
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const accepted = clients.length === 1 && clients[0].id === event.source?.id;
      event.ports[0].postMessage({ accepted });
      if (accepted) await self.skipWaiting();
    })(),
  );
});
