// web/sw.js — 预缓存全部静态资源，离线可用
// 策略：同源 GET 资源 → 缓存优先（cache-first），导航请求 → 回退 index.html；
// 跨域请求（后端 REST API）一律走网络，不进缓存。

const VERSION = '1.3.2';
const CACHE = `mintlite-v${VERSION}`;

const PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './js/util.js',
  './js/money.js',
  './js/mint.js',
  './js/stats.js',
  './js/seed.js',
  './js/store.js',
  './js/store-local.js',
  './js/store-api.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // 逐个 add，单个失败不拖垮整次安装
      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: 'reload' }));
          } catch (err) {
            console.warn('[sw] 预缓存失败', url, err && err.message);
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'CLEAR_CACHE') {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // API 一律直连网络：同源部署时（8787 同时托管页面和接口）缓存会把
  // 不同 ledger_id / 筛选条件的 GET 命中成同一条旧响应，列表和统计就会「不刷新」。
  if (url.pathname.startsWith('/api/')) return;
  // 只接管同源静态资源；后端 API 在别的端口/主机时本来就走默认网络
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE);
          cache.put('./index.html', fresh.clone()).catch(() => {});
          return fresh;
        } catch {
          const cache = await caches.open(CACHE);
          const cached = (await cache.match('./index.html')) || (await cache.match('./'));
          return cached || new Response('离线，且没有缓存 index.html', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) {
        // 后台刷新，不阻塞
        fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
          })
          .catch(() => {});
        return hit;
      }
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
        return res;
      } catch {
        if (req.destination === 'image' || /\.(png|svg|ico)$/.test(url.pathname)) {
          const fallback = await cache.match('./icons/icon.svg');
          if (fallback) return fallback;
        }
        return new Response('', { status: 504, statusText: 'offline' });
      }
    })(),
  );
});
