// End-to-end: the built website in Chromium at phone sizes, talking to the real Worker code (with a stand-in database).
// Run: node test/e2e.mjs   (uses ports 8161 and 8162)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ece from 'http_ece';
import { makeD1 } from './d1.mjs';
const WMOD = await import(new URL(process.env.WORKER ? 'file://' + process.env.WORKER : '../worker/worker.js', import.meta.url).href); // WORKER=… tests another copy of the server
const worker = WMOD.default, { sendDue } = WMOD;
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.AUDIT_OUT || path.join(ROOT, 'test', 'out', 'audit'); fs.mkdirSync(OUT, { recursive: true });
const APP = 'http://localhost:8161/shepherd/', API = 'http://localhost:8162';

const results = []; let current = '';
const ok = (c, m) => { results.push({ ok: !!c, m: current + ' - ' + m }); console.log((c ? '  ✓ ' : '  FAIL: ') + current + ' - ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));

// the website, as GitHub Pages would serve it (under /shepherd/), with config.js pointing at the local Worker
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css', '.woff2': 'font/woff2' };
const site = http.createServer((req, res) => {
  const u = new URL(req.url, APP); let p = decodeURIComponent(u.pathname);
  if (!p.startsWith('/shepherd/')) { res.writeHead(404); return res.end(); }
  p = p.slice('/shepherd/'.length) || 'index.html';
  if (p === 'config.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end("window.SHEPHERD_CONFIG = { api: '" + API + "', privacy: { controller: 'Pavi', contact: 'lostshepherdapp@gmail.com' } };"); }
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory() || /^(test|worker|src|node_modules)\//.test(p)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
}).listen(8161);

// the Worker, behind a tiny Node server
const env = { DB: await makeD1(), ALLOWED_ORIGINS: 'http://localhost:8161', ADMIN_KEY: 'admin-key-e2e', APP_URL: APP };
let CUR_LANG = 'en'; const MISSES = {};
const api = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await worker.fetch(new Request(API + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8162);
const db = sql => { const r = env.DB.raw.exec(sql)[0]; return r ? r.values : []; };

// a stand-in phone notification service: the page "subscribes" with keys we hold, so we can read what Shepherd sends
const ua = crypto.createECDH('prime256v1'); ua.generateKeys(); const authSecret = crypto.randomBytes(16);
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const FAKE_SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-device-1', keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(authSecret) } };
const delivered = []; const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => { if (String(u).startsWith('https://fcm.googleapis.com/')) { delivered.push(JSON.parse(ece.decrypt(Buffer.from(init.body), { version: 'aes128gcm', privateKey: ua, authSecret }).toString())); return new Response('', { status: 201 }); } return realFetch(u, init); };
const pushStub = sub => {
  let granted = false, subscribed = null;
  Object.defineProperty(Notification, 'permission', { get: () => (granted ? 'granted' : 'default') });
  Notification.requestPermission = async () => { granted = true; return 'granted'; };
  const mk = () => ({ endpoint: sub.endpoint, toJSON: () => sub, unsubscribe: async () => { subscribed = null; return true; } });
  PushManager.prototype.getSubscription = async function () { return subscribed; };
  PushManager.prototype.subscribe = async function (o) { if (!o || !o.applicationServerKey || o.applicationServerKey.length !== 65) throw new Error('bad key'); subscribed = mk(); return subscribed; };
};

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const I18N_SINK = new Set();
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errors = []; const outside = [];
async function phone(uaStr, w, h) {
  const ctx = await browser.newContext({ viewport: { width: w || 390, height: h || 844 }, userAgent: uaStr, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ctx.addInitScript(pushStub, FAKE_SUB);
  if (process.env.I18N_COLLECT) { await ctx.exposeBinding('__i18nPush', (src, k) => I18N_SINK.add(k)); await ctx.addInitScript(() => { window.__i18nCollect = k => { try { window.__i18nPush(k); } catch (e) {} }; }); }
  const p = await ctx.newPage();
  p.on('request', q => { const u = q.url(); if (!/^(http:\/\/localhost:813[12]|data:|blob:)/.test(u)) outside.push(u); });
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|fonts\.g|cdnjs|ERR_|net::/.test(m.text())) errors.push('console: ' + m.text()); });
  return { ctx, p };
}
const overflow = p => p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
const tap = (p, sel) => p.locator(sel).first().click();
async function skipTour(p) { for (let i = 0; i < 20; i++) { if (await p.locator('#tourSkip').isVisible().catch(() => false)) { await p.click('#tourSkip'); await wait(300); return true; } await wait(200); } return false; }
async function addContact(p, name, phone) {
  await p.locator('#main [data-act="quickadd"]:visible, #fab:visible').first().click(); await wait(450); await p.fill('#cName', name); if (phone) await p.fill('#cPhone', phone);
  if (await p.locator('#cConsent').count()) await p.check('#cConsent');
  await p.$eval('#cForm', f => f.requestSubmit()); await wait(600);
  if (await p.locator('#sheet').isVisible()) { await p.evaluate(() => { const b = document.querySelector('#sheet [data-act="closesheet"]'); if (b) b.click(); }); await wait(400); }
}
async function waitSaved(p) { for (let i = 0; i < 40; i++) { if (/Saved/.test(await p.textContent('#sync'))) return true; await wait(150); } return false; }


const LANGS = process.env.LANGS ? process.env.LANGS.split(',') : ['en', 'es', 'fr', 'pt', 'nl', 'pl', 'pcm', 'yo', 'ig', 'zh-Hans', 'zh-Hant', 'ja', 'de', 'ru', 'lt'];
const SHOT_LANGS = ['en', 'de', 'ru', 'yo', 'ja'];
const WIDTHS = process.env.QUICK ? [[390, 844]] : [[320, 568], [360, 740], [390, 844], [430, 932]];
const VIEWS = ['today', 'people', 'disciples', 'events', 'week', 'about'];
const KEYS = Object.values(JSON.parse(fs.readFileSync(path.join(ROOT, 'lang', 'keys.json'), 'utf8')));
const normT = s => String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const PACKS = {}; for (const c of ['es', 'fr', 'pt', 'nl', 'pl', 'pcm', 'yo', 'ig', 'zh-Hans', 'zh-Hant', 'ja', 'de', 'ru', 'lt']) PACKS[c] = JSON.parse(fs.readFileSync(path.join(ROOT, 'lang', c + '.json'), 'utf8'));
function untranslated(code, texts) {
  const pack = PACKS[code]; if (!pack) return [];
  const want = new Set(); for (const k of KEYS) { if (!(k in pack)) continue; const v = pack[k]; const en = normT(k), tr = normT(typeof v === 'object' ? (v.other || '') : v); if (en && en !== tr && !/\{\d\}/.test(k) && /[A-Za-z]{3}/.test(en)) want.add(en); }
  const out = new Set(); for (const t of texts) { const n = normT(t); if (want.has(n)) out.add(n); }
  return [...out];
}
const screenText = p => p.evaluate(() => { const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const el = n.parentElement; if (!el || el.closest('[hidden],script,style,[data-noi18n]') || !el.offsetParent) continue; if (n.nodeValue.trim()) out.push(n.nodeValue); } document.querySelectorAll('#main li, #main p, #main h1, #main h2, #main button, #main label, #sheet li, #sheet p, #sheet button, #sheet label, .tab, #tour p, #tour h2').forEach(e => { if (e.offsetParent && !e.closest('[data-noi18n]')) out.push(e.textContent); }); document.querySelectorAll('[placeholder],[aria-label]').forEach(e => { if (e.offsetParent) out.push(e.getAttribute('placeholder') || e.getAttribute('aria-label')); }); return out; });
const report = { layout: [], tabs: [], tour: [], axe: {}, big: {}, misses: {}, speed: {}, notes: [] };
const addMiss = (code, list) => { if (!list.length) return; report.misses[code] = [...new Set([...(report.misses[code] || []), ...list])]; };
// everything on screen must sit inside the screen, and no tab label may be cut off
const layoutProblems = p => p.evaluate(() => {
  const out = []; const W = innerWidth;
  if (document.documentElement.scrollWidth - W > 0) out.push('page scrolls sideways by ' + (document.documentElement.scrollWidth - W) + 'px');
  document.querySelectorAll('#main *, #sheet *, .top *, .dock *').forEach(el => {
    if (!el.offsetParent || el.closest('[hidden]') || el.classList.contains('sr') || el.closest('.sr')) return;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) return;
    if (r.right > W + 1 || r.left < -1) { const t = (el.innerText || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 40); if (t) out.push('off screen: ' + t); }
    const cs = getComputedStyle(el);
    if (el.children.length === 0 && el.innerText && el.innerText.trim() && (cs.overflow === 'hidden' || cs.overflowX === 'hidden') && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 2) out.push('cut off: ' + el.innerText.trim().slice(0, 40));
  });
  document.querySelectorAll('.tab').forEach(t => { const r = t.getBoundingClientRect(); if (t.scrollWidth > t.clientWidth + 2 || t.scrollHeight > t.clientHeight + 2) out.push('tab label cut off: ' + t.innerText.trim()); if (r.height < 44 || r.width < 44) out.push('tab too small to tap: ' + t.innerText.trim() + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)); });
  return [...new Set(out)].slice(0, 12);
});
async function setLang(p, code) {
  await p.click('[data-act="settings"]'); await wait(400);
  CUR_LANG = code;
  await Promise.all([p.waitForNavigation({ timeout: 10000 }).catch(() => null), p.selectOption('#pLang', code)]);
  await wait(2200);
}
report.notes.push('detector check (should list Add contact): ' + JSON.stringify(untranslated('es', ['Add contact', 'Añadir contacto'])));
try {
  const A = await phone(IPHONE, 390, 844);
  await A.p.goto(APP); await wait(700);
  await A.p.fill('#aName', 'Pavi'); await A.p.fill('#aEmail', 'audit@church.test'); await A.p.fill('#aPw', 'audit password 1'); await A.p.check('#aAgree');
  await A.p.click('#aGo'); await wait(2500); await skipTour(A.p);
  // a realistic list: long names, every stage and reply state, studies, disciples, prayer, events
  await A.p.evaluate(() => {
    const S = window.__shepherd.S, t = Date.now(), d = n => { const x = new Date(t + n * 864e5); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
    const names = ['Grace Owusu', 'Daniel Mensah', 'Oluwaseun Adeyemi-Okafor', 'Ama Boateng', 'Chukwuemeka Nwachukwu', 'Maximilian Schmidt-Hoffmann', 'Екатерина Смирнова', '山田 花子', 'Kofi Annan-Boateng', 'Lina Petrauskaitė'];
    const stages = ['First contact', 'Interested', 'Studying', 'Regular at church', 'Baptised', 'Disciple'];
    names.forEach((n, i) => window.__shepherd.saveContact({ id: 'a' + i, name: n, phone: '07700 900' + String(100 + i), consent: i !== 3, status: 'active', stage: stages[i % 6], everyDays: 3, createdAt: t - 30 * 864e5, lastContact: t - (i + 1) * 864e5, replyState: ['me', 'them', 'none'][i % 3], meSince: t - 864e5, notes: 'Met at Sunday service', log: [{ t: t - 2 * 864e5, k: 'contact', text: 'Messaged on WhatsApp' }], studies: [{ t: t - 864e5, topic: 'Who is Jesus' }], nextStudy: i < 3 ? { date: d(i), time: '19:00', topic: 'Prayer' } : null, instagram: i === 1 ? 'dan.m' : '' }));
  });
  await addContact(A.p, 'Typed Person', '0244123456'); await wait(500);
  await A.p.evaluate(() => { const S = window.__shepherd.S; S.profile.prayerOn = true; });
  await wait(1500);

  for (const code of LANGS) {
    if (code !== 'en') await setLang(A.p, code); else CUR_LANG = 'en';
    for (const [wd, ht] of WIDTHS) {
      await A.p.setViewportSize({ width: wd, height: ht }); await wait(250);
      for (const v of VIEWS) {
        await A.p.click('.tab[data-v="' + v + '"]'); await wait(300);
        const bad = await layoutProblems(A.p); if (bad.length) report.layout.push(code + ' ' + wd + ' ' + v + ': ' + bad.join(' | '));
        if (code !== 'en' && wd === 390) addMiss(code, untranslated(code, await screenText(A.p)));
        if (SHOT_LANGS.includes(code) && (wd === 320 || wd === 390)) await A.p.screenshot({ path: path.join(OUT, code + '-' + wd + '-' + v + '.png') });
      }
      await A.p.click('[data-act="settings"]'); await wait(350);
      { const bad = await layoutProblems(A.p); if (bad.length) report.layout.push(code + ' ' + wd + ' settings: ' + bad.join(' | ')); if (code !== 'en' && wd === 390) addMiss(code, untranslated(code, await screenText(A.p))); }
      if (SHOT_LANGS.includes(code) && (wd === 320 || wd === 390)) await A.p.screenshot({ path: path.join(OUT, code + '-' + wd + '-settings.png'), fullPage: true });
      // a person's page and the main sheets
      await A.p.click('.tab[data-v="people"]'); await wait(250);
      await A.p.locator('#main [data-act="open"]').first().click(); await wait(350);
      { const bad = await layoutProblems(A.p); if (bad.length) report.layout.push(code + ' ' + wd + ' person: ' + bad.join(' | ')); if (code !== 'en' && wd === 390) addMiss(code, untranslated(code, await screenText(A.p))); }
      if (SHOT_LANGS.includes(code) && wd === 320) await A.p.screenshot({ path: path.join(OUT, code + '-' + wd + '-person.png'), fullPage: true });
      for (const [act, name] of [['logstudy', 'study sheet'], ['edit', 'edit sheet'], ['archive', 'no longer contact sheet']]) {
        const b = A.p.locator('#main [data-act="' + act + '"]').first();
        if (await b.count()) { await b.click(); await wait(400); const bad = await layoutProblems(A.p); if (bad.length) report.layout.push(code + ' ' + wd + ' ' + name + ': ' + bad.join(' | ')); if (code !== 'en' && wd === 390) addMiss(code, untranslated(code, await screenText(A.p))); await A.p.evaluate(() => { const c = document.querySelector('#sheet [data-act="closesheet"]'); if (c) c.click(); }); await wait(300); }
      }
      await A.p.click('[data-act="settings"]'); await wait(300);
      for (const [act, name] of [['yourdata', 'privacy sheet'], ['notifguide', 'notifications guide']]) {
        const b = A.p.locator('#main [data-act="' + act + '"]').first();
        if (await b.count()) { await b.click(); await wait(400); const bad = await layoutProblems(A.p); if (bad.length) report.layout.push(code + ' ' + wd + ' ' + name + ': ' + bad.join(' | ')); if (code !== 'en' && wd === 390) addMiss(code, untranslated(code, await screenText(A.p))); await A.p.evaluate(() => { const c = document.querySelector('#sheet [data-act="closesheet"]'); if (c) c.click(); }); await wait(300); }
      }
      await A.p.click('.tab[data-v="events"]'); await wait(250);
      { const b = A.p.locator('[data-act="calguide"]').first(); if (await b.count()) { await b.click(); await wait(400); const bad = await layoutProblems(A.p); if (bad.length) report.layout.push(code + ' ' + wd + ' calendar guide: ' + bad.join(' | ')); await A.p.evaluate(() => { const c = document.querySelector('#sheet [data-act="closesheet"]'); if (c) c.click(); }); await wait(300); } }
      await A.p.click('.tab[data-v="today"]'); await wait(200);
    }
    if (process.env.QUICK) continue;
    // the tour, at the smallest phone, in every language
    await A.p.setViewportSize({ width: 320, height: 568 }); await wait(200);
    await A.p.click('[data-act="settings"]'); await wait(300); await A.p.click('[data-act="tour"]'); await wait(500);
    let steps = 0; const tb = [];
    for (let i = 0; i < 24; i++) {
      if (!(await A.p.locator('#tour').isVisible())) break;
      await wait(250); steps++;
      const r = await A.p.evaluate(() => { const c = document.getElementById('tourCard').getBoundingClientRect(); return { t: c.top, b: c.bottom, h: innerHeight, title: document.getElementById('tourTitle').textContent, over: document.documentElement.scrollWidth - innerWidth }; });
      if (r.t < 0 || r.b > r.h || r.over > 0) tb.push(r.title);
      if (code !== 'en') addMiss(code, untranslated(code, await screenText(A.p)));
      await A.p.click('#tourNext'); await wait(250);
    }
    report.tour.push(code + ': ' + steps + ' steps' + (tb.length ? ', off screen: ' + tb.join(', ') : ', all on screen'));
    await A.p.setViewportSize({ width: 390, height: 844 });
  }
  await setLang(A.p, 'en');

  if (process.env.QUICK) throw new Error('quick run done');
  // accessibility, in English and Russian
  const axeSrc = fs.readFileSync(process.env.AXE || '/tmp/axe.min.js', 'utf8');
  for (const code of ['en', 'ru']) {
    if (code !== 'en') await setLang(A.p, code);
    await A.p.addScriptTag({ content: axeSrc });
    const run = () => A.p.evaluate(async () => (await axe.run(document, { resultTypes: ['violations'] })).violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => v.id + 'x' + v.nodes.length + ': ' + v.nodes.slice(0, 2).map(n => n.target.join(' ')).join(', ')));
    for (const v of VIEWS) { await A.p.click('.tab[data-v="' + v + '"]'); await wait(350); report.axe[code + ' ' + v] = await run(); }
    await A.p.click('[data-act="settings"]'); await wait(350); report.axe[code + ' settings'] = await run();
    await A.p.click('.tab[data-v="people"]'); await wait(250); await A.p.locator('#main [data-act="open"]').first().click(); await wait(350); report.axe[code + ' person'] = await run();
  }
  await setLang(A.p, 'en');

  // text made 160% bigger still fits
  await A.p.setViewportSize({ width: 390, height: 844 });
  await A.p.evaluate(() => { document.documentElement.style.fontSize = '160%'; document.body.style.zoom = ''; });
  for (const v of VIEWS) { await A.p.click('.tab[data-v="' + v + '"]'); await wait(300); report.big[v] = await overflow(A.p); }
  await A.p.evaluate(() => { document.documentElement.style.fontSize = ''; });

  // speed and phone storage with 500 people
  report.speed = await A.p.evaluate(async () => {
    const S = window.__shepherd.S, t = Date.now();
    for (let i = 0; i < 500; i++) S.contacts['big' + i] = { id: 'big' + i, name: 'Person ' + i + ' Example', phone: '07700 9' + String(10000 + i).slice(-5), consent: true, status: 'active', stage: 'Interested', everyDays: 3, createdAt: t - 9e9, lastContact: t - (i % 20) * 864e5, replyState: i % 7 ? 'none' : 'me', log: Array.from({ length: 12 }, (_, j) => ({ t: t - j * 864e5, k: 'contact', text: 'Messaged on WhatsApp' })), studies: [] };
    const out = {};
    for (const v of ['today', 'people', 'disciples', 'events', 'week', 'about']) { const t0 = performance.now(); document.querySelector('.tab[data-v="' + v + '"]').click(); await new Promise(r => setTimeout(r, 0)); out[v] = Math.round(performance.now() - t0) + 'ms'; }
    let bytes = 0; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); bytes += (k.length + (localStorage.getItem(k) || '').length) * 2; }
    out.phoneStorageKB = Math.round(bytes / 1024) + ' KB (of ~5000 KB)';
    for (let i = 0; i < 500; i++) delete S.contacts['big' + i];
    return out;
  });

  report.notes.push('script errors: ' + (errors.length ? errors.slice(0, 5).join(' / ') : 'none'));
} catch (e) { report.notes.push('CRASH ' + (e && e.stack || e)); }
await browser.close(); site.close(); api.close();
fs.writeFileSync(path.join(OUT, 'audit-final' + (process.env.LANGS ? '-' + process.env.LANGS.replace(/,/g, '_') : '') + '.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify({ layoutProblems: report.layout.length, tour: report.tour, axeSerious: Object.values(report.axe).flat().length, big: report.big, speed: report.speed, missLangs: Object.fromEntries(Object.entries(report.misses).map(([k, v]) => [k, v.length])), notes: report.notes }, null, 1));
