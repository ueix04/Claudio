const CACHE = "claudio-v2";
const ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/favicon.svg?v=20260508-2",
];

self.addEventListener("install", (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener("fetch", (ev) => {
  ev.respondWith(
    caches.match(ev.request).then((r) => r || fetch(ev.request))
  );
});
