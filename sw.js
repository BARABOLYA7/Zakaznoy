/* Заказной — сервис-воркер офлайн-режима.
   Стратегия:
   - навигация (HTML): сеть с таймаутом → кэш → офлайн-страница версии;
   - статика: сначала кэш, параллельно обновление (stale-while-revalidate);
   - сторонние запросы (шрифты, Supabase, CDN) — только сеть.
   Один недоступный файл не ломает установку: каждый URL кэшируется отдельно. */

const SW_VERSION = 'zakaznoy-v3-jack';
const CACHE_NAME = 'zakaznoy-' + SW_VERSION;
const NAV_TIMEOUT = 5500;

const CORE = [
  './',
  './index.html',
  './404.html',
  './pc/',
  './pc/index.html',
  './pc/manifest.json',
  './mobile/',
  './mobile/index.html',
  './mobile/manifest.json',
  './manifest.json',
  './favicon.ico',
  './apple-touch-icon.png',
  './icon-32.png',
  './pc/favicon.ico',
  './pc/apple-touch-icon.png',
  './pc/icon-32.png',
  './mobile/favicon.ico',
  './mobile/apple-touch-icon.png',
  './mobile/icon-32.png',
  './icons/favicon.ico',
  './icons/icon-32.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png'
];

function abs(url){
  try{ return new URL(url, self.registration.scope).href; }catch(e){ return url; }
}

function isHtml(req){
  if(req.mode === 'navigate') return true;
  const accept = req.headers.get('accept') || '';
  if(accept.indexOf('text/html') >= 0) return true;
  try{
    const p = new URL(req.url).pathname;
    return /\/$/.test(p) || /\.html?$/i.test(p);
  }catch(e){ return false; }
}

function htmlFallback(req){
  let path = '/';
  try{ path = new URL(req.url).pathname; }catch(e){}
  const scoped = path.indexOf('/mobile') === 0 ? './mobile/index.html'
               : path.indexOf('/pc') === 0 ? './pc/index.html'
               : './index.html';
  return caches.match(abs(scoped)).then(hit => hit || caches.match(abs('./index.html')));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // каждый файл кэшируем независимо: 404 одного не срывает установку
    await Promise.all(CORE.map(async url => {
      try{
        const req = new Request(abs(url), { cache: 'reload' });
        const res = await fetch(req);
        if(res && (res.ok || res.type === 'opaque')) await cache.put(abs(url), res.clone());
      }catch(e){}
    }));
    try{ await self.skipWaiting(); }catch(e){}
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k !== CACHE_NAME && k.indexOf('zakaznoy-') === 0) ? caches.delete(k) : Promise.resolve()));
    try{ await self.clients.claim(); }catch(e){}
  })());
});

self.addEventListener('message', event => {
  const data = event.data || {};
  if(data.type === 'SKIP_WAITING'){ try{ self.skipWaiting(); }catch(e){} }
});

async function networkFirst(req){
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req, { ignoreSearch: true });
  const fallback = () => cached || htmlFallback(req);
  try{
    const ctl = new AbortController();
    const timer = setTimeout(() => { try{ ctl.abort(); }catch(e){} }, NAV_TIMEOUT);
    let res;
    try{
      res = await fetch(req, { signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
    if(res && res.ok){
      try{ await cache.put(req, res.clone()); }catch(e){}
      return res;
    }
    return (await fallback()) || res;
  }catch(e){
    const hit = await fallback();
    if(hit) return hit;
    return new Response(
      '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Заказной — офлайн</title><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
      'background:#071f10;color:#f0c96a;font-family:system-ui,sans-serif;text-align:center;padding:24px">' +
      '<div><h1 style="letter-spacing:3px">ЗАКАЗНОЙ</h1><p style="color:#cfe8d8">Нет соединения. Открой игру ещё раз — ' +
      'она загрузится из кэша, и игра с ботом будет доступна.</p></div></body></html>',
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

async function staleWhileRevalidate(req){
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req).then(res => {
    if(res && (res.ok || res.type === 'opaque')){
      try{ cache.put(req, res.clone()); }catch(e){}
    }
    return res;
  }).catch(() => null);
  return cached || (await network) || Response.error();
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if(req.method !== 'GET') return;
  let url;
  try{ url = new URL(req.url); }catch(e){ return; }
  if(url.origin !== self.location.origin) return; // шрифты, Supabase, CDN — напрямую
  if(isHtml(req)){
    event.respondWith(networkFirst(req));
    return;
  }
  if(/^\/(icons|pc|mobile)\//.test(url.pathname) || /\.(?:css|js|png|jpg|jpeg|svg|webp|woff2?|json)$/i.test(url.pathname)){
    event.respondWith(staleWhileRevalidate(req));
  }
});
