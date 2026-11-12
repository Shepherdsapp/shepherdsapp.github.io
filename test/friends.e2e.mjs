// End-to-end, several phones at once: friends, churches, shared Encourage plans, one-tap join, who gets told,
// the under-18 (CAMPUS) safeguards and the private budget tank. Real Worker code, stand-in database.
// Run: node test/friends.e2e.mjs   (uses ports 8133 and 8134)
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
const APP = 'http://localhost:8133/shepherd/', API = 'http://localhost:8134';
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
}).listen(8133);

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

const env = { DB: await makeD1(), ALLOWED_ORIGINS: 'http://localhost:8133', ADMIN_KEY: 'admin-key-e2e', APP_URL: APP, OWNER_EMAIL: 'pavi@church.test', GMAIL_USER: 'lostshepherdapp@gmail.com', GMAIL_APP_PASSWORD: 'test app password', __connect: connect };
let oldServer = false; // pretend the server hasn't been updated yet
const background = [];
const api = http.createServer(async (req, res) => {
  if (oldServer && req.method !== 'OPTIONS' && /^\/api\/(social|churches)/.test(req.url)) { res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'http://localhost:8133', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }); return res.end('{"error":"not_found","message":"Not found."}'); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await worker.fetch(new Request(API + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env, { waitUntil: p => background.push(Promise.resolve(p).catch(() => {})) });
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8134);
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
  /* ============ sign-up with a church ============ */
  current = 'Church at sign-up';
  const A = await phone('pavi', IPHONE), B = await phone('grace', ANDROID, 360, 780);
  await A.p.goto(APP); await wait(900);
  ok(await A.p.locator('#aChurchBox').isVisible() && /London ICC/.test(await text(A.p, '#aChurch')), 'sign-up offers a church list, with London ICC in it');
  ok(/13 or older/.test(await text(A.p, '#aChurchBox')) && await A.p.locator('#aMinor').count() === 1, 'and an "I\'m under 18" tick that says you must be 13 or older');
  ok(await overflow(A.p) <= 0, 'the sign-up screen still fits the phone');
  await shot(A, 'signup');
  await signUp(A, 'Pavi Kumar', 'pavi@church.test', { church: 'c_london_icc' });
  await signUp(B, 'Grace Owusu', 'grace@church.test', { church: 'c_london_icc' });
  const PA = uidOf('pavi@church.test'), GB = uidOf('grace@church.test');
  ok(db("SELECT church, minor, ok FROM social WHERE uid = '" + PA + "'")[0].join() === 'c_london_icc,0,1', 'the church chosen at sign-up is saved with the account');
  await tab(A.p, 'encourage'); await wait(500);
  ok(await A.p.locator('#tabFriends').isVisible(), 'there is a Friends tab');
  ok(await A.p.locator('#tankCard').isVisible() && /Only you see this/.test(await text(A.p, '#tankCard')), 'and a private budget tank');
  ok(await overflow(A.p) <= 0 && await overflow(B.p) <= 0, 'Encourage fits both phones');
  await shot(A, 'encourage-empty');
  await tab(A.p, 'friends'); await wait(600);
  ok(/London ICC/.test(await text(A.p, '#churchCard')) && !/CAMPUS/.test(await text(A.p, '#churchCard')), 'Settings shows "Your church: London ICC"');
  ok(await A.p.locator('#ownerCard').isVisible() && /Nobody is waiting/.test(await text(A.p, '#ownerCard')), 'the person who runs Shepherd also sees Approvals');
  await tab(B.p, 'friends'); await wait(600);
  ok(await B.p.locator('#churchCard').isVisible() && !(await B.p.locator('#ownerCard').count()), 'nobody else sees Approvals');
  await pushOn(A); await pushOn(B);
  ok(db('SELECT COUNT(*) FROM subs')[0][0] === 2, 'both phones have notifications on');

  /* ============ friend request ============ */
  current = 'Adding a friend';
  await openFriends(A.p);
  { const t = await text(A.p, '#main');
    ok(/Friends only see the plans you share/.test(t) && /never see your People, Disciples, prayer list, notes, phone numbers or budget/.test(t), 'the Friends screen says exactly what friends can and can\'t see');
    ok(/People from my church/.test(t) && /Grace O\./.test(t) && !/Owusu/.test(t) && !/grace@church/.test(t), 'people from my church show as first name and initial only: "Grace O."');
    ok(/Your friend code/.test(t) && (await soc(A.p)).me.code.length >= 6, 'and my own friend code is there to share'); }
  await shot(A, 'friends-sheet');
  ok(await overflow(A.p) <= 0, 'the Friends screen fits the phone');
  delivered.length = 0;
  await A.p.click('#frPeople [data-fr="add"]'); await wait(900); await settle();
  ok(/Request sent/.test(await text(A.p, '#frPeople')), 'one tap on Add friend sends a request');
  ok(told('grace').length === 1 && /Friend request from Pavi K\./.test(told('grace')[0]) && told('pavi').length === 0, 'Grace gets one notification about it: ' + told('grace')[0]);
  await refresh(B.p); await tab(B.p, 'encourage');
  ok(/1/.test(await text(B.p, '#frBadge')), 'Grace sees a badge on her Friends tab');
  await tab(B.p, 'friends'); await wait(700);
  ok(/Friend requests/.test(await text(B.p, '#main')) && /Pavi K\./.test(await text(B.p, '#main')), 'and the request, with Accept and Decline');
  delivered.length = 0;
  await B.p.click('[data-fr="accept"]'); await wait(900); await settle();
  ok(/Your friends/.test(await text(B.p, '#main')) && (await soc(B.p)).me.friends.length === 1 && (await soc(B.p)).me.friends[0].name === 'Pavi Kumar', 'Accept makes them friends');
  ok(told('pavi').length === 1 && /Grace Owusu accepted/.test(told('pavi')[0]), 'and Pavi is told: ' + told('pavi')[0]);
  await refresh(A.p); await closeSheet(A.p); await closeSheet(B.p);
  ok((await soc(A.p)).me.friends.length === 1, 'Pavi now has Grace as a friend');

  /* ============ budget tank ============ */
  current = 'Budget tank';
  await tab(A.p, 'encourage');
  await eshot(A, '#tankCard', 'tankcard-unset');
  // news arriving from a friend must not wipe what you are half-way through typing
  await B.p.evaluate(() => { const t = new Date(Date.now() + 2 * 864e5), d = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'); window.__shepherd.saveEvent({ id: 'tmpplan', kind: 'enc', type: 'hangout', who: '', share: 'friends', pay: 'own', date: d, time: '', activity: 'Temporary plan', place: '', food: false, cost: '', name: 'Temporary plan', createdAt: Date.now() }); });
  await wait(2800);
  await A.p.click('#bAmt'); await A.p.keyboard.type('33'); await refresh(A.p);
  ok(await A.p.inputValue('#bAmt') === '33' && (await soc(A.p)).feed.some(f => f.title === 'Temporary plan'), 'a friend\'s new plan arriving doesn\'t wipe a half-typed budget');
  await A.p.evaluate(() => document.activeElement && document.activeElement.blur()); await wait(900);
  ok(/Temporary plan/.test(await text(A.p, '#main')), 'and it shows as soon as you stop typing');
  await B.p.evaluate(() => { const W = window.__shepherd; const e = W.S.events.tmpplan; e.share = 'me'; W.saveEvent(e); }); await wait(2800); await refresh(A.p);
  ok(!/Temporary plan/.test(await text(A.p, '#main')), 'a plan switched back to "Just me" disappears for friends');
  await A.p.fill('#bAmt', '0'); await A.p.$eval('#budgetForm', f => f.requestSubmit()); await wait(200);
  ok(/as a number, like 40/.test(await text(A.p, '#bErr')), 'a budget of 0 is explained, not saved');
  await A.p.fill('#bAmt', '40'); await A.p.$eval('#budgetForm', f => f.requestSubmit()); await wait(450); await eshot(A, '#tankCard', 'tankcard-filling'); await wait(1600);
  { const t = await text(A.p, '#tankCard'); const y = await A.p.$eval('#tankFuel', e => [e.dataset.y, e.style.transform].join('|'));
    ok(/£40\.00|£40/.test(t) && /left this month/.test(t), 'a £40 budget shows £40 left this month');
    ok(y === '0|translateY(0px)', 'and the tank fills to the top (' + y + ')'); }
  await eshot(A, '#tankCard', 'tankcard-full');

  /* ============ sharing a plan ============ */
  current = 'Sharing a plan';
  delivered.length = 0; let leaves = '';
  await newPlan(A.p, { type: 'hangout', share: true, date: soon, time: '18:30', activity: 'Bowling night', place: 'Hollywood Bowl, O2', food: true, cost: 20, pay: 'split', peek: async p => { await shot(A, 'plan-form'); leaves = await text(p, '#enLeaves'); ok(/Friends see what it is, when, where, food, cost and who's going/.test(await text(p, '#enShareNote')), 'choosing Friends explains what they will see'); ok(await overflow(p) <= 0, 'the plan form fits the phone'); } });
  if (sameMonth) ok(/This leaves £20(\.00)? in your budget/.test(leaves), 'while planning: "' + leaves.trim() + '"');
  await wait(2800); await settle();
  ok(told('grace').length === 1 && /Pavi Kumar/.test(told('grace')[0]) && /Bowling night/.test(told('grace')[0]), 'friends are told once when a plan is shared: ' + told('grace')[0]);
  ok(told('pavi').length === 0, 'the host isn\'t notified about their own plan');
  await refresh(B.p); await tab(B.p, 'encourage');
  { const t = await text(B.p, '#feedSec');
    ok(/Friends' plans/.test(t) && /Bowling night/.test(t) && /Hollywood Bowl/.test(t) && /With Pavi Kumar/.test(t), 'Grace sees it under Friends\' plans');
    ok(/£5–£15/.test(t) && /Food/.test(t), 'with a price tag (£5–£15) and the food tag'); }
  await shot(B, 'feed');
  await B.p.click('#feedSec .pcard-main'); await wait(500);
  { const t = (await text(B.p, '#sheetBody')).replace(/\s+/g, ' ');
    ok(/What.*Bowling night.*Hangout/.test(t) && /When/.test(t) && /Where.*Hollywood Bowl, O2/.test(t) && /Food.*Yes/.test(t) && /Host.*Pavi Kumar/.test(t) && /Who's going.*Nobody yet/.test(t), 'tapping it shows the whole plan before joining: what, when, where, food, host and who\'s going');
    ok(/£20(\.00)? split equally: about £10(\.00)? each if you join/.test(t), 'and the cost with who pays: "' + (t.match(/Cost(.*?)Host/) || [])[1] + '"'); }
  await shot(B, 'plan-detail');
  ok(await overflow(B.p) <= 0, 'the plan screen fits a small phone');
  { const feed = JSON.stringify((await soc(B.p)).feed);
    ok(!/budget|contacts|prayers|phone|notes/i.test(feed), 'nothing else about Pavi comes down to Grace\'s phone: no budget, people, notes or numbers'); }

  /* ============ one-tap join ============ */
  current = 'Joining';
  delivered.length = 0;
  await closeSheet(B.p);
  await B.p.click('#feedSec .jbtn'); await wait(1200); await settle();
  ok(/Going/.test(await text(B.p, '#feedSec .jbtn')) && (await soc(B.p)).feed[0].joined === true, 'one tap on Join and Grace is going');
  ok(told('pavi').length === 1 && /Grace Owusu is going/.test(told('pavi')[0]) && told('grace').length === 0, 'only the host is told (nobody else is going yet): ' + told('pavi')[0]);
  ok(/Coming up/.test(await text(B.p, '#main')) && await B.p.locator('#main .sec .pcard.joined').count() >= 1, 'the plan is now in Grace\'s own Encourage list');
  await wait(3200);
  { const rows = db("SELECT tag, title FROM outbox WHERE uid = '" + GB + "' AND sent = 0").filter(r => /^j[01]-/.test(r[0]));
    ok(rows.length >= 1 && rows.every(r => /Bowling night/.test(r[1])), 'and Shepherd will remind her before it: ' + rows.map(r => r[1]).join(' / ')); }
  await refresh(A.p); await tab(A.p, 'encourage');
  ok(/1 going/.test(await text(A.p, '#main')) && /Shared with friends/.test(await text(A.p, '#main')), 'Pavi\'s plan shows "Shared with friends" and "1 going"');
  if (sameMonth) { const st = await A.p.evaluate(() => window.__shepherd.budgetState());
    ok(st.spent === 10 && st.left === 30 && Math.abs(st.level - 0.75) < 0.001, 'split between two, Pavi\'s share is £10, so the tank shows £30 left (three-quarters full)');
    await wait(1700);
    ok(await A.p.$eval('#tankFuel', e => e.dataset.y) === '26', 'and the fuel has drained to match'); }
  await eshot(A, '#tankCard', 'tankcard-used');
  await tab(B.p, 'encourage');
  await B.p.fill('#bAmt', '12'); await B.p.$eval('#budgetForm', f => f.requestSubmit()); await wait(600);
  if (sameMonth) { const st = await B.p.evaluate(() => window.__shepherd.budgetState());
    ok(st.spent === 10 && st.used === 83, 'Grace\'s own tank counts her £10 share of the plan she joined');
    ok(/used 83% of this month/.test(await text(B.p, '#tankCard')), 'and warns her at 80%: "You\'ve used 83% of this month\'s budget."'); }
  await wait(1600); await eshot(B, '#tankCard', 'tankcard-low');
  await B.p.evaluate(() => { const s = window.__shepherd.S; s.profile.budget = 8; window.__shepherd.render(); }); await wait(1700); await eshot(B, '#tankCard', 'tankcard-over');
  if (sameMonth) ok(/over budget this month/.test(await text(B.p, '#tankCard')) && /Your tank is empty/.test(await text(B.p, '#tankCard')), 'over budget: the tank is empty and says so kindly');
  await B.p.evaluate(() => { const s = window.__shepherd.S; s.profile.budget = 12; window.__shepherd.render(); }); await wait(300);
  ok(!/budget/i.test(JSON.stringify(db("SELECT * FROM social"))) && !/"budget"/.test(JSON.stringify((await soc(A.p)).feed)), 'budgets never appear in anything friends can load');

  /* ============ a third friend: who gets told ============ */
  current = 'Who gets told';
  const C = await phone('tobi', ANDROID, 412, 915);
  await signUp(C, 'Tobi Adeyemi', 'tobi@church.test', { church: '' });
  ok((await soc(C.p)).me.church === null && await C.p.locator('.tab[data-v="encourage"]').count() === 1, 'someone who picks "Choose later" still gets an account');
  await pushOn(C);
  await openFriends(C.p);
  ok(/Choose your church to see people from it/.test(await text(C.p, '#main')), 'with no church, the Friends screen offers to choose one');
  await C.p.fill('#frTo', 'PAVI@church.test'); await C.p.$eval('#frForm', f => f.requestSubmit()); await wait(900);
  ok(/If they use Shepherd/.test(await text(C.p, '#toastMsg')), 'adding by email gives the same answer whether or not the person exists');
  await C.p.fill('#frTo', 'nobody@nowhere.test'); await C.p.$eval('#frForm', f => f.requestSubmit()); await wait(900);
  ok(/If they use Shepherd/.test(await text(C.p, '#toastMsg')) && (await soc(C.p)).me.outgoing.length === 1, 'so nobody can use it to check who has an account');
  await refresh(A.p); await openFriends(A.p);
  await A.p.click('[data-fr="accept"]'); await wait(900);
  // Tobi adds Grace with her friend code
  const graceCode = (await soc(B.p)).me.code;
  await refresh(C.p); await C.p.fill('#frTo', graceCode.toLowerCase()); await C.p.$eval('#frForm', f => f.requestSubmit()); await wait(900);
  await refresh(B.p); await openFriends(B.p); await B.p.click('[data-fr="accept"]'); await wait(900);
  await refresh(C.p); await closeSheet(C.p); await closeSheet(A.p); await closeSheet(B.p);
  ok((await soc(C.p)).me.friends.length === 2, 'a friend code works too (typed in lower case)');
  await tab(C.p, 'encourage');
  ok(/Bowling night/.test(await text(C.p, '#feedSec')) && /1 going/.test(await text(C.p, '#feedSec')), 'a new friend sees plans that were already shared');
  await C.p.click('#feedSec .pcard-main'); await wait(500);
  ok(/Who's going.*Grace O/.test((await text(C.p, '#sheetBody')).replace(/\s+/g, ' ')), 'and who\'s going');
  delivered.length = 0;
  await C.p.click('#sheetBody [data-act="joinplan"]'); await wait(1300); await settle();
  ok(/You're going/.test(await text(C.p, '#sheetBody')), 'joining from the plan screen works too');
  ok(told('pavi').length === 1 && told('grace').length === 1 && told('tobi').length === 0 && /Tobi/.test(told('grace')[0]), 'now the host and the person already going are told, and nobody else: ' + told('grace')[0]);
  await closeSheet(C.p);

  /* ============ changes, leaving, cancelling ============ */
  current = 'Changes';
  delivered.length = 0;
  await refresh(A.p); await tab(A.p, 'encourage');
  await A.p.click('#main .enc[data-act="openenc"]'); await wait(500);
  ok(/Going: Grace O(wusu|\.), Tobi A(deyemi|\.)/.test(await text(A.p, '#sheetBody')), 'the host sees who\'s going when editing');
  await A.p.fill('#enTime', '19:00'); await A.p.$eval('#enForm', f => f.requestSubmit()); await wait(3000); await settle();
  ok(told('grace').length === 1 && told('tobi').length === 1 && /changed/.test(told('grace')[0]) && told('pavi').length === 0, 'when the time changes, the people going are told: ' + told('grace')[0]);
  delivered.length = 0;
  await refresh(C.p); await tab(C.p, 'encourage');
  await C.p.click('#feedSec .jbtn.on'); await wait(1200); await settle();
  ok(!(await C.p.locator('#feedSec .jbtn.on').count()) && (await soc(C.p)).feed[0].joined === false, 'tapping Going again leaves the plan');
  ok(told('pavi').length === 1 && /can't make|no longer|isn't going|not going/i.test(told('pavi')[0]) && told('grace').length === 0, 'only the host hears about it: ' + told('pavi')[0]);
  await refresh(B.p); await tab(B.p, 'encourage');
  await B.p.click('#feedSec [data-f="free"]'); await wait(300);
  ok(/No free plans right now/.test(await text(B.p, '#feedSec')), '"Free only" hides plans that cost money');
  await B.p.click('#feedSec [data-f=""]'); await wait(300);
  delivered.length = 0;
  await newPlan(A.p, { type: 'date', share: true, date: soon, activity: 'Walk in Greenwich Park', cost: 0 }); await wait(2800); await settle();
  await refresh(B.p); await tab(B.p, 'encourage'); await B.p.click('#feedSec [data-f="free"]'); await wait(300);
  ok(/Walk in Greenwich Park/.test(await text(B.p, '#feedSec')) && !/Bowling/.test(await text(B.p, '#feedSec')) && /Free/.test(await text(B.p, '#feedSec .pcard .tags')), 'and shows the free ones');
  await B.p.click('#feedSec [data-f=""]'); await wait(300);
  delivered.length = 0;
  await tab(A.p, 'encourage');
  await A.p.locator('#main .enc[data-act="openenc"]', { hasText: 'Bowling night' }).first().click(); await wait(500);
  await A.p.click('#enDel'); await wait(200);
  ok(/people going will be told/.test(await text(A.p, '#enDel')), 'deleting a plan people have joined warns that they\'ll be told');
  await A.p.click('#enDel'); await wait(3000); await settle();
  ok(told('grace').length === 1 && /cancelled/i.test(told('grace')[0]) && told('tobi').length === 0, 'the person still going is told it\'s cancelled, the one who left isn\'t: ' + told('grace')[0]);
  await refresh(B.p); await tab(B.p, 'encourage');
  ok(!/Bowling night/.test(await text(B.p, '#main')), 'and it disappears from her Encourage tab');

  /* ============ under-18 (CAMPUS) safeguards ============ */
  current = 'Under-18 safeguards';
  const T = await phone('sam', IPHONE, 375, 667);
  mails.length = 0; delivered.length = 0;
  await signUp(T, 'Sam Teen', 'sam@church.test', { church: 'c_london_icc', minor: true }); await settle();
  const ST = uidOf('sam@church.test');
  ok(db("SELECT minor, ok FROM social WHERE uid = '" + ST + "'")[0].join() === '1,0', 'ticking "I\'m under 18" marks the account as waiting');
  ok(mails.length === 1 && /To: <lostshepherdapp@gmail\.com>/.test(mails[0]) && /Sam Teen/.test(mailText(mails[0])) && /sam@church\.test/.test(mailText(mails[0])) && /London ICC \(CAMPUS\)/.test(mailText(mails[0])), 'the person who runs Shepherd is emailed at lostshepherdapp@gmail.com');
  ok(told('pavi').some(t => /waiting for approval/.test(t)), 'and gets a notification on their own phone');
  await tab(T.p, 'encourage');
  ok(await T.p.locator('#socWait').isVisible() && /Waiting for approval/.test(await text(T.p, '#socWait')) && !(await T.p.locator('#frBar').count()) && !(await T.p.locator('#feedSec').count()), 'until approved, Sam sees "Waiting for approval" and no friends or plans');
  await shot(T, 'campus-waiting');
  ok(await overflow(T.p) <= 0, 'fits the smallest iPhone');
  await T.p.click('[data-act="newenc"][data-t="date"]'); await wait(450);
  ok(!(await T.p.locator('#enShare').count()), 'and can\'t share a plan');
  await closeSheet(T.p);
  await tab(T.p, 'friends'); await wait(600);
  ok(/London ICC \(CAMPUS\)/.test(await text(T.p, '#churchCard')) && /waiting for approval/.test(await text(T.p, '#churchCard')), 'Settings shows "London ICC (CAMPUS)"');
  await refresh(B.p); await openFriends(B.p);
  ok(!/Sam/.test(await text(B.p, '#main')), 'under-18s are never listed under "People from my church"');
  await B.p.fill('#frTo', 'sam@church.test'); await B.p.$eval('#frForm', f => f.requestSubmit()); await wait(900);
  ok(db("SELECT COUNT(*) FROM friends WHERE a = '" + ST + "' OR b = '" + ST + "'")[0][0] === 0, 'an adult\'s friend request to an under-18 goes nowhere');
  await closeSheet(B.p);
  // the owner approves
  await refresh(A.p); await closeSheet(A.p); await tab(A.p, 'friends'); await wait(600);
  ok(/1 waiting for approval/.test(await text(A.p, '#ownerCard')), 'the owner\'s Settings shows 1 waiting');
  await A.p.click('[data-act="approvals"]'); await wait(800);
  ok(/Sam Teen/.test(await text(A.p, '#sheetBody')) && /sam@church\.test/.test(await text(A.p, '#sheetBody')) && /London ICC \(CAMPUS\)/.test(await text(A.p, '#sheetBody')), 'Approvals lists Sam with email and church');
  await shot(A, 'approvals');
  ok(await overflow(A.p) <= 0, 'the Approvals screen fits the phone');
  delivered.length = 0;
  await pushOn(T);
  await closeSheet(A.p); await tab(A.p, 'friends'); await wait(500); await A.p.click('[data-act="approvals"]'); await wait(800);
  await A.p.click('[data-ap="1"]'); await wait(1200); await settle();
  ok(db("SELECT ok FROM social WHERE uid = '" + ST + "'")[0][0] === 1 && /Nobody is waiting/.test(await text(A.p, '#sheetBody')), 'one tap approves');
  ok(told('sam').length === 1, 'and Sam is told: ' + told('sam')[0]);
  await closeSheet(A.p);
  await refresh(T.p); await tab(T.p, 'encourage');
  ok(await T.p.locator('#tabFriends').isVisible() && !(await T.p.locator('#socWait').count()), 'once approved, the waiting notice goes');
  await tab(T.p, 'friends'); await wait(700);
  ok(!/People from my church/.test(await text(T.p, '#main')) && /Add a friend/.test(await text(T.p, '#main')), 'but no church list: only people Sam adds by email or friend code');
  await T.p.fill('#frTo', 'pavi@church.test'); await T.p.$eval('#frForm', f => f.requestSubmit()); await wait(900);
  await refresh(A.p); await openFriends(A.p);
  ok(/Sam T\./.test(await text(A.p, '#main')) && /London ICC \(CAMPUS\)/.test(await text(A.p, '#main')), 'the adult sees the request marked "London ICC (CAMPUS)"');
  await A.p.click('[data-fr="accept"]'); await wait(900); await closeSheet(A.p); await closeSheet(T.p);
  await newPlan(A.p, { type: 'hangout', share: true, date: soon, activity: 'Pizza after church', place: 'Franco Manca', cost: 12, pay: 'own' }); await wait(2800); await settle();
  await refresh(T.p); await tab(T.p, 'encourage');
  { const t = await text(T.p, '#feedSec'); const f = (await soc(T.p)).feed.find(x => /Pizza/.test(x.title));
    ok(/Pizza after church/.test(t) && /£5–£15/.test(t), 'Sam sees the plan with a price tag');
    ok(f && f.cost === undefined && f.pay === undefined && f.band === 'm', 'but the exact cost and who pays are never sent to an under-18\'s phone');
    ok(f && f.needGroup === true && await T.p.locator('#feedSec .jbtn', { hasText: 'Join' }).first().isDisabled(), 'and can\'t join a plan with just one adult'); }
  await T.p.locator('#feedSec .pcard-main', { hasText: 'Pizza' }).click(); await wait(500);
  ok(/opens to you once someone else has joined, so there are 3 or more people/.test(await text(T.p, '#sheetBody')), 'the plan explains: 3 or more people');
  { const f = await T.p.evaluate(() => { const u = document.querySelector('#sheetBody .facts'), l = u.lastElementChild.getBoundingClientRect(), b = u.getBoundingClientRect(); return { rows: u.children.length, inside: l.bottom <= b.bottom + 1, last: u.lastElementChild.textContent }; });
    ok(f.rows === 7 && f.inside && /Who's going/.test(f.last), 'every row of the plan shows on the smallest iPhone, down to who\'s going'); }
  await shot(T, 'campus-plan');
  await closeSheet(T.p);
  await refresh(B.p); await tab(B.p, 'encourage');
  await B.p.locator('#feedSec .pcard', { hasText: 'Pizza' }).locator('.jbtn').click(); await wait(1200);
  await refresh(T.p); await tab(T.p, 'encourage');
  await T.p.locator('#feedSec .pcard', { hasText: 'Pizza' }).locator('.jbtn').click(); await wait(1200);
  ok((await soc(T.p)).feed.find(x => /Pizza/.test(x.title)).joined === true, 'once another person is going, Sam can join');
  await T.p.click('[data-act="newenc"][data-t="hangout"]'); await wait(450);
  ok(await T.p.locator('#enShare').count() === 1 && !(await T.p.locator('#enPayWrap').count()), 'an approved under-18 can share a plan, with no money-splitting options');
  await closeSheet(T.p);

  /* ============ another church, and near-duplicates ============ */
  current = 'Adding a church';
  await closeSheet(C.p); await tab(C.p, 'friends'); await wait(600);
  await C.p.click('#churchCard [data-act="church"]'); await wait(800);
  await C.p.selectOption('#chSel', '+'); await wait(200);
  await C.p.fill('#chNew', 'london icc'); await wait(300);
  ok(/Did you mean/.test(await text(C.p, '#chSug')) && /London ICC/.test(await text(C.p, '#chSug')), 'typing a church that\'s already there offers it: "Did you mean London ICC"');
  await shot(C, 'church-suggest');
  await C.p.fill('#chNew', 'Grace Community Church Leeds'); await wait(300);
  ok(!(await C.p.locator('#chSug button').count()), 'a different church gets no suggestion');
  await C.p.$eval('#chForm', f => f.requestSubmit()); await wait(1200);
  ok(db("SELECT COUNT(*) FROM churches")[0][0] === 2 && (await soc(C.p)).me.church.name === 'Grace Community Church Leeds', 'and is added straight away, no approval needed');
  const D = await phone('dee', ANDROID);
  await D.p.goto(APP); await wait(900);
  ok(/Grace Community Church Leeds/.test(await text(D.p, '#aChurch')), 'the next person to sign up finds it in the list');
  await D.ctx.close();
  await C.p.click('#churchCard [data-act="church"]'); await wait(800);
  await C.p.selectOption('#chSel', '+'); await C.p.fill('#chNew', 'The London International Christian Church'); await wait(200);
  await C.p.$eval('#chForm', f => f.requestSubmit()); await wait(1200);
  ok(db("SELECT COUNT(*) FROM churches")[0][0] === 2 && (await soc(C.p)).me.church.id === 'c_london_icc', 'even if someone ignores the suggestion, the same church isn\'t added twice');

  /* ============ remove, block, report ============ */
  current = 'Remove, block and report';
  mails.length = 0;
  await refresh(B.p); await tab(B.p, 'encourage');
  await B.p.locator('#feedSec .pcard-main', { hasText: 'Pizza' }).click(); await wait(500);
  await B.p.click('[data-act="reportplan"]'); await wait(500);
  await B.p.fill('#rpText', 'Test report: wrong place'); await B.p.$eval('#rpForm', f => f.requestSubmit()); await wait(1200); await settle();
  ok(/Report sent/.test(await text(B.p, '#toastMsg')) && db("SELECT text FROM reports")[0][0] === 'Test report: wrong place', 'a plan can be reported');
  ok(mails.length === 1 && /To: <lostshepherdapp@gmail\.com>/.test(mails[0]) && /wrong place/.test(mailText(mails[0])) && /Grace Owusu/.test(mailText(mails[0])), 'and the report is emailed to lostshepherdapp@gmail.com');
  await openFriends(B.p);
  await B.p.locator('[data-fr="more"][data-name="Tobi Adeyemi"]').click(); await wait(500);
  ok(/Removing or blocking is private/.test(await text(B.p, '#sheetBody')), 'each friend has Remove, Block and Report');
  await B.p.click('#faBlock'); await wait(1300);
  ok((await soc(B.p)).me.friends.length === 1 && (await soc(B.p)).me.blocked.length === 1 && /Blocked/.test(await text(B.p, '#main')), 'blocking removes the friendship and lists them under Blocked');
  await refresh(C.p);
  ok((await soc(C.p)).me.friends.every(f => f.name !== 'Grace Owusu'), 'and the other person just sees one friend fewer');
  await B.p.click('[data-fr="unblock"]'); await wait(1200);
  ok((await soc(B.p)).me.blocked.length === 0, 'unblocking works');
  await closeSheet(B.p);

  /* ============ no signal ============ */
  current = 'No signal';
  await refresh(B.p);
  await B.p.route('**/api/social/**', r => r.abort());
  await B.p.reload(); await wait(2800); await tab(B.p, 'encourage'); await wait(400);
  ok(await B.p.locator('#tabFriends').isVisible() && /Pizza after church/.test(await text(B.p, '#main')), 'with no signal, friends and their plans still show from the last time');
  await B.p.locator('#feedSec .pcard', { hasText: 'Walk in Greenwich' }).locator('.jbtn').click(); await wait(1200);
  ok(/No connection|Couldn't reach|signal/i.test(await text(B.p, '#toastMsg')) && (await soc(B.p)).feed.find(x => /Walk/.test(x.title)).joined === false, 'joining without signal says so plainly and changes nothing: "' + (await text(B.p, '#toastMsg')) + '"');
  await B.p.unroute('**/api/social/**'); await refresh(B.p);

  /* ============ an older server: everything else still works ============ */
  current = 'Before the server is updated';
  oldServer = true;
  const O = await phone('old', IPHONE);
  await O.p.goto(APP); await wait(900);
  ok(!(await O.p.locator('#aChurchBox').isVisible()), 'sign-up shows no church list');
  await O.p.click('[data-auth="signin"]'); await wait(200);
  await O.p.fill('#aEmail', 'pavi@church.test'); await O.p.fill('#aPw', 'correct horse 1'); await O.p.click('#aGo'); await wait(2800);
  await tab(O.p, 'encourage'); await wait(600);
  ok(!(await O.p.locator('#frBar').count()) && !(await O.p.locator('#feedSec').count()) && await O.p.locator('#tankCard').isVisible(), 'Encourage works, with the budget tank, and friends are simply hidden');
  ok(/Walk in Greenwich Park|Pizza after church/.test(await text(O.p, '#main')), 'plans already made are all still there');
  await O.p.click('[data-act="newenc"][data-t="date"]'); await wait(450);
  ok(!(await O.p.locator('#enShare').count()) && await O.p.locator('#enWho').isVisible(), 'the plan form has no sharing option');
  await closeSheet(O.p); await O.p.click('[data-act="settings"]'); await wait(600);
  ok(!(await O.p.locator('#churchCard').count()), 'and Settings has no church card');
  oldServer = false; await O.ctx.close();

  /* ============ deleting an account ============ */
  current = 'Leaving';
  ok(db("SELECT COUNT(*) FROM friends WHERE a = '" + ST + "' OR b = '" + ST + "'")[0][0] >= 1, '(Sam has a friend and a joined plan)');
  await T.p.evaluate(async () => { await window.SHEPHERD_WEB.api('POST', '/api/account/delete', { password: 'correct horse 1' }).catch(e => { window.__delErr = e.message; }); }); await wait(600);
  { const left = ['social', 'friends', 'joins'].map(t => db("SELECT COUNT(*) FROM " + t + " WHERE " + (t === 'friends' ? "a = '" + ST + "' OR b = '" + ST + "'" : "uid = '" + ST + "'"))[0][0]).join();
    ok(left === '0,0,0' || await T.p.evaluate(() => window.__delErr), 'deleting an account removes its church, friendships and joins (' + left + ')' + (await T.p.evaluate(() => window.__delErr || ''))); }

  current = 'Script errors';
  ok(errors.length === 0, 'no script errors on any phone' + (errors.length ? ': ' + errors.slice(0, 5).join(' / ') : ''));
} catch (e) { console.log('CRASH', e && e.stack || e); results.push({ ok: false, m: 'crash' }); }
if (process.env.I18N_COLLECT) fs.writeFileSync(process.env.I18N_COLLECT + '.friends.json', JSON.stringify([...I18N_SINK], null, 1));
await browser.close(); site.close(); api.close();
const pass = results.filter(r => r.ok).length;
console.log('\nFriends end-to-end: ' + pass + ' passed, ' + (results.length - pass) + ' failed');
process.exit(results.length === pass ? 0 : 1);
