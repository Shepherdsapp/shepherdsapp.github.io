// End-to-end: the built website in Chromium at phone sizes, talking to the real Worker code (with a stand-in database).
// Run: node test/e2e.mjs   (uses ports 8131 and 8132)
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
const OUT = path.join(ROOT, 'test', 'out'); fs.mkdirSync(OUT, { recursive: true });
const APP = 'http://localhost:8131/shepherd/', API = 'http://localhost:8132';

const results = []; let current = '';
const ok = (c, m) => { results.push({ ok: !!c, m: current + ' - ' + m }); console.log((c ? '  ✓ ' : '  FAIL: ') + current + ' - ' + m); };
const wait = ms => new Promise(r => setTimeout(r, ms));

// the website, as GitHub Pages would serve it (under /shepherd/), with config.js pointing at the local Worker
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css', '.woff2': 'font/woff2' };
const site = http.createServer((req, res) => {
  const u = new URL(req.url, APP); let p = decodeURIComponent(u.pathname);
  if (!p.startsWith('/shepherd/')) { res.writeHead(404); return res.end(); }
  p = p.slice('/shepherd/'.length) || 'index.html';
  if (p === 'config.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end("window.SHEPHERD_CONFIG = { api: '" + API + "', privacy: { controller: 'Pavi', contact: '8pavii@gmail.com' } };"); }
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory() || /^(test|worker|src|node_modules)\//.test(p)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
}).listen(8131);

// the Worker, behind a tiny Node server
const env = { DB: await makeD1(), ALLOWED_ORIGINS: 'http://localhost:8131', ADMIN_KEY: 'admin-key-e2e', APP_URL: APP };
const api = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await worker.fetch(new Request(API + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8132);
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

try {
  current = 'Sign up';
  const A = await phone(IPHONE);
  await A.p.goto(APP); await wait(600);
  ok(await A.p.locator('#auth').isVisible() && /Create my account/.test(await A.p.textContent('#auth')), 'a new phone opens on Create account');
  ok(await overflow(A.p) <= 0, 'sign-in screen fits the phone');
  await A.p.screenshot({ path: path.join(OUT, 'signin-390.png') });
  await A.p.fill('#aName', 'Pavi'); await A.p.fill('#aEmail', 'pavi@church.test'); await A.p.fill('#aPw', 'short');
  await A.p.click('#aGo'); await wait(200);
  ok(/at least 8 characters/.test(await A.p.textContent('#aErr')), 'too-short password explained');
  await A.p.fill('#aPw', 'correct horse 1');
  await A.p.click('#aGo'); await wait(300);
  ok(/agree to the acceptable use/.test(await A.p.textContent('#aErr')) && (() => { try { return !db("SELECT COUNT(*) FROM users")[0][0]; } catch (e) { return true; } })(), 'no account until the acceptable use statement is agreed');
  ok(await A.p.locator('#auth a[href="privacy.html"]').count() === 1, 'the sign-up screen links to the privacy notice');
  await A.p.check('#aAgree');
  ok(!(await A.p.locator('#aInvite').isVisible()), 'with no invite code set on the server, sign-up doesn\'t ask for one');
  env.INVITE_CODE = 'GRACE-2026'; // the church turns the invite code on
  await A.p.reload(); await wait(800);
  await A.p.fill('#aName', 'Pavi'); await A.p.fill('#aEmail', 'pavi@church.test'); await A.p.fill('#aPw', 'correct horse 1'); await A.p.check('#aAgree'); await wait(300);
  ok(await A.p.locator('#aInvite').isVisible(), 'once a code is set, sign-up asks for the church invite code');
  await A.p.fill('#aInvite', 'WRONG CODE');
  await A.p.click('#aGo'); await wait(1500);
  ok(/invite code isn't right/.test(await A.p.textContent('#aErr')) && (() => { try { return !db("SELECT COUNT(*) FROM users")[0][0]; } catch (e) { return true; } })(), 'a wrong invite code is refused, with a clear message');
  await A.p.fill('#aInvite', 'grace-2026');
  await A.p.click('#aGo'); await wait(2500);
  ok(!(await A.p.locator('#auth').isVisible()), 'account created and signed in');
  ok(db("SELECT email FROM users")[0][0] === 'pavi@church.test' && !/correct horse/.test(JSON.stringify(db('SELECT * FROM users'))), 'account saved on the server without the password itself');
  ok(!(await A.p.locator('#agree').isVisible()), 'agreeing on sign-up is enough, no second agreement screen');
  ok(await skipTour(A.p), 'the tour starts by itself for a new account');
  { const ag = JSON.parse(db("SELECT data FROM docs WHERE path = 'profile'")[0][0]).agreed; ok(ag && ag.v === 1 && ag.at > 0, 'the agreement is saved with the account (version and time)'); }
  ok(await A.p.locator('#installCard').isVisible(), 'iPhone in Safari is shown how to put Shepherd on the Home Screen');

  current = 'Saving to the server';
  await addContact(A.p, 'Daniel Mensah', '07700900111');
  await addContact(A.p, 'Grace Owusu', '07700900222');
  ok(await waitSaved(A.p), 'top bar says Saved');
  const names = db("SELECT data FROM docs WHERE path LIKE 'profile/contacts/%'").map(r => JSON.parse(r[0]).name).sort();
  ok(names.join() === 'Daniel Mensah,Grace Owusu', 'both contacts are on the server');
  const prof = db("SELECT data FROM docs WHERE path = 'profile'");
  ok(prof.length && JSON.parse(prof[0][0]).name === 'Pavi', 'the name from sign-up is on the profile');
  const danId = db("SELECT path FROM docs WHERE data LIKE '%Daniel%'")[0][0].split('/').pop();

  current = 'Notifications';
  await A.p.click('[data-act="settings"]'); await wait(700);
  ok(/off on this phone|Add Shepherd to your Home Screen/.test(await A.p.textContent('#notifCard')), 'Settings shows notifications are not on yet');
  await A.p.screenshot({ path: path.join(OUT, 'settings-390.png') });
  await A.p.click('#notifCard [data-act="pushon"]'); await wait(1500);
  ok(db('SELECT COUNT(*) FROM subs')[0][0] === 1, 'this phone is registered for notifications');
  ok(/on for this phone/.test(await A.p.textContent('#notifCard')) && await A.p.locator('#notifCard [data-act="pushtest"]').isVisible(), 'Settings now shows notifications are on, with a test button');
  await A.p.click('#notifCard [data-act="pushtest"]'); await wait(1200);
  ok(delivered.length === 1 && delivered[0].title === 'Shepherd notifications are on', 'test notification reaches the phone');
  await wait(3000);
  const sched = db("SELECT title, body, url, at FROM outbox WHERE sent = 0 ORDER BY at");
  const dm = sched.find(r => r[0] === 'Message Daniel');
  ok(dm && /Daniel/.test(dm[1]) && dm[2] === './?open=' + danId, 'upcoming notification: "Message Daniel", opening Daniel');
  ok(sched.some(r => r[0] === 'Message Grace'), 'and one for Grace');
  ok(new Date(dm[3]).getHours() === 8, 'at the morning time from Settings');
  env.DB.raw.run('UPDATE outbox SET at = ? WHERE title = ?', [Date.now() - 1000, 'Message Daniel']); delivered.length = 0;
  await sendDue(env);
  ok(delivered.length >= 1 && delivered.some(d => d.title === 'Message Daniel' && /Tap to/.test(d.body) && d.url === './?open=' + danId), 'the server sends "Message Daniel" to the phone when it\'s due');
  await A.p.fill('#pAlert', '07:30'); await A.p.dispatchEvent('#pAlert', 'change'); await wait(3500);
  const later = db("SELECT at FROM outbox WHERE sent = 0 AND title = 'Message Grace' ORDER BY at LIMIT 1");
  ok(later.length && new Date(later[0][0]).getHours() === 7 && new Date(later[0][0]).getMinutes() === 30, 'changing the time moves the notifications');

  current = 'Tapping a notification';
  await A.p.goto(APP + '?open=' + danId); await wait(1500);
  ok(/Daniel Mensah/.test(await A.p.textContent('#main')) && /Message on WhatsApp/.test(await A.p.textContent('#main')), 'opens Daniel\'s page');
  ok(!/open=/.test(A.p.url()), 'the link is tidied away after opening');

  current = 'Calendar';
  await A.p.click('[data-act="logstudy"]'); await wait(500);
  const nd = new Date(Date.now() + 3 * 864e5); const ndS = nd.getFullYear() + '-' + String(nd.getMonth() + 1).padStart(2, '0') + '-' + String(nd.getDate()).padStart(2, '0');
  await A.p.fill('#sTopic', 'Intro'); await A.p.fill('#nDate', ndS); await A.p.fill('#nTime', '19:00'); await A.p.fill('#nTopic', 'Prayer');
  await A.p.$eval('#sForm', f => f.requestSubmit()); await wait(900);
  ok(await A.p.textContent('#sheetTitle') === 'Study saved' && /remind you an hour before/.test(await A.p.textContent('#sheetBody')), 'study saved, with a reminder promised');
  const addLink = await A.p.getAttribute('#sheetBody a:has-text("Add to phone calendar")', 'href');
  ok(addLink && addLink.startsWith(API + '/cal/') && addLink.endsWith('/study/' + danId + '.ics'), '"Add to phone calendar" link for this study');
  await waitSaved(A.p);
  const one = await (await realFetch(addLink)).text();
  ok(/SUMMARY:Bible study – Daniel/.test(one) && one.includes('DTSTART:' + ndS.replace(/-/g, '') + 'T190000'), 'the phone gets the study at 7pm');
  await A.p.evaluate(() => document.querySelector('#sheet [data-act="closesheet"]').click()); await wait(400);
  await A.p.click('.tab[data-v="events"]'); await wait(400);
  await A.p.click('[data-act="calguide"]'); await wait(500);
  const g = await A.p.textContent('#sheetBody');
  ok(/1\. Connect Shepherd to your phone calendar/.test(g) && /2\. Keep your personal TimeTree events/.test(g) && !/Google|Select Display Filters/.test(g), 'guide: connect Shepherd to the phone calendar first; no linking TimeTree');
  const feed = await A.p.getAttribute('[data-act="calconnect"]', 'href');
  ok(feed && feed.startsWith('webcal://localhost:8132/cal/') && feed.endsWith('.ics'), '"Connect to iPhone calendar" opens the phone\'s subscribe screen');
  const feedText = await (await realFetch(feed.replace('webcal:', 'http:'))).text();
  ok(/BEGIN:VCALENDAR/.test(feedText) && /Bible study – Daniel/.test(feedText), 'the calendar link has the study');
  await A.p.screenshot({ path: path.join(OUT, 'calguide-390.png') });
  await wait(3500);
  const sched2 = db("SELECT title FROM outbox WHERE sent = 0").map(r => r[0]);
  ok(sched2.includes('Bible study with Daniel at 7pm'), 'a notification is booked an hour before the study');
  await A.p.evaluate(() => document.querySelector('#sheet [data-act="closesheet"]').click()); await wait(400);

  current = 'Second phone';
  const B = await phone(ANDROID, 360, 780);
  await B.p.goto(APP); await wait(600);
  await B.p.click('[data-auth="signin"]'); await wait(200);
  await B.p.fill('#aEmail', 'PAVI@church.test'); await B.p.fill('#aPw', 'wrong password');
  await B.p.click('#aGo'); await wait(1500);
  ok(/don't match/.test(await B.p.textContent('#aErr')), 'wrong password refused');
  await B.p.fill('#aPw', 'correct horse 1'); await B.p.click('#aGo'); await wait(2500);
  ok(!(await B.p.locator('#auth').isVisible()), 'signs in on an Android phone');
  ok(!(await B.p.locator('#tour').isVisible()), 'no tour the second time');
  await B.p.click('.tab[data-v="people"]'); await wait(500);
  ok(/Daniel Mensah/.test(await B.p.textContent('#main')) && /Grace Owusu/.test(await B.p.textContent('#main')), 'everyone is there on the second phone');
  await addContact(B.p, 'Sam Lee', '07700900333'); await waitSaved(B.p);
  await A.p.evaluate(() => window.SHEPHERD_WEB.pull()); await wait(800);
  await A.p.click('.tab[data-v="people"]'); await wait(400);
  ok(/Sam Lee/.test(await A.p.textContent('#main')), 'a contact added on the Android phone appears on the iPhone');
  await B.p.click('.tab[data-v="events"]'); await wait(400); await B.p.click('[data-act="calguide"]'); await wait(500);
  const firstOs = await B.p.getAttribute('#calConnect .osb', 'data-os');
  ok(firstOs === 'android', 'on Android the Android steps come first');
  await B.p.evaluate(() => document.querySelector('#sheet [data-act="closesheet"]').click()); await wait(400);

  current = 'Fits every phone';
  for (const [wd, ht] of [[320, 568], [375, 667], [390, 844], [430, 932]]) {
    await A.p.setViewportSize({ width: wd, height: ht });
    const bad = [];
    for (const v of ['today', 'people', 'disciples', 'events', 'week']) { await A.p.click('.tab[data-v="' + v + '"]'); await wait(250); if (await overflow(A.p) > 0) bad.push(v); }
    await A.p.click('[data-act="settings"]'); await wait(300); if (await overflow(A.p) > 0) bad.push('settings');
    await A.p.click('#notifCard [data-act="notifguide"]'); await wait(500); if (await overflow(A.p) > 0) bad.push('notifguide');
    if (wd === 320 || wd === 430) await A.p.screenshot({ path: path.join(OUT, 'notif-' + wd + '.png') });
    await A.p.evaluate(() => document.querySelector('#sheet [data-act="closesheet"]').click()); await wait(400);
    await A.p.click('.tab[data-v="today"]'); await wait(300);
    if (wd === 320 || wd === 430) await A.p.screenshot({ path: path.join(OUT, 'today-' + wd + '.png') });
    ok(!bad.length, wd + 'px wide: nothing spills sideways' + (bad.length ? ' (' + bad.join(', ') + ')' : ''));
  }
  await A.p.setViewportSize({ width: 390, height: 844 });

  current = 'Forgot password';
  const C = await phone(IPHONE);
  await C.p.goto(APP); await wait(600);
  await C.p.click('[data-auth="signin"]'); await wait(200); await C.p.click('[data-auth="forgot"]'); await wait(200);
  await C.p.fill('#aEmail', 'pavi@church.test'); await C.p.click('#aGo'); await wait(1000);
  ok(/Ask the person who runs Shepherd/.test(await C.p.textContent('#auth')) && await C.p.locator('#aCode').isVisible(), 'asks for a reset code from the church\'s Shepherd admin');
  const adm = await (await realFetch(API + '/admin', { method: 'POST', body: new URLSearchParams({ admin: 'admin-key-e2e', email: 'pavi@church.test' }) })).text();
  const code = (/(\d{6})<\/b>/.exec(adm) || [])[1];
  await C.p.fill('#aCode', code); await C.p.fill('#aPw', 'new password 22'); await C.p.click('#aGo'); await wait(2500);
  ok(!(await C.p.locator('#auth').isVisible()), 'new password set and signed in');
  await C.p.click('.tab[data-v="people"]'); await wait(800);
  ok(/Daniel Mensah/.test(await C.p.textContent('#main')), 'all contacts still there');
  await A.p.evaluate(() => window.SHEPHERD_WEB.pull()); await wait(800);
  ok(await A.p.locator('#auth').isVisible(), 'other phones are asked to sign in again after a reset');
  await A.p.fill('#aEmail', 'pavi@church.test'); await A.p.fill('#aPw', 'new password 22'); await A.p.click('#aGo'); await wait(2500);
  await A.p.click('.tab[data-v="people"]'); await wait(400);
  ok(!(await A.p.locator('#auth').isVisible()) && /Daniel/.test(await A.p.textContent('#main')), 'and get straight back in, with nothing lost');

  current = 'Sign out and privacy';
  await C.p.click('[data-act="settings"]'); await wait(500);
  ok(/pavi@church\.test/.test(await C.p.textContent('#acctCard')), 'Settings shows who is signed in');
  await C.p.click('[data-act="signout"]'); await wait(500); await C.p.click('#soGo'); await wait(2000);
  ok(await C.p.locator('#auth').isVisible(), 'signed out');
  const left = await C.p.evaluate(() => Object.keys(localStorage).filter(k => /mirror|shepherd:v1|token/.test(k)));
  ok(left.length === 0, 'nothing of Pavi\'s list is left on that phone');
  await C.p.click('[data-auth="create"]'); await wait(200);
  await C.p.fill('#aName', 'Ama'); await C.p.fill('#aEmail', 'ama@church.test'); await C.p.fill('#aPw', 'ama password 1'); await C.p.fill('#aInvite', 'GRACE-2026'); await C.p.check('#aAgree'); await C.p.click('#aGo'); await wait(2500);
  await skipTour(C.p);
  await C.p.click('.tab[data-v="people"]'); await wait(500);
  ok(!/Daniel|Grace|Sam/.test(await C.p.textContent('#main')), 'someone else signing in on the same phone sees only their own (empty) list');

  current = 'Privacy page';
  {
    const P = await phone(IPHONE, 320, 568);
    await P.p.goto(APP + 'privacy.html'); await wait(900);
    const hs = await P.p.$$eval('#pv h3', h => h.length);
    const txt = await P.p.textContent('body');
    ok(hs === 7 && /Acceptable use/.test(txt) && /responsible for the people/.test(txt) && /passcode/.test(txt) && /email 8pavii@gmail\.com/.test(txt), 'privacy.html opens on its own with all 7 sections');
    ok(await overflow(P.p) <= 0, 'privacy page fits a small phone');
    await P.p.screenshot({ path: path.join(OUT, 'privacy-320.png'), fullPage: true });
    await P.p.evaluate(() => localStorage.setItem('shepherd:lang', 'es')); await P.p.reload(); await wait(1500);
    ok(/Normas de uso/.test(await P.p.textContent('body')), 'and shows in the language you chose: Spanish');
    await P.ctx.close();
  }

  current = 'Offline';
  await B.p.evaluate(() => window.SHEPHERD_WEB.pull()); await wait(800);
  ok(await B.p.locator('#auth').isVisible(), 'the Android phone was signed out by the reset too');
  await B.p.fill('#aEmail', 'pavi@church.test'); await B.p.fill('#aPw', 'new password 22'); await B.p.click('#aGo'); await wait(2500);
  await B.ctx.setOffline(true);
  await B.p.click('.tab[data-v="today"]'); await wait(300);
  await addContact(B.p, 'Offline Olive', '07700900444'); await wait(500);
  ok(/Offline|Saving/.test(await B.p.textContent('#sync')), 'adding with no signal says it will sync');
  await B.p.reload(); await wait(1500);
  ok(/Offline Olive/.test(await B.p.textContent('#main')), 'reopens with no signal, with the new contact');
  await B.ctx.setOffline(false); await B.p.evaluate(() => window.dispatchEvent(new Event('online'))); await wait(2500);
  ok(/Saved/.test(await B.p.textContent('#sync')), 'top bar goes back to Saved');
  ok(db("SELECT COUNT(*) FROM docs WHERE data LIKE '%Offline Olive%'")[0][0] === 1, 'the offline contact reaches the server once back online');

  current = 'Tour fits every phone';
  for (const [wd, ht, n] of [[320, 568, 1], [375, 667, 2], [390, 844, 3], [430, 932, 4]]) {
    const T = await phone(IPHONE, wd, ht);
    await T.p.goto(APP); await wait(600);
    await T.p.fill('#aName', 'Tour ' + n); await T.p.fill('#aEmail', 'tour' + n + '@church.test'); await T.p.fill('#aPw', 'tour password ' + n); await T.p.fill('#aInvite', 'GRACE-2026'); await T.p.check('#aAgree');
    await T.p.click('#aGo'); await wait(2500);
    const bad = []; let steps = 0, numberSaved = false, calOk = false, reloadOk = false;
    for (let i = 0; i < 24; i++) {
      if (!(await T.p.locator('#tour').isVisible())) break;
      await wait(350);
      const title = await T.p.textContent('#tourTitle');
      const r = await T.p.evaluate(() => { const c = document.getElementById('tourCard').getBoundingClientRect(); const b = document.getElementById('tourNext').getBoundingClientRect(); return { t: c.top, b: c.bottom, h: innerHeight, nb: b.bottom, nt: b.top }; });
      if (r.t < 15.5 || r.b > r.h - 15.5 || r.nb > r.h - 15.5) bad.push(title + ' (' + Math.round(r.t) + '–' + Math.round(r.b) + ' of ' + r.h + ')');
      steps++;
      if (wd === 375 && /Disciples|Turn on notifications/.test(title)) await T.p.screenshot({ path: path.join(OUT, 'tour-' + title.replace(/\W+/g, '-') + '-' + wd + '.png') });
      if (title === 'Start in Settings') {
        await T.p.click('#tourMore'); await wait(400);
        await T.p.fill('#pPhone', '07585 524965'); await T.p.click('#tourPillGo'); await wait(2500);
        const pr = db("SELECT data FROM docs WHERE path = 'profile' AND uid = (SELECT id FROM users WHERE email = 'tour" + n + "@church.test')");
        numberSaved = pr.length && JSON.parse(pr[0][0]).phone === '07585 524965';
        continue;
      }
      if (title === 'Your calendar') {
        await T.p.click('#tourMore'); await wait(600);
        await T.p.evaluate(() => document.addEventListener('click', e => { const a = e.target.closest('a[href^="webcal:"]'); if (a) e.preventDefault(); }, true));
        await T.p.click('[data-act="calconnect"]'); await wait(1200);
        await T.p.click('#sheetBody [data-act="closesheet"]'); await wait(700);
        calOk = await T.p.locator('#tour').isVisible() && (await T.p.textContent('#tourTitle')) === 'Your calendar';
        await T.p.reload(); await wait(2500);
        reloadOk = await T.p.locator('#tour').isVisible() && (await T.p.textContent('#tourTitle')) === 'Your calendar';
      }
      await T.p.click('#tourNext'); await wait(300);
    }
    ok(steps === 16 && !bad.length, wd + 'x' + ht + ': all 16 tour cards sit fully on screen with room to spare' + (bad.length ? ': ' + bad.join(', ') : ' (' + steps + ' steps)'));
    if (n === 1) {
      ok(numberSaved, 'typing your number and tapping Continue tour saves it');
      ok(calOk, 'after connecting the calendar, closing the guide goes back to the tour');
      ok(reloadOk, 'if the app reloads mid-tour, it picks up at the same step');
    }
    await T.ctx.close();
  }

  current = 'Languages';
  {
    await A.p.click('.tab[data-v="today"]'); await wait(300);
    await A.p.click('[data-act="settings"]'); await wait(500);
    const opts = await A.p.$$eval('#pLang option', o => o.map(x => x.value + ':' + x.textContent));
    ok(opts.length === 15 && opts[0] === 'en:English' && opts.includes('ig:Igbo') && opts.includes('zh-Hant:中文（繁體・香港／台灣）') && !opts.some(o => o.startsWith('ur')), 'Settings lists 15 languages, each written in its own language');
    await Promise.all([A.p.waitForNavigation({ timeout: 8000 }).catch(() => null), A.p.selectOption('#pLang', 'es')]);
    await wait(1800);
    const tabs = await A.p.$$eval('.tab', t => t.map(x => x.textContent.trim().replace(/\d+$/, '')).join('|'));
    ok(/^Hoy\|Personas\|Discípulos\|Calendario\|Semana/.test(tabs), 'choosing Español turns the app Spanish: ' + tabs);
    ok(await A.p.evaluate(() => document.documentElement.lang === 'es' && !!localStorage.getItem('shepherd:langpack:es')), 'the Spanish words were fetched once and kept on the phone');
    ok(JSON.parse(db("SELECT data FROM docs WHERE path = 'profile'")[0][0]).lang === 'es', 'the choice is saved to the account');
    await A.p.screenshot({ path: path.join(OUT, 'today-es.png') });
    await wait(3500);
    const es = db("SELECT title, body FROM outbox WHERE sent = 0 ORDER BY at").map(r => r[0]);
    ok(es.includes('Escribir a Grace') && !es.some(t => /^(Message|Reply to|Did) /.test(t)), 'notifications are now written in Spanish: ' + es.slice(0, 3).join(' | '));
    await A.p.click('[data-act="settings"]'); await wait(500); delivered.length = 0;
    if (await A.p.locator('#notifCard [data-act="pushtest"]').isVisible()) { await A.p.click('#notifCard [data-act="pushtest"]'); await wait(1200); }
    else { await A.p.click('#notifCard [data-act="pushon"]'); await wait(1500); await A.p.click('#notifCard [data-act="pushtest"]'); await wait(1200); }
    ok(delivered.some(d => d.title === 'Las notificaciones de Shepherd están activadas'), 'the test notification is in Spanish too');
    const D = await phone(ANDROID, 360, 780);
    await D.p.goto(APP); await wait(600);
    await D.p.click('[data-auth="signin"]'); await wait(200);
    await D.p.fill('#aEmail', 'pavi@church.test'); await D.p.fill('#aPw', 'new password 22');
    await Promise.all([D.p.waitForNavigation({ timeout: 10000 }).catch(() => null), D.p.click('#aGo')]);
    await wait(2500);
    const dTabs = await D.p.$$eval('.tab', t => t.map(x => x.textContent.trim().replace(/\d+$/, '')).join('|')).catch(() => '');
    ok(/^Hoy\|Personas/.test(dTabs), 'a new phone signing in picks up Spanish by itself');
    await D.ctx.setOffline(true); await D.p.reload(); await wait(1500);
    const offTabs = await D.p.$$eval('.tab', t => t.map(x => x.textContent.trim().replace(/\d+$/, '')).join('|')).catch(() => '');
    ok(/^Hoy\|Personas/.test(offTabs), 'and stays Spanish with no signal');
    await D.ctx.close();
    await A.p.click('[data-act="settings"]'); await wait(400);
    await Promise.all([A.p.waitForNavigation({ timeout: 8000 }).catch(() => null), A.p.selectOption('#pLang', 'en')]);
    await wait(1800);
    ok(/^Today\|People/.test(await A.p.$$eval('.tab', t => t.map(x => x.textContent.trim().replace(/\d+$/, '')).join('|'))), 'and back to English');
  }

  current = 'Two phones editing the same person';
  {
    const E = await phone(ANDROID, 360, 780);
    await E.p.goto(APP); await wait(600);
    await E.p.click('[data-auth="signin"]'); await wait(200);
    await E.p.fill('#aEmail', 'pavi@church.test'); await E.p.fill('#aPw', 'new password 22'); await E.p.click('#aGo'); await wait(2500);
    await A.p.evaluate(() => window.SHEPHERD_WEB.pull()); await wait(800);
    const gid = db("SELECT path FROM docs WHERE data LIKE '%Grace Owusu%'")[0][0].split('/').pop();
    await A.ctx.setOffline(true); await E.ctx.setOffline(true);
    await A.p.evaluate(id => { const S = window.__shepherd.S; const c = JSON.parse(JSON.stringify(S.contacts[id])); c.notes = 'Note written on phone A'; window.__shepherd.saveContact(c); }, gid);
    await wait(300);
    await E.p.evaluate(id => { const S = window.__shepherd.S; const c = JSON.parse(JSON.stringify(S.contacts[id])); c.stage = 'Interested'; window.__shepherd.saveContact(c); }, gid);
    await wait(300);
    await E.ctx.setOffline(false); await E.p.evaluate(() => window.dispatchEvent(new Event('online'))); await wait(2500);
    await A.ctx.setOffline(false); await A.p.evaluate(() => window.dispatchEvent(new Event('online'))); await wait(3000);
    const g = JSON.parse(db("SELECT data FROM docs WHERE path LIKE '%/" + gid + "'")[0][0]);
    ok(g.notes === 'Note written on phone A' && g.stage === 'Interested', 'two phones offline, each changing Grace: both changes reach the server (' + (g.notes || '(empty)') + ' / ' + g.stage + ')');
    await A.p.evaluate(() => window.SHEPHERD_WEB.pull()); await wait(1200);
    const onA = await A.p.evaluate(id => { const c = window.__shepherd.S.contacts[id]; return c.notes + ' / ' + c.stage; }, gid);
    ok(onA === 'Note written on phone A / Interested', 'and phone A shows both: ' + onA);
    await E.ctx.close();
  }

  current = 'Nothing loaded from other websites';
  ok(outside.length === 0, 'fonts and the QR code tool come from Shepherd itself: no requests to Google or other sites' + (outside.length ? ' (' + [...new Set(outside.map(u => new URL(u).host))].join(', ') + ')' : ''));

  current = 'Script errors';
  ok(errors.length === 0, 'no script errors' + (errors.length ? ': ' + errors.slice(0, 4).join(' / ') : ''));
} catch (e) { console.log('CRASH', e && e.stack || e); results.push({ ok: false, m: 'crash' }); }
await browser.close(); site.close(); api.close();
const pass = results.filter(r => r.ok).length;
if (process.env.I18N_COLLECT) (await import('fs')).writeFileSync(process.env.I18N_COLLECT + '.e2e.json', JSON.stringify([...I18N_SINK], null, 1));
console.log('\nEnd-to-end: ' + pass + ' passed, ' + (results.length - pass) + ' failed');
process.exit(results.length === pass ? 0 : 1);
