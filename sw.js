/* Shepherd service worker: opens with no signal, and shows the notifications the Shepherd server sends.
   It never stores anything from the server itself (your list is stored by the app, per person). */
const VERSION = 'shepherd-v6', MINE = 'shepherd-';
const PAGE = './index.html', REST = ['./config.js', './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png', './badge-96.png', './vendor/fonts.css', './vendor/qrcode.min.js', './privacy.html'];
const END = '<!--shepherd:end-->'; // the build writes this as the very last thing in the app page
const scopePath = () => new URL(self.registration.scope).pathname;
const isAppPage = url => url.origin === self.location.origin && (url.pathname === scopePath() || url.pathname === scopePath() + 'index.html');
// only a real, complete copy of the app page may replace the stored one
const looksRight = r => !!r && r.ok && r.status === 200 && !r.redirected && r.type === 'basic' && /text\/html/i.test(r.headers.get('content-type') || '');
async function storePage(r, tell) {
  if (!looksRight(r)) return false;
  const text = await r.text(), at = text.lastIndexOf(END);
  if (at < 0 || text.length - at > 400) return false;
  const c = await caches.open(VERSION);
  const old = await c.match(PAGE).then(h => (h ? h.text() : null)).catch(() => null);
  await c.put(PAGE, new Response(text, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  // a newer Shepherd has arrived: let the open app offer to switch to it
  if (tell && old !== null && old !== text) (await self.clients.matchAll({ type: 'window' })).forEach(w => w.postMessage({ update: true }));
  return true;
}
const direct = u => new Request(u, { cache: 'reload' });
self.addEventListener('install', e => {
  e.waitUntil(fetch(direct(PAGE)).then(storePage).then(ok => { if (!ok) throw new Error('the app page did not arrive whole'); return caches.open(VERSION); })
    .then(c => Promise.all(REST.map(u => c.add(direct(u)).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.indexOf(MINE) === 0 && k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const fonts = url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com' || url.host === 'cdnjs.cloudflare.com';
  if (!sameOrigin && !fonts) return; // the Shepherd server and everything else go straight to the network
  if (req.mode === 'navigate') {
    if (!isAppPage(url)) return;
    // open at once from this phone's copy, and fetch a newer copy in the background for next time
    const fresh = fetch(req, { cache: 'no-cache' });
    e.waitUntil(fresh.then(r => storePage(r.clone(), true)).catch(() => false));
    e.respondWith(caches.open(VERSION).then(c => c.match(PAGE)).then(hit => hit || fresh));
    return;
  }
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});

/* notifications from the Shepherd server: each one names a person and opens them when tapped */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { title: 'Shepherd', body: e.data ? e.data.text() : '' }; }
  const jobs = [self.registration.showNotification(d.title || 'Shepherd', { body: d.body || '', tag: d.tag || undefined, icon: 'icon-192.png', badge: 'badge-96.png', data: { url: d.url || './' }, lang: d.lang || undefined })];
  if (typeof d.badge === 'number' && self.navigator && self.navigator.setAppBadge) jobs.push((d.badge ? self.navigator.setAppBadge(d.badge) : self.navigator.clearAppBadge()).catch(() => null));
  e.waitUntil(Promise.all(jobs));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.indexOf(self.registration.scope) === 0 && 'focus' in c) { c.postMessage({ open: url }); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
