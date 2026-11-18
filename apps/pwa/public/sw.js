// Service worker Novabot : cache de la coquille + notifications push.
const CACHE = "novabot-shell-v2";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/favicon.ico", "/logo-256.png", "/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // API, auth, flux : jamais en cache
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/") || url.pathname.startsWith("/internal/") || url.pathname.startsWith("/pub/")) return;
  // assets versionnés : cache d'abord
  if (url.pathname.startsWith("/assets/")) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })),
    );
    return;
  }
  // navigation : réseau d'abord, coquille en secours (hors ligne)
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone(); caches.open(CACHE).then((c) => c.put("/index.html", copy));
        return res;
      }).catch(() => caches.match("/index.html")),
    );
  }
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "Novabot", body: e.data ? e.data.text() : "" }; }
  const title = d.title || "Novabot";
  e.waitUntil(
    self.registration.showNotification(title, {
      body: d.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: d.tag || undefined,
      data: { url: d.url || "/" },
      requireInteraction: d.level === "blocked" || d.level === "alert",
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) { c.navigate ? c.navigate(url).catch(() => {}) : null; return c.focus(); }
      }
      return self.clients.openWindow(url);
    }),
  );
});
