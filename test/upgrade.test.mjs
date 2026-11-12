// Upgrading the live server, and rolling back: the database made by the server that is live today (version 3, kept in
// test/fixtures/worker-v3.js) is handed to the new server, then back to the old one. Nothing an existing account has may change.
// Run: node test/upgrade.test.mjs
import crypto from 'node:crypto';
import { makeD1 } from './d1.mjs';
const OLD = (await import(new URL('./fixtures/worker-v3.js', import.meta.url).href)), NEW = (await import(new URL('../worker/worker.js', import.meta.url).href));
const results = []; const ok = (c, m) => { results.push(!!c); console.log((c ? '  ✓ ' : '  FAIL: ') + m); };
const key = s => crypto.createHash('sha256').update(s).digest('hex');
const ORIGIN = 'https://shepherdsapp.github.io';
const env = { DB: await makeD1(), ADMIN_KEY: 'admin-secret-123', ALLOWED_ORIGINS: ORIGIN };
const q = sql => { const r = env.DB.raw.exec(sql)[0]; return r ? r.values : []; };
const callOn = mod => async (method, path, body, token) => {
  const h = { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' }; if (token) h.Authorization = 'Bearer ' + token;
  const r = await mod.default.fetch(new Request('https://shepherd.test.workers.dev' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });
  const ct = r.headers.get('content-type') || ''; return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
};
const old = callOn(OLD), neu = callOn(NEW);

// 1. today's server: an account with people, a plan and a scheduled notification
let r = await old('GET', '/health'); ok(r.data.version === 3 && r.data.db === true, 'the copy of today\'s server is version 3');
r = await old('POST', '/api/signup', { email: 'pavi@example.com', key: key('pw1'), name: 'Pavi' }); const T = r.data.token, uid = r.data.user && r.data.user.id || q("SELECT id FROM users")[0][0];
ok(r.status === 200 && T, 'an account made on today\'s server');
const docs = [{ p: 'profile', d: { name: 'Pavi', agreed: { v: 1, at: 5 }, currency: 'GBP' }, t: Date.now() },
  { p: 'profile/contacts/c1', d: { id: 'c1', name: 'Kept Person', phone: '07700 900111', notes: 'private note' }, t: Date.now() },
  { p: 'profile/events/e1', d: { id: 'e1', kind: 'enc', type: 'date', who: 'Kept Person', date: '2026-12-01', cost: 12 }, t: Date.now() }];
r = await old('POST', '/api/docs', { ops: docs }, T); ok(r.status === 200, 'with people and a plan saved');
r = await old('POST', '/api/schedule', { items: [{ at: Date.now() + 3600e3, title: 'Message Kept', body: 'x', tag: 't1', url: './' }] }, T);
const snap = () => JSON.stringify([q('SELECT id, email, name FROM users ORDER BY id'), q('SELECT uid, path, data, del FROM docs ORDER BY path'), q('SELECT uid, title, tag, sent FROM outbox ORDER BY id'), q('SELECT COUNT(*) FROM sessions')]);
const before = snap();

// 2. the new server takes over the same database
r = await neu('GET', '/health'); ok(r.data.version === 4 && r.data.db === true, 'the new server (version 4) starts on that database');
ok(snap() === before, 'accounts, people, plans and waiting notifications are exactly as they were');
ok(q("SELECT v FROM meta WHERE k = 'schema'")[0][0] === '4' && q("SELECT name FROM churches")[0][0] === 'London ICC' && ['social', 'friends', 'blocks', 'joins', 'announced', 'reports'].every(t => q("SELECT COUNT(*) FROM " + t)[0][0] === 0), 'the new tables are added, empty, with London ICC ready');
r = await neu('GET', '/api/me', undefined, T); ok(r.status === 200, 'the phone stays signed in (no need to log in again)');
r = await neu('POST', '/api/login', { email: 'pavi@example.com', key: key('pw1') }); ok(r.status === 200 && r.data.token, 'and the same password still works');
r = await neu('GET', '/api/social/me', undefined, T); ok(r.status === 200 && r.data.on === true && r.data.church === null && r.data.minor === false && r.data.friends.length === 0 && r.data.code.length >= 6, 'an existing account starts as an adult with no church and no friends, and gets a friend code');
r = await neu('GET', '/api/social/feed', undefined, T); ok(r.status === 200 && r.data.plans.length === 0, 'and its existing plan stays private (it was never shared)');
r = await neu('POST', '/api/docs', { ops: [{ p: 'profile/contacts/c2', d: { id: 'c2', name: 'New Person' }, t: Date.now() }] }, T); ok(r.status === 200, 'saving carries on as before');
const mid = snap();

// 3. rolling back: today's server is put back on the upgraded database (a fresh start, as on Cloudflare)
const old2 = callOn(await import(new URL('./fixtures/worker-v3.js?again=1', import.meta.url).href));
r = await old2('GET', '/health'); ok(r.data.version === 3 && r.data.db === true, 'rolling back: version 3 starts fine on the upgraded database');
r = await old2('GET', '/api/me', undefined, T); ok(r.status === 200, 'still signed in after a rollback');
r = await old2('POST', '/api/docs', { ops: [{ p: 'profile/contacts/c3', d: { id: 'c3', name: 'After Rollback' }, t: Date.now() }] }, T); ok(r.status === 200 && q("SELECT COUNT(*) FROM docs WHERE path LIKE 'profile/contacts/%' AND del = 0")[0][0] === 3, 'and saving works, with everything saved in between still there');
r = await old2('GET', '/api/social/me', undefined, T); ok(r.status === 404, 'the old server simply answers "not found" for friends, which the app treats as "hide friends"');
// 4. and forward again
ok(q("SELECT v FROM meta WHERE k = 'schema'")[0][0] === '3', '(the old server marked the database as its own again)');
const neu2 = callOn(await import(new URL('../worker/worker.js?again=1', import.meta.url).href));
r = await neu2('GET', '/api/social/me', undefined, T); ok(r.status === 200 && q("SELECT COUNT(*) FROM docs WHERE del = 0")[0][0] === 5, 'going forward again loses nothing either');

const pass = results.filter(Boolean).length;
console.log('\nUpgrade and rollback: ' + pass + ' passed, ' + (results.length - pass) + ' failed'); process.exit(pass === results.length ? 0 : 1);
