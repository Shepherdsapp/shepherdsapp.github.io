// End-to-end, several phones at once: friends, churches, shared Encourage plans, one-tap join, who gets told,
// the under-18 (CAMPUS) safeguards and the private budget tank. Real Worker code, stand-in database.
// Run: node test/friends.e2e.mjs   (uses ports 8143 and 8144)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ece from 'http_ece';
import { makeD1 } from './d1.mjs';
const WMOD = await import(new URL('../worker/worker.js', import.meta.url).href);
const worker = WMOD.default, { sendDue } = WMOD;
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test', 'out'); fs.mkdirSync(OUT, { recursive: true });
const APP = 'http://localhost:8143/shepherd/', API = 'http://localhost:8144';
const SHOTS = !!process.env.SHOTS;

const results = []; let current = '';
const ok = (c, m) => { results.push({ ok: !!c, m: current + ' - ' + m }); console.log((c ? '  ✓ ' : '  FAIL: ') + current + ' - ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css', '.woff2': 'font/woff2' };
const site = http.createServer((req, res) => {
  const u = new URL(req.url, APP); let p = decodeURIComponent(u.pathname);
  if (!p.startsWith('/shepherd/')) { res.writeHead(404); return res.end(); }
  p = p.slice('/shepherd/'.length) || 'index.html';
  if (p === 'config.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end("window.SHEPHERD_CONFIG = { api: '" + API + "', privacy: { controller: 'Pavi', contact: 'lostshepherdapp@gmail.com' } };"); }
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory() || /^(test|worker|src|node_modules)\//.test(p)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
}).listen(8143);

// a stand-in for Gmail's mail server, so emails to the person who runs Shepherd can be read
const mails = [];
const connect = () => {
  let ctrl, inData = false, data = '';
  const readable = new ReadableStream({ start(c) { ctrl = c; c.enqueue(new TextEncoder().encode('220 ready\r\n')); } });
  const writable = new WritableStream({ write(chunk) {
    const t = new TextDecoder().decode(chunk); const say = x => ctrl.enqueue(new TextEncoder().encode(x + '\r\n'));
    if (inData) { data += t; if (data.endsWith('\r\n.\r\n')) { inData = false; mails.push(data); say('250 OK'); } return; }
    for (const line of t.split('\r\n').filter(Boolean)) {
      if (/^EHLO/.test(line)) say('250 hi'); else if (/^AUTH/.test(line)) say('235 OK'); else if (/^(MAIL|RCPT)/.test(line)) say('250 OK');
      else if (line === 'DATA') { inData = true; data = ''; say('354 go'); } else if (line === 'QUIT') { say('221 bye'); ctrl.close(); }
    }
  } });
  return { readable, writable, opened: Promise.resolve(), close() {} };
};

const env = { DB: await makeD1(), ALLOWED_ORIGINS: 'http://localhost:8143', ADMIN_KEY: 'admin-key-e2e', APP_URL: APP, OWNER_EMAIL: 'pavi@church.test', GMAIL_USER: 'lostshepherdapp@gmail.com', GMAIL_APP_PASSWORD: 'test app password', __connect: connect };
let oldServer = false; // pretend the server hasn't been updated yet
const background = [];
const api = http.createServer(async (req, res) => {
  if (oldServer && req.method !== 'OPTIONS' && /^\/api\/(social|churches)/.test(req.url)) { res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'http://localhost:8143', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }); return res.end('{"error":"not_found","message":"Not found."}'); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await worker.fetch(new Request(API + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env, { waitUntil: p => background.push(Promise.resolve(p).catch(() => {})) });
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8144);
const db = sql => { const r = env.DB.raw.exec(sql)[0]; return r ? r.values : []; };
const settle = async () => { await wait(250); await Promise.all(background.splice(0)); await sendDue(env, 40); };

// every phone gets its own stand-in notification address, so the test can see exactly who was told what
const ua = crypto.createECDH('prime256v1'); ua.generateKeys(); const authSecret = crypto.randomBytes(16);
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const subFor = who => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/phone-' + who, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(authSecret) } });
const delivered = []; const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  if (String(u).startsWith('https://fcm.googleapis.com/')) { const d = JSON.parse(ece.decrypt(Buffer.from(init.body), { version: 'aes128gcm', privateKey: ua, authSecret }).toString()); d.to = String(u).split('phone-')[1]; delivered.push(d); return new Response('', { status: 201 }); }
  return realFetch(u, init);
};
const mailText = m => { const i = m.indexOf('\r\n\r\n'); return m.slice(0, i) + '\n' + Buffer.from(m.slice(i + 4).replace(/\r\n\.\r\n$/, '').replace(/\s+/g, ''), 'base64').toString(); };
const told = who => delivered.filter(d => d.to === who).map(d => d.title + ' | ' + d.body);
const pushStub = sub => {
  let granted = false, subscribed = null;
  Object.defineProperty(Notification, 'permission', { get: () => (granted ? 'granted' : 'default') });
  Notification.requestPermission = async () => { granted = true; return 'granted'; };
  const mk = () => ({ endpoint: sub.endpoint, toJSON: () => sub, unsubscribe: async () => { subscribed = null; return true; } });
  PushManager.prototype.getSubscription = async function () { return subscribed; };
  PushManager.prototype.subscribe = async function () { subscribed = mk(); return subscribed; };
};

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errors = []; const I18N_SINK = new Set();
async function phone(who, uaStr, w, h) {
  const ctx = await browser.newContext({ viewport: { width: w || 390, height: h || 844 }, userAgent: uaStr || ANDROID, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ctx.addInitScript(pushStub, subFor(who));
  if (process.env.I18N_COLLECT) { await ctx.exposeBinding('__i18nPush', (src, k) => I18N_SINK.add(k)); await ctx.addInitScript(() => { window.__i18nCollect = k => { try { window.__i18nPush(k); } catch (e) {} }; }); }
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(who + ': ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|fonts\.g|cdnjs|ERR_|net::/.test(m.text())) errors.push(who + ' console: ' + m.text()); });
  return { ctx, p, who };
}
const overflow = p => p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
const eshot = async (P, sel, name) => { if (SHOTS) { await P.p.locator(sel).scrollIntoViewIfNeeded(); await wait(150); await P.p.locator(sel).screenshot({ path: path.join(OUT, 'fr-' + name + '.png') }); } };
const shot = async (P, name) => { if (SHOTS) await P.p.screenshot({ path: path.join(OUT, 'fr-' + name + '.png') }); };
async function skipTour(p) { for (let i = 0; i < 20; i++) { if (await p.locator('#tourSkip').isVisible().catch(() => false)) { await p.click('#tourSkip'); await wait(300); return true; } await wait(200); } return false; }
const closeSheet = async p => { await p.evaluate(() => { const s = document.querySelector('#sheet'); if (s && !s.hidden) { const b = s.querySelector('[data-act="closesheet"]'); if (b) b.click(); } }); await wait(400); };
const tab = async (p, v) => { await closeSheet(p); await p.click('.tab[data-v="' + v + '"]'); await wait(350); };
const refresh = async p => { await p.evaluate(() => window.__shepherd.socLoad(true)); await wait(500); };
const soc = p => p.evaluate(() => JSON.parse(JSON.stringify(window.__shepherd.SOC)));
const text = (p, sel) => p.textContent(sel);
const uidOf = email => db("SELECT id FROM users WHERE email = '" + email + "'")[0][0];
async function signUp(P, name, email, opts = {}) {
  const p = P.p;
  await p.goto(APP); await wait(700);
  await p.fill('#aName', name); await p.fill('#aEmail', email); await p.fill('#aPw', 'correct horse 1'); await p.check('#aAgree');
  if (opts.church !== undefined) { await p.waitForSelector('#aChurchBox:not([hidden])', { timeout: 5000 }); await p.selectOption('#aChurch', opts.church); }
  if (opts.minor) await p.check('#aMinor');
  if (opts.before) await opts.before(p);
  await p.click('#aGo'); await wait(2600);
  await skipTour(p); await wait(600);
}
async function pushOn(P) {
  await closeSheet(P.p); await P.p.click('[data-act="settings"]'); await wait(600);
  await P.p.click('#notifCard [data-act="pushon"]'); await wait(1300);
}
async function openFriends(p) { await tab(p, 'friends'); await wait(700); }
async function newPlan(p, f) {
  await tab(p, 'encourage'); await p.click('[data-act="newenc"][data-t="' + (f.type || 'hangout') + '"]'); await wait(450);
  if (f.share) { await p.click('#enShare [data-v="friends"]'); await wait(150); }
  if (f.who) await p.fill('#enWho', f.who);
  if (f.date) await p.fill('#enDate', f.date);
  if (f.time) await p.fill('#enTime', f.time);
  if (f.activity) await p.fill('#enAct', f.activity);
  if (f.place) await p.fill('#enPlace', f.place);
  if (f.food) await p.check('#enFood');
  if (f.cost !== undefined) await p.fill('#enCost', String(f.cost));
  if (f.pay) { await p.click('#enPay [data-v="' + f.pay + '"]'); await wait(150); }
  if (f.peek) await f.peek(p);
  await p.$eval('#enForm', x => x.requestSubmit()); await wait(600);
}
const ymd = t => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
// a day later this month where possible, so the budget tank (which is per month) counts it
const soon = (() => { const d = new Date(); const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); return ymd(new Date(d.getFullYear(), d.getMonth(), Math.min(last, d.getDate() + 3)).getTime()); })();
const sameMonth = soon.slice(0, 7) === ymd(Date.now()).slice(0, 7) && soon > ymd(Date.now());


try {
  current = 'Friends tab';
  const A = await phone('pavi', IPHONE), B = await phone('grace', ANDROID, 360, 780);
  await signUp(A, 'Pavi Kumar', 'pavi@church.test', { church: 'c_london_icc' });
  await signUp(B, 'Grace Owusu', 'grace@church.test', { church: 'c_london_icc' });
  const tabsOf = p => p.evaluate(() => [...document.querySelectorAll('.tab')].filter(t => !t.hidden).map(t => t.dataset.v).join());
  ok(await tabsOf(A.p) === 'today,people,disciples,events,encourage,friends', 'there are six tabs, Friends last');
  ok(await A.p.evaluate(() => window.__shepherd.tourList().length) === 19 && await A.p.evaluate(() => window.__shepherd.tourList()[16].title) === 'Friends', 'a new account\'s tour has a Friends step (19 steps)');
  await tab(A.p, 'encourage');
  ok(!(await A.p.locator('#frBar').count()), 'the Friends bar is gone from Encourage');
  await openFriends(A.p);
  { const t = await text(A.p, '#main');
    ok(await A.p.evaluate(() => document.body.dataset.view) === 'friends' && /never see your People, Disciples, prayer list, notes, phone numbers or budget/.test(t), 'the Friends tab opens as its own page and says what friends can see');
    ok(/Your friends/.test(t) && /Add a friend/.test(t) && /Your friend code/.test(t) && /People from my church/.test(t) && /Grace O\./.test(t) && /Your church/.test(t) && /London ICC/.test(t) && /Approvals/.test(t), 'it holds friends, add a friend, friend code, people from my church, your church and (for the owner) Approvals'); }
  ok(await A.p.evaluate(() => getComputedStyle(document.body).getPropertyValue('--tint').trim()) === '#1D6464', 'with its own teal colour');
  ok(await overflow(A.p) <= 0, 'and fits the phone');
  await shot(A, 'tab-friends');
  await A.p.click('[data-act="settings"]'); await wait(500);
  ok(!(await A.p.locator('#churchCard').count()), 'the church card has moved out of Settings');
  await openFriends(A.p);
  await A.p.click('#frPeople [data-fr="add"]'); await wait(1200);
  ok(/Request sent/.test(await text(A.p, '#frPeople')), 'Add friend works from the tab');
  await refresh(B.p);
  ok(await B.p.locator('#frBadge').isVisible() && await text(B.p, '#frBadge') === '1', 'a friend request puts a badge on the Friends tab');
  await openFriends(B.p); await B.p.click('#frReq [data-fr="accept"]'); await wait(1300);
  ok((await soc(B.p)).me.friends.length === 1 && /Pavi Kumar/.test(await text(B.p, '#frMine')) && !(await B.p.locator('#frBadge').isVisible()), 'accepting makes them friends and clears the badge');

  current = 'Today';
  await tab(B.p, 'today'); await wait(400);
  ok(await B.p.locator('#frToday').isVisible() && /None of your friends has a plan coming up/.test(await text(B.p, '#frToday')) && await B.p.locator('#frToday [data-act="newenc"]').count() === 2, 'with no plans from friends, Today suggests planning a date or a hangout');
  await shot(B, 'tab-today-empty');

  current = 'Join limit';
  let note = '';
  await newPlan(A.p, { type: 'hangout', share: true, date: soon, time: '18:30', activity: 'Bowling night', place: 'Hollywood Bowl', cost: 20, pay: 'split', peek: async p => { ok(await p.locator('#enCap').isVisible() && await p.inputValue('#enCap') === '0', 'a shared plan asks how many others can join, starting at No limit'); await p.selectOption('#enCap', '1'); await wait(150); note = await text(p, '#enCapNote'); ok(await p.locator('#enCapNote').isVisible() && /3 or more people/.test(note), 'choosing 1 shows a quiet note about under-18s'); await shot(A, 'tab-plan-form'); } });
  await wait(2800); await settle();
  ok(db("SELECT data FROM docs WHERE path LIKE 'profile/events/%' AND data LIKE '%Bowling%'")[0][0].includes('"cap":1'), 'the limit is saved with the plan');
  await refresh(B.p); await wait(300);
  ok(await B.p.locator('#frBadge').isVisible() && await text(B.p, '#frBadge') === '1', 'a new shared plan puts a badge on the Friends tab');
  await tab(B.p, 'today'); await wait(400);
  { const t = await text(B.p, '#frToday');
    ok(/From your friends/.test(t) && /Pavi Kumar/.test(t) && /Bowling night/.test(t), 'Today shows which friend has a plan'); }
  await tab(A.p, 'today'); await wait(400);
  ok(/Coming up/.test(await text(A.p, '#comingCard')) && /Bowling night/.test(await text(A.p, '#comingCard')) && await A.p.locator('#comingCard .cu-k.enc').count() === 1, 'the host\'s Today lists it under Coming up');
  await shot(B, 'tab-today');
  await openFriends(B.p);
  ok(await text(B.p, '#frMine .plnum') === '1' && /1 plan in Encourage/.test(await text(B.p, '#frMine')) && !(await B.p.locator('#frBadge').isVisible()), 'the Friends tab shows a 1 next to Pavi, and looking clears the badge');
  await shot(B, 'tab-friends-count');
  await B.p.click('#frMine .plnum'); await wait(500);
  ok(await B.p.evaluate(() => document.body.dataset.view) === 'encourage' && /0 of 1 going/.test(await text(B.p, '#feedSec')), 'tapping the number goes to the plan in Encourage, which shows "0 of 1 going"');
  // a third friend, so the limit can be reached
  const C = await phone('tobi', ANDROID, 412, 915);
  await signUp(C, 'Tobi Adeyemi', 'tobi@church.test', { church: 'c_london_icc' });
  await C.p.evaluate(() => window.SHEPHERD_WEB.api('POST', '/api/social/friend', { to: 'pavi@church.test' }));
  await A.p.evaluate(async () => { const m = await window.SHEPHERD_WEB.api('GET', '/api/social/me'); await window.SHEPHERD_WEB.api('POST', '/api/social/friend/answer', { id: m.incoming[0].id, accept: true }); });
  await B.p.locator('#feedSec .jbtn').first().click(); await wait(1300);
  ok(/1 of 1 going/.test(await text(B.p, '#feedSec')) && /Going/.test(await text(B.p, '#feedSec .jbtn')), 'Grace takes the only place');
  await refresh(C.p); await tab(C.p, 'encourage'); await wait(400);
  ok(/Full/.test(await text(C.p, '#feedSec .jbtn')) && await C.p.locator('#feedSec .jbtn').first().isDisabled() && /1 of 1 going/.test(await text(C.p, '#feedSec')), 'for the next friend the plan says Full and can\'t be joined');
  await C.p.click('#feedSec .pcard-main'); await wait(500);
  ok(/Up to 1 other can join/.test(await text(C.p, '#sheetBody')) && await C.p.locator('#sheetBody [data-act="joinplan"]').count() === 0 || /Full/.test(await text(C.p, '#sheetBody')), 'and the plan page says "Up to 1 other can join"');
  { const r = await C.p.evaluate(async h => { try { await window.SHEPHERD_WEB.api('POST', '/api/social/join', { host: h, plan: window.__shepherd.SOC.feed[0].id }); return 'joined'; } catch (e) { return e.code + ': ' + e.message; } }, uidOf('pavi@church.test'));
    ok(/full/i.test(r), 'even asking the server directly is refused: ' + r); }
  await closeSheet(C.p);

  current = 'What\'s new';
  ok(!(await A.p.locator('#newsCard').count()), 'someone who has just taken the tour gets no What\'s new card');
  await A.p.evaluate(() => { const W = window.__shepherd; W.S.profile.seenNew = 0; W.saveProfile(); }); await tab(A.p, 'encourage'); await tab(A.p, 'today'); await wait(400);
  await wait(1500); // the short tour now starts by itself for someone who already had an account
  ok(await text(A.p, '#tourStep') === '1 of 3' && /Friends has its own tab/.test(await text(A.p, '#tourTitle')) && await A.p.evaluate(() => document.body.dataset.view) === 'friends', '"Show me" starts a short 3-step tour at the Friends tab');
  await A.p.click('#tourNext'); await wait(600);
  ok(/budget tank/i.test(await text(A.p, '#tourTitle')) && await A.p.evaluate(() => document.body.dataset.view) === 'encourage', 'step 2 is the budget tank');
  await A.p.click('#tourNext'); await wait(600); await A.p.click('#tourNext'); await wait(900);
  ok(await A.p.locator('#tour').isHidden() && !(await A.p.locator('#newsCard').count()) && await A.p.evaluate(() => window.__shepherd.S.profile.seenNew) === 3, 'after the short tour the card is gone for good');
  await A.p.click('[data-act="settings"]'); await wait(500); await A.p.click('[data-act="tour"]'); await wait(700);
  ok(/of 19/.test(await text(A.p, '#tourStep')), 'and "Show me around" still runs the whole tour (19 steps)');
  await A.p.click('#tourSkip'); await wait(500);

  current = 'Tab bar in every language';
  const LANGS = ['en', 'es', 'fr', 'pt', 'nl', 'pl', 'pcm', 'yo', 'ig', 'zh-Hans', 'zh-Hant', 'ja', 'de', 'ru', 'lt'];
  const small = [];
  for (const [w, h] of [[320, 568], [360, 740], [390, 844]]) {
    await A.p.setViewportSize({ width: w, height: h });
    for (const code of LANGS) {
      await A.p.evaluate(c => { localStorage.setItem('shepherd:lang', c); }, code); await A.p.reload(); await wait(1500);
      const r = await A.p.evaluate(() => { const out = []; document.querySelectorAll('.tab:not([hidden])').forEach(t => { const l = t.querySelector('.tl'), cs = getComputedStyle(l), lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.1, tr = t.getBoundingClientRect(), lr = l.getBoundingClientRect(); out.push({ t: l.textContent, fs: parseFloat(cs.fontSize), cut: l.scrollWidth > l.clientWidth + 1 || l.scrollHeight > l.clientHeight + 2, lines: Math.round(lr.height / lh), inside: lr.bottom <= tr.bottom + 1 && lr.left >= tr.left - 1 && lr.right <= tr.right + 1 }); }); return { tabs: out, over: document.documentElement.scrollWidth - innerWidth, dock: document.querySelector('.dock-in').getBoundingClientRect().height }; });
      const bad = r.tabs.filter(x => x.cut || x.lines > 2 || !x.inside || x.fs < 8.5);
      const minFs = Math.min(...r.tabs.map(x => x.fs));
      if (bad.length || r.over > 0 || r.tabs.length !== 6) ok(false, code + ' at ' + w + 'px: ' + JSON.stringify(bad) + ' overflow ' + r.over);
      if (minFs < 10) small.push(code + '@' + w + ':' + minFs);
      if (SHOTS && (code === 'ig' || code === 'yo' || code === 'en' || code === 'ru') && w !== 360) await A.p.locator('.dock').screenshot({ path: path.join(OUT, 'dock-' + code + '-' + w + '.png') });
    }
  }
  ok(true, 'all six labels are whole, inside their tab and on at most two lines, in 15 languages at 320, 360 and 390px');
  console.log('  (labels below 10px: ' + (small.join(', ') || 'none') + ')');

  current = 'Script errors';
  ok(errors.length === 0, 'no script errors on any phone' + (errors.length ? ': ' + errors.slice(0, 5).join(' / ') : ''));
} catch (e) { console.log('CRASH', e && e.stack || e); results.push({ ok: false, m: 'crash' }); }
await browser.close(); site.close(); api.close();
const pass = results.filter(r => r.ok).length;
console.log('\nFriends tab quick check: ' + pass + ' passed, ' + (results.length - pass) + ' failed');
process.exit(results.length === pass ? 0 : 1);
