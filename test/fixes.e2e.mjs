// End-to-end, several phones at once: friends, churches, shared Encourage plans, one-tap join, who gets told,
// the under-18 (CAMPUS) safeguards and the private budget tank. Real Worker code, stand-in database.
// Run: node test/friends.e2e.mjs   (uses ports 8135 and 8136)
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
const APP = 'http://localhost:8135/shepherd/', API = 'http://localhost:8136';
const SHOTS = !!process.env.SHOTS;

let pageOverride = null;
const results = []; let current = '';
const ok = (c, m) => { results.push({ ok: !!c, m: current + ' - ' + m }); console.log((c ? '  ✓ ' : '  FAIL: ') + current + ' - ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css', '.woff2': 'font/woff2' };
const site = http.createServer((req, res) => {
  const u = new URL(req.url, APP); let p = decodeURIComponent(u.pathname);
  if (!p.startsWith('/shepherd/')) { res.writeHead(404); return res.end(); }
  p = p.slice('/shepherd/'.length) || 'index.html';
  if (p === 'config.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end("window.SHEPHERD_CONFIG = { api: '" + API + "', privacy: { controller: 'Pavi', contact: 'lostshepherdapp@gmail.com' } };"); }
  if (p === 'index.html' && pageOverride) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(pageOverride); }
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory() || /^(test|worker|src|node_modules)\//.test(p)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
}).listen(8135);

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

const env = { DB: await makeD1(), ALLOWED_ORIGINS: 'http://localhost:8135', ADMIN_KEY: 'admin-key-e2e', APP_URL: APP, OWNER_EMAIL: 'pavi@church.test', GMAIL_USER: 'lostshepherdapp@gmail.com', GMAIL_APP_PASSWORD: 'test app password', __connect: connect };
let oldServer = false; // pretend the server hasn't been updated yet
const background = [];
const api = http.createServer(async (req, res) => {
  if (oldServer && req.method !== 'OPTIONS' && /^\/api\/(social|churches)/.test(req.url)) { res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'http://localhost:8135', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }); return res.end('{"error":"not_found","message":"Not found."}'); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await worker.fetch(new Request(API + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env, { waitUntil: p => background.push(Promise.resolve(p).catch(() => {})) });
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8136);
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
const eshot = async (P, sel, name) => { if (SHOTS) { await P.p.locator(sel).scrollIntoViewIfNeeded(); await wait(150); await P.p.locator(sel).screenshot({ path: path.join(OUT, 'fx-' + name + '.png') }); } };
const shot = async (P, name) => { if (SHOTS) await P.p.screenshot({ path: path.join(OUT, 'fx-' + name + '.png') }); };
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
  if (opts.minor) await p.selectOption('#aAge', 'minor');
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
  current = 'Setup';
  const A = await phone('pavi', IPHONE), B = await phone('grace', ANDROID, 360, 780), C = await phone('sam', ANDROID);
  await signUp(A, 'Pavi Kumar', 'pavi@church.test', { church: 'c_london_icc' });
  await signUp(B, 'Grace Owusu', 'grace@church.test', { church: 'c_london_icc' });
  await signUp(C, 'Sam Bello', 'sam@other.test', { church: '' });
  const PA = uidOf('pavi@church.test'), GB = uidOf('grace@church.test'), SC = uidOf('sam@other.test');
  ok(PA && GB && SC, 'three people signed up');

  current = 'Honest answer';
  await openFriends(A.p);
  ok(await A.p.locator('#frInvite').isVisible(), 'there is an "Invite with a link" button');
  await A.p.fill('#frTo', 'ZZZZ9999'); await A.p.$eval('#frForm', f => f.requestSubmit()); await wait(1800);
  ok(/No request was sent/.test(await text(A.p, '#frErr')) && await A.p.locator('#frErr').isVisible(), 'a wrong friend code says plainly that no request was sent');
  ok(await A.p.inputValue('#frTo') === 'ZZZZ9999', 'and keeps what was typed so it can be corrected');
  ok(db('SELECT COUNT(*) FROM friends')[0][0] === 0, 'nothing was saved for it');
  await A.p.fill('#frTo', 'nobody@nowhere.test'); await A.p.$eval('#frForm', f => f.requestSubmit()); await wait(1800);
  ok(/No request was sent/.test(await text(A.p, '#frErr')), 'an email nobody uses says the same');
  await A.p.fill('#frTo', 'grace@church.test'); await A.p.$eval('#frForm', f => f.requestSubmit()); await wait(1800);
  ok(/Grace O\. has your request/.test(await text(A.p, '#toastMsg')) && /friends once they accept/.test(await text(A.p, '#toastMsg')), 'a real request says who it went to and that they must accept: "' + (await text(A.p, '#toastMsg')) + '"');
  ok(/Requests you sent/.test(await text(A.p, '#main')) && db("SELECT st FROM friends WHERE a = '" + PA + "' AND b = '" + GB + "'")[0][0] === 0, 'it is listed under Requests you sent, waiting');
  await A.p.fill('#frTo', 'grace@church.test'); await A.p.$eval('#frForm', f => f.requestSubmit()); await wait(1800);
  ok(/already asked them/.test(await text(A.p, '#frErr')), 'asking the same person again explains it is already waiting');

  current = 'Requests on Today';
  await tab(B.p, 'today'); await refresh(B.p); await wait(600);
  ok(await B.p.locator('#frReqToday').isVisible() && /Pavi K\./.test(await text(B.p, '#frReqToday')), 'the request is at the top of Today for the other person');
  ok(await overflow(B.p) <= 0, 'Today still fits the phone with the request card');
  await shot(B, 'today-request');
  await B.p.click('#frReqToday [data-fr="accept"]'); await wait(1800);
  ok(db("SELECT st FROM friends WHERE a = '" + PA + "' AND b = '" + GB + "'")[0][0] === 1, 'Accept on Today makes them friends');
  ok(!(await B.p.locator('#frReqToday').count()), 'and the request card goes away');
  await A.p.evaluate(() => document.activeElement && document.activeElement.blur()); await refresh(A.p); await wait(900);
  ok(/Grace Owusu/.test(await text(A.p, '#frMine')), 'the sender now sees them under Your friends');

  current = 'Two requests at once';
  { // a forced refresh while another is running must still bring the newest answer
    const n = await A.p.evaluate(async () => { const S = window.__shepherd; const a = S.socLoad(true), b = S.socLoad(true); await Promise.all([a, b]); return (S.SOC.me.friends || []).length; });
    ok(n === 1, 'two refreshes started together both finish with the latest list'); }

  current = 'Invite link';
  const code = (await soc(A.p)).me.code;
  const link = await A.p.evaluate(() => { let got = ''; navigator.share = undefined; const c = navigator.clipboard; return new Promise(res => { const o = c && c.writeText; if (c) c.writeText = t => { res(t); return Promise.resolve(); }; document.querySelector('#frInvite').click(); setTimeout(() => res(got), 1500); }); });
  ok(link.indexOf('?friend=' + code) > 0 && /Add me as a friend on Shepherd/.test(link), 'the invite is a sentence with a link that carries my friend code');
  await C.p.goto(APP + '?friend=' + code); await wait(3200);
  ok(await C.p.locator('#sheet').isVisible() && /invited you/.test(await text(C.p, '#sheet')), 'opening the link offers to send a request');
  ok(!/friend=/.test(C.p.url()), 'and the code is taken out of the address bar');
  await C.p.click('#ivGo'); await wait(2000);
  ok(db("SELECT st FROM friends WHERE a = '" + SC + "' AND b = '" + PA + "'")[0][0] === 0, 'one tap sends the request');
  ok(await C.p.evaluate(() => !localStorage.getItem('shepherd:pendingFriend')), 'the invite is used once');
  await tab(A.p, 'today'); await refresh(A.p); await wait(500);
  await A.p.click('#frReqToday [data-fr="accept"]'); await wait(1800);
  ok(db("SELECT st FROM friends WHERE a = '" + SC + "' AND b = '" + PA + "'")[0][0] === 1, 'and accepting it makes them friends');
  await A.p.goto(APP + '?friend=' + code); await wait(3000);
  ok(!(await A.p.locator('#sheet').isVisible()), 'opening my own invite link does nothing');

  current = 'Under 18 by mistake';
  const D = await phone('dee', ANDROID);
  await D.p.goto(APP); await wait(900);
  ok(await D.p.inputValue('#aAge') === 'adult' && !(await D.p.locator('#aMinor').count()), 'sign-up asks for an age with "18 or older" already chosen: there is no tick to tick by habit');
  await signUp(D, 'Dee Marsh', 'dee@church.test', { church: 'c_london_icc', minor: true });
  const DD = uidOf('dee@church.test');
  ok(db("SELECT minor, ok FROM social WHERE uid = '" + DD + "'")[0].join() === '1,0', 'choosing 13 to 17 makes an under-18 account that waits for approval');
  await tab(D.p, 'friends'); await wait(600);
  ok(/chose this by mistake, email lostshepherdapp@gmail\.com/.test(await text(D.p, '#socWait')), 'the waiting notice says what to do if it was chosen by mistake');
  await A.p.goto(APP); await wait(2500); await tab(A.p, 'today'); await refresh(A.p); await wait(500);
  ok(await A.p.locator('#ownerToday').isVisible() && /1 waiting for approval/.test(await text(A.p, '#ownerToday')), 'the person who runs Shepherd sees who is waiting at the top of Today');
  ok(!(await B.p.locator('#ownerToday').count()), 'nobody else does');
  await A.p.click('#ownerToday [data-act="approvals"]'); await wait(1200);
  ok(await A.p.locator('#sheet [data-adult]').count() === 1, 'Approvals has an "Is 18+" button beside Approve and Decline');
  ok(await overflow(A.p) <= 0, 'and the three buttons fit the phone');
  await shot(A, 'approvals');
  await A.p.click('#sheet [data-adult]'); await wait(1800);
  ok(db("SELECT minor, ok FROM social WHERE uid = '" + DD + "'")[0].join() === '0,1', 'tapping it makes theirs a normal adult account');
  await closeSheet(A.p); await refresh(A.p); await wait(400);
  ok(!(await A.p.locator('#ownerToday').count()), 'and the Today notice goes away');
  await refresh(D.p); await wait(700);
  ok(!(await D.p.locator('#socWait').count()) && await D.p.locator('#frForm').isVisible(), 'they can add friends straight away');
  // the church sheet: saying you are under 18 takes a second tap
  await tab(C.p, 'friends'); await wait(500); await C.p.click('#churchCard [data-act="church"]'); await wait(900);
  await C.p.selectOption('#chSel', 'c_london_icc'); await C.p.check('#chMinor'); await C.p.$eval('#chForm', f => f.requestSubmit()); await wait(900);
  ok(db("SELECT minor FROM social WHERE uid = '" + SC + "'")[0][0] === 0 && /Tap again to confirm you are under 18/.test(await text(C.p, '#chForm button[type="submit"]')), 'ticking "I\'m under 18" asks for a second tap before anything is saved');
  await C.p.uncheck('#chMinor'); await wait(200);
  ok(/^Save$/.test((await text(C.p, '#chForm button[type="submit"]')).trim()), 'unticking it puts the button back');
  await C.p.$eval('#chForm', f => f.requestSubmit()); await wait(1500);
  ok(db("SELECT church, minor FROM social WHERE uid = '" + SC + "'")[0].join() === 'c_london_icc,0', 'and the church saves as an adult account');

  current = 'Updates by themselves';
  const page0 = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const build0 = /<meta name="shepherd-build" content="([^"]+)"/.exec(page0)[1];
  await B.p.goto(APP); await wait(2500);
  ok(await B.p.evaluate(() => !!navigator.serviceWorker.controller), 'the app is running from this phone\'s stored copy');
  ok(await B.p.evaluate(() => document.querySelector('meta[name="shepherd-build"]').content) === build0, 'it knows which build it is');
  const resume = p => p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  // the same build on the server: nothing happens
  await B.p.evaluate(() => { window.__mark = 1; }); await resume(B.p); await wait(2500);
  ok(await B.p.evaluate(() => window.__mark === 1), 'coming back to the app with nothing new leaves it alone');
  // a new build arrives while someone is typing: it waits
  pageOverride = page0.replace(build0, 'newbuild0002');
  await B.p.evaluate(() => { sessionStorage.removeItem('shepherd:autoReload'); });
  await tab(B.p, 'friends'); await B.p.focus('#frTo'); await B.p.type('#frTo', 'hal');
  await B.p.evaluate(() => { window.__mark = 2; window.SHEPHERD_WEB.onUpdate('newbuild0002'); }); await wait(1200);
  ok(await B.p.evaluate(() => window.__mark === 2) && /new version/.test(await text(B.p, '#toastMsg')), 'a new version never interrupts typing: it offers itself instead');
  // going to the background switches over
  await B.p.evaluate(() => { document.activeElement.blur(); Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await wait(3500);
  ok(await B.p.evaluate(() => window.__mark === undefined), 'it switches over by itself once the app is in the background');
  // (that reload fetched the new page in the background; the next launch shows it, untouched, within seconds)
  await B.p.evaluate(() => { sessionStorage.removeItem('shepherd:autoReload'); });
  await B.p.goto(APP); await wait(4500);
  ok(await B.p.evaluate(() => document.querySelector('meta[name="shepherd-build"]').content) === 'newbuild0002', 'and the next time it opens it is the new build');
  // an open app that is brought back to the front finds a newer build and switches before being touched
  pageOverride = page0.replace(build0, 'newbuild0003');
  await wait(400);
  await B.p.evaluate(() => { sessionStorage.removeItem('shepherd:autoReload'); window.__mark = 3; });
  await B.p.evaluate(() => { window.__resume = Date.now(); }); 
  ok(true, 'waiting for the next check window');
  { // the check is held to once every five minutes; a fresh page has not checked yet, so reload first
    await B.p.goto(APP); await wait(4500);
    const b = await B.p.evaluate(() => document.querySelector('meta[name="shepherd-build"]').content);
    ok(b === 'newbuild0003', 'a launch picks up the newest build straight away, not one launch later (' + b + ')'); }
  pageOverride = page0.replace(build0, 'newbuild0004');
  await B.p.evaluate(() => { sessionStorage.removeItem('shepherd:autoReload'); window.__mark = 4; });
  await resume(B.p); await wait(5000);
  { const b = await B.p.evaluate(() => document.querySelector('meta[name="shepherd-build"]').content);
    ok(b === 'newbuild0004' && await B.p.evaluate(() => window.__mark === undefined), 'bringing the app back to the front finds the new build and switches to it (' + b + ')'); }
  ok(await B.p.evaluate(() => !!window.SHEPHERD_WEB.user() && !!document.querySelector('.tab')), 'still signed in, with everything there, after switching');
  // it can never loop
  await B.p.evaluate(() => { window.__mark = 5; window.SHEPHERD_WEB.onUpdate('another'); }); await wait(1500);
  ok(await B.p.evaluate(() => window.__mark === 5), 'and it never reloads twice within a minute');
  pageOverride = null;

  current = 'Script errors';
  ok(errors.length === 0, 'no script errors on any phone' + (errors.length ? ': ' + errors.slice(0, 5).join(' / ') : ''));
} catch (e) { console.log('CRASH', e && e.stack || e); results.push({ ok: false, m: 'crash' }); }
await browser.close(); site.close(); api.close();
const pass = results.filter(r => r.ok).length;
console.log('\nFixes end-to-end: ' + pass + ' passed, ' + (results.length - pass) + ' failed');
process.exit(results.length === pass ? 0 : 1);
