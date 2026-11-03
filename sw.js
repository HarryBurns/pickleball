// Service worker: приложение открывается без сети, обновления подтягиваются сами.
// Версию нужно менять, только если меняется список SHELL.
const CACHE = "pickleball-v9";
const SHELL = [
  "./", "index.html", "styles.css", "app.js", "store.js", "ledger.js", "config.js",
  "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
];
const NETWORK_TIMEOUT = 3000;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fromCache(req) {
  return caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match("index.html"));
}

// Свои файлы: сначала сеть (чтобы сразу видеть обновления), но если сеть не ответила
// за 3 секунды или недоступна — кэш. Свежий ответ всё равно попадает в кэш.
// Запросы к базе данных (другой домен) не трогаем.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  const network = fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  });
  e.waitUntil(network.catch(() => {}));
  e.respondWith(new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done && r) { done = true; resolve(r); } };
    const timer = setTimeout(() => fromCache(req).then(finish), NETWORK_TIMEOUT);
    network
      .then((res) => { clearTimeout(timer); finish(res); })
      .catch(() => { clearTimeout(timer); fromCache(req).then((r) => finish(r || Response.error())); });
  }));
});
