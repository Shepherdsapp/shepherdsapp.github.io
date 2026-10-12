// Checks of the Shepherd server (worker/worker.js) with a stand-in database and a stand-in push service.
import crypto from 'node:crypto';
import ece from 'http_ece';
import { makeD1 } from './d1.mjs';
import worker, { sendDue, encryptPush, icsText, calItems } from '../worker/worker.js';

const results = []; let current = '';
const ok = (c, m) => { results.push({ ok: !!c, m: current + ' - ' + m }); if (!c) console.log('  FAIL: ' + current + ' - ' + m); };
const key = s => crypto.createHash('sha256').update(s).digest('hex');
const ORIGIN = 'https://sitbackco.github.io';

const env = { DB: await makeD1(), ADMIN_KEY: 'admin-secret-123', ALLOWED_ORIGINS: ORIGIN };
async function call(method, path, bodyObj, token, extra) {
  const h = Object.assign({ 'Origin': ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' }, extra || {});
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await worker.fetch(new Request('https://shepherd.test.workers.dev' + path, { method, headers: h, body: bodyObj === undefined ? undefined : typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj) }), env);
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, data: ct.includes('json') ? await r.json() : await r.text() };
}

// stand-in push service: records every notification sent
const sentPushes = []; let pushStatus = 201;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://web.push.apple.com/') || String(url).startsWith('https://fcm.googleapis.com/')) { sentPushes.push({ url: String(url), init }); return new Response('', { status: pushStatus }); }
  if (String(url).startsWith('https://api.resend.com/')) { sentPushes.push({ url: String(url), init, email: true }); return new Response('{}', { status: 200 }); }
  return realFetch(url, init);
};

current = 'Health';
let r = await call('GET', '/health');
ok(r.status === 200 && r.data.db === true && r.data.app === 'Shepherd' && r.data.admin === true, 'health shows the database is ready');
const noDb = await worker.fetch(new Request('https://x.dev/api/me'), {});
ok(noDb.status === 503, 'explains a missing database binding');

current = 'Accounts';
r = await call('POST', '/api/signup', { email: ' Pavi@Example.com ', key: key('pw1'), name: 'Pavi' });
ok(r.status === 200 && r.data.token && r.data.user.email === 'pavi@example.com' && r.data.user.id.startsWith('u_') && r.data.user.cal, 'signs up with a cleaned email');
const T1 = r.data.token, U1 = r.data.user;
ok(r.headers.get('Access-Control-Allow-Origin') === ORIGIN, 'allows the app\'s address');
r = await call('POST', '/api/signup', { email: 'pavi@example.com', key: key('x') });
ok(r.status === 409 && /Sign in instead/.test(r.data.message), 'no second account on the same email');
r = await call('POST', '/api/signup', { email: 'not-an-email', key: key('x') });
ok(r.status === 400 && r.data.error === 'bad_email', 'rejects a bad email');
r = await call('POST', '/api/signup', { email: 'a@b.co', key: 'short' });
ok(r.status === 400 && r.data.error === 'bad_password', 'rejects a missing password key');
r = await call('POST', '/api/login', { email: 'pavi@example.com', key: key('wrong') });
ok(r.status === 401 && r.data.error === 'wrong_password', 'wrong password refused');
r = await call('POST', '/api/login', { email: 'PAVI@example.com', key: key('pw1') });
ok(r.status === 200 && r.data.token && r.data.token !== T1 && r.data.user.id === U1.id, 'signs in on a second device');
const T1b = r.data.token;
r = await call('GET', '/api/me', undefined, T1);
ok(r.status === 200 && r.data.user.email === 'pavi@example.com' && r.data.user.name === 'Pavi', 'me returns the account');
r = await call('GET', '/api/me', undefined, 'nonsense');
ok(r.status === 401 && r.data.error === 'signed_out', 'unknown token is signed out');
r = await call('GET', '/api/me');
ok(r.status === 401, 'no token is signed out');
for (let i = 0; i < 10; i++) await call('POST', '/api/login', { email: 'grace@example.com', key: key('g' + i) });
r = await call('POST', '/api/login', { email: 'grace@example.com', key: key('g') });
ok(r.status === 429, 'too many wrong tries are slowed down');
r = await call('POST', '/api/signup', { email: 'grace@example.com', key: key('grace'), name: 'Grace' });
const T2 = r.data.token, U2 = r.data.user;
ok(r.status === 200, 'second person signs up');

current = 'Saving';
const now = Date.now();
r = await call('POST', '/api/docs', { ops: [
  { p: 'profile', d: { name: 'Pavi', alertTime: '08:00' }, t: now },
  { p: 'profile/contacts/c1', d: { id: 'c1', name: 'Daniel Mensah', nextStudy: { date: '2026-10-15', time: '19:00', topic: 'Prayer' }, updatedAt: now }, t: now },
  { p: 'profile/events/e1', d: { id: 'e1', name: 'Sunday service', date: '2026-10-18', time: '10:30', place: 'Main hall' }, t: now },
  { p: 'profile/disciples/d1', d: { id: 'd1', name: 'Ama' }, t: now }
] }, T1);
ok(r.status === 200 && r.data.saved === 4 && r.data.kept.length === 0, 'saves four documents');
r = await call('GET', '/api/docs?since=0', undefined, T1b);
ok(r.status === 200 && r.data.docs.length === 4 && r.data.docs.find(d => d.p === 'profile/contacts/c1').d.name === 'Daniel Mensah', 'the other device gets everything');
const seq1 = r.data.seq;
r = await call('GET', '/api/docs?since=' + seq1, undefined, T1b);
ok(r.data.docs.length === 0 && r.data.seq === seq1, 'nothing new since the last pull');
r = await call('GET', '/api/docs?since=0', undefined, T2);
ok(r.data.docs.length === 0, 'Grace cannot see Pavi\'s data');
r = await call('POST', '/api/docs', { ops: [{ p: 'profile/contacts/c1', d: { id: 'c1', name: 'Daniel M', updatedAt: now + 1000 }, t: now + 1000 }] }, T1b);
ok(r.data.saved === 1, 'an edit is saved');
r = await call('POST', '/api/docs', { ops: [{ p: 'profile/contacts/c1', d: { id: 'c1', name: 'Old offline edit', updatedAt: now - 5000 }, t: now - 5000 }] }, T1);
ok(r.data.saved === 0 && r.data.kept.length === 1 && r.data.kept[0].d.name === 'Daniel M', 'an older offline edit never overwrites a newer one, and the newer copy is sent back');
r = await call('GET', '/api/docs?since=' + seq1, undefined, T1);
ok(r.data.docs.length === 1 && r.data.docs[0].d.name === 'Daniel M', 'only the change comes down');
r = await call('GET', '/api/history?p=profile/contacts/c1', undefined, T1);
ok(r.data.versions.length === 1 && r.data.versions[0].d.name === 'Daniel Mensah', 'the earlier version is kept');
r = await call('POST', '/api/docs', { ops: [{ p: '../users/u_x', d: {} }] }, T1);
ok(r.status === 400 && r.data.error === 'bad_path', 'odd paths refused');
r = await call('POST', '/api/docs', { ops: [{ p: 'profile/contacts/big', d: { x: 'a'.repeat(300 * 1024) } }] }, T1);
ok(r.status === 413, 'very large documents refused');
r = await call('POST', '/api/docs', { ops: [{ p: 'profile/contacts/c1', d: null, t: Date.now() + 2000 }] }, T1);
ok(r.data.saved === 1, 'delete saved');
r = await call('GET', '/api/docs?since=0', undefined, T1b);
const c1 = r.data.docs.find(d => d.p === 'profile/contacts/c1');
ok(c1 && c1.d === null, 'other device learns of the delete');
r = await call('GET', '/api/history?p=profile/contacts/c1', undefined, T1);
ok(r.data.versions.length === 0, 'a delete at someone\'s request leaves no copies behind');
await call('POST', '/api/docs', { ops: [{ p: 'profile/contacts/c1', d: { id: 'c1', name: 'Daniel Mensah', nextStudy: { date: '2026-10-15', time: '19:00', topic: 'Prayer' }, updatedAt: Date.now() + 3000 }, t: Date.now() + 3000 }] }, T1);

current = 'Calendar link';
r = await call('GET', '/cal/' + U1.cal + '.ics');
ok(r.status === 200 && r.headers.get('content-type').includes('text/calendar'), 'calendar link answers as a calendar');
ok(/SUMMARY:Bible study – Daniel/.test(r.data) && /DTSTART:20261015T190000\r\n/.test(r.data) && /SUMMARY:Sunday service/.test(r.data) && /LOCATION:Main hall/.test(r.data) && /TRIGGER:-PT60M/.test(r.data), 'has the study (first name only) and the event, at local time, with a reminder');
ok(!/Mensah/.test(r.data), 'surnames stay out of the calendar');
r = await call('GET', '/cal/' + U1.cal + '/event/e1.ics');
ok(r.status === 200 && /Sunday service/.test(r.data) && !/Bible study/.test(r.data), 'one event on its own for "Add to phone calendar"');
r = await call('GET', '/cal/' + U1.cal + '/study/c1.ics');
ok(r.status === 200 && /Bible study – Daniel/.test(r.data) && !/Sunday/.test(r.data), 'one study on its own');
r = await call('GET', '/cal/abcdefghijklmnopqrstuvwxyz.ics');
ok(r.status === 404, 'unknown calendar link is not found');
r = await call('POST', '/api/cal/new', {}, T1);
ok(r.data.cal && r.data.cal !== U1.cal, 'calendar link can be replaced');
const old = await call('GET', '/cal/' + U1.cal + '.ics');
ok(old.status === 404 && /replaced/.test(old.data), 'old calendar link stops working');
U1.cal = r.data.cal;
ok(icsText([{ uid: 'x', title: 'All day, test; ok', date: '2026-12-31' }]).includes('DTSTART;VALUE=DATE:20261231') && icsText([{ uid: 'x', title: 'a', date: '2026-12-31' }]).includes('DTEND;VALUE=DATE:20270101'), 'all-day items end the next day, even over New Year');
ok(calItems([{ path: 'profile/events/x', data: JSON.stringify({ name: 'From cal', date: '2099-01-01', source: 'calendar' }) }]).length === 0, 'events that came from the phone calendar aren\'t sent back to it');

current = 'Notifications';
r = await call('GET', '/api/push/key');
ok(r.status === 200 && Buffer.from(r.data.key.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length === 65, 'gives the public notification key');
const vapidPub = r.data.key;
r = await call('GET', '/api/push/key');
ok(r.data.key === vapidPub, 'the key stays the same');
const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
const authSecret = crypto.randomBytes(16);
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sub = { endpoint: 'https://web.push.apple.com/QAbc123', keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(authSecret) } };
r = await call('POST', '/api/push/sub', { sub: Object.assign({}, sub, { endpoint: 'https://evil.example.com/x' }) }, T1);
ok(r.status === 400, 'only real notification services are accepted');
r = await call('POST', '/api/push/sub', { sub }, T1);
ok(r.status === 200 && r.data.devices === 1, 'this phone is registered for notifications');
r = await call('POST', '/api/push/test', {}, T1);
ok(r.status === 200 && r.data.sent === 1 && sentPushes.length === 1, 'test notification sent');
const decrypt = p => JSON.parse(ece.decrypt(Buffer.from(p.init.body), { version: 'aes128gcm', privateKey: ua, authSecret }).toString());
const msg = decrypt(sentPushes[0]);
ok(msg.title === 'Shepherd notifications are on', 'the phone can decrypt it');
const ah = sentPushes[0].init.headers.Authorization;
const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(ah) || [];
const [h64, c64, s64] = jwt.split('.');
const claims = JSON.parse(Buffer.from(c64, 'base64url'));
const pubKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(Buffer.from(vapidPub, 'base64url').subarray(1, 33)), y: b64u(Buffer.from(vapidPub, 'base64url').subarray(33)) }, format: 'jwk' });
ok(k === vapidPub && claims.aud === 'https://web.push.apple.com' && claims.exp > Date.now() / 1000 && /^https:|^mailto:/.test(claims.sub), 'signed for Apple\'s push service with a valid subject');
ok(crypto.verify('sha256', Buffer.from(h64 + '.' + c64), { key: pubKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s64, 'base64url')), 'signature checks out');
ok(sentPushes[0].init.headers['Content-Encoding'] === 'aes128gcm' && sentPushes[0].init.headers.TTL, 'sent with the right encoding');
const enc2 = await encryptPush('x'.repeat(2000), sub.keys.p256dh, sub.keys.auth);
ok(ece.decrypt(Buffer.from(enc2), { version: 'aes128gcm', privateKey: ua, authSecret }).toString().length === 2000, 'long messages decrypt too');

sentPushes.length = 0;
const soon = Date.now() + 60e3;
r = await call('POST', '/api/schedule', { items: [
  { at: soon, title: 'Reply to Grace', body: 'Grace is waiting on your reply.', tag: 'r-c2', url: './?open=c2', badge: 3 },
  { at: soon + 1000, title: 'Message Daniel', body: '2 days overdue.', tag: 'm-c1', url: './?open=c1' },
  { at: Date.now() - 1000, title: 'In the past', body: '' },
  { at: Date.now() + 40 * 864e5, title: 'Too far ahead', body: '' }
] }, T1);
ok(r.data.scheduled === 2, 'schedules the two upcoming alerts only');
let out = await sendDue(env);
ok(out.sent === 0 && sentPushes.length === 0, 'nothing sent before its time');
const realNow = Date.now; Date.now = () => realNow() + 5 * 60e3;
out = await sendDue(env);
ok(out.sent === 2 && sentPushes.length === 2, 'both sent when due');
const got = sentPushes.map(decrypt);
ok(got[0].title === 'Reply to Grace' && got[0].body === 'Grace is waiting on your reply.' && got[0].badge === 3 && got[0].url === './?open=c2' && got[1].title === 'Message Daniel', 'each alert names the person, with a link to them');
out = await sendDue(env);
ok(out.sent === 0, 'never sent twice');
Date.now = realNow;
r = await call('POST', '/api/schedule', { items: [{ at: soon, title: 'Old' }] }, T1);
r = await call('POST', '/api/schedule', { items: [{ at: soon + 5000, title: 'New' }] }, T1);
const left = env.DB.raw.exec("SELECT title FROM outbox WHERE sent = 0")[0].values.map(v => v[0]);
ok(left.length === 1 && left[0] === 'New', 'a new schedule replaces the old one');
pushStatus = 410; sentPushes.length = 0;
Date.now = () => realNow() + 5 * 60e3; await sendDue(env); Date.now = realNow;
r = await call('GET', '/api/me', undefined, T1);
ok(r.data.devices === 0, 'a phone that has removed the app is forgotten');
pushStatus = 201;

current = 'Forgotten password';
r = await call('POST', '/api/reset/request', { email: 'pavi@example.com' });
ok(r.status === 200 && r.data.emailed === false, 'says no email is set up');
let adminRes = await worker.fetch(new Request('https://shepherd.test.workers.dev/admin', { method: 'POST', body: new URLSearchParams({ admin: 'wrong', email: 'pavi@example.com' }) }), env);
ok(/isn't right/.test(await adminRes.text()), 'admin page refuses a wrong admin key');
adminRes = await worker.fetch(new Request('https://shepherd.test.workers.dev/admin', { method: 'POST', body: new URLSearchParams({ admin: 'admin-secret-123', email: 'pavi@example.com' }) }), env);
const page = await adminRes.text(); const code = (/(\d{6})<\/b>/.exec(page) || [])[1];
ok(code && !/Daniel/.test(page), 'admin gets a reset code and sees no contacts');
r = await call('POST', '/api/reset/confirm', { email: 'pavi@example.com', code: '000000', key: key('pw2') });
ok(r.status === 400, 'wrong code refused');
r = await call('POST', '/api/reset/confirm', { email: 'pavi@example.com', code, key: key('pw2') });
ok(r.status === 200 && r.data.token, 'new password set with the code');
const T1c = r.data.token;
r = await call('GET', '/api/me', undefined, T1);
ok(r.status === 401, 'old sign-ins end after a reset');
r = await call('POST', '/api/login', { email: 'pavi@example.com', key: key('pw2') });
ok(r.status === 200, 'signs in with the new password');
r = await call('GET', '/api/docs?since=0', undefined, T1c);
ok(r.data.docs.some(d => d.p === 'profile/events/e1'), 'all data is still there after a reset');
env.RESEND_API_KEY = 're_test'; env.MAIL_FROM = 'Shepherd <hi@church.org>'; sentPushes.length = 0;
r = await call('POST', '/api/reset/request', { email: 'grace@example.com' });
ok(r.data.emailed === true && sentPushes.some(s => s.email && /Your Shepherd code: \d{6}/.test(s.init.body)), 'emails a code when email is set up');
delete env.RESEND_API_KEY;

current = 'Password and account';
r = await call('POST', '/api/password', { key: key('nope'), newKey: key('pw3') }, T1c);
ok(r.status === 401, 'change needs the current password');
r = await call('POST', '/api/password', { key: key('pw2'), newKey: key('pw3') }, T1c);
ok(r.status === 200, 'password changed');
r = await call('POST', '/api/account/delete', { key: key('pw3') }, T2);
ok(r.status === 401, 'deleting needs your own password');
r = await call('POST', '/api/account/delete', { key: key('grace') }, T2);
ok(r.status === 200, 'Grace deletes her account');
ok(env.DB.raw.exec("SELECT COUNT(*) FROM users WHERE email = 'grace@example.com'")[0].values[0][0] === 0, 'Grace\'s account is gone');
const leftover = env.DB.raw.exec("SELECT COUNT(*) FROM docs WHERE uid = '" + U2.id + "'")[0].values[0][0];
ok(leftover === 0, 'nothing of hers is left');

current = 'Browser access';
r = await call('GET', '/api/push/key', undefined, null, { Origin: 'https://evil.example.com' });
ok(!r.headers.get('Access-Control-Allow-Origin'), 'other websites can\'t use the server');
const pre = await worker.fetch(new Request('https://shepherd.test.workers.dev/api/docs', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env);
ok(pre.status === 204 && /Authorization/.test(pre.headers.get('Access-Control-Allow-Headers')), 'answers the browser\'s pre-check');

const pass = results.filter(x => x.ok).length;
console.log('Worker: ' + pass + ' passed, ' + (results.length - pass) + ' failed');
process.exit(results.length === pass ? 0 : 1);
