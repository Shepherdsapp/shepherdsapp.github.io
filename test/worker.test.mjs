// Checks of the Shepherd server (worker/worker.js) with a stand-in database and a stand-in push service.
import crypto from 'node:crypto';
import ece from 'http_ece';
import { makeD1 } from './d1.mjs';
// WORKER=path/to/other/worker.js runs these same checks against another copy (used to prove each new check fails on the old server)
const WORKER_URL = new URL(process.env.WORKER ? 'file://' + process.env.WORKER : '../worker/worker.js', import.meta.url).href;
const mod = await import(WORKER_URL);
const worker = mod.default, { sendDue, encryptPush, icsText, calItems } = mod;

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
ok(r.status === 200 && r.data.db === true && r.data.app === 'Shepherd', 'health shows the database is ready');
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

current = 'QR code hello page';
{
  const HI_IP = { 'CF-Connecting-IP': '9.9.9.9' };
  r = await call('POST', '/api/qr', {}, T1c);
  const code = r.data.code;
  ok(r.status === 200 && /^[A-Za-z0-9_-]{8,}$/.test(code), 'gives this account its own QR code');
  r = await call('POST', '/api/qr', {}, T1c);
  ok(r.data.code === code, 'the same code every time, so printed QR codes keep working');
  r = await call('POST', '/api/qr', {});
  ok(r.status === 401, 'only for signed-in people');
  r = await call('GET', '/hi/' + code);
  ok(r.status === 200 && /ready yet/.test(r.data) && /Pavi/.test(r.data), 'explains it isn\'t ready until a WhatsApp number is added');
  const t0 = Date.now();
  r = await call('POST', '/api/docs', { ops: [{ p: 'profile', d: { name: 'Pavi Example', alertTime: '08:00', phone: '07700 900123', lang: 'es', tz: 'Europe/London', defaultEvery: 4, intro: "Hi! It was great meeting you today. Here's my number so we can keep in touch about studying the Bible." }, t: t0 }, { p: 'profile/prayers/p1', d: { id: 'p1', name: 'Grace', notes: 'Exams' }, t: t0 }] }, T1c);
  ok(r.status === 200 && r.data.saved === 2, 'the prayer list is saved like everything else');
  r = await call('GET', '/hi/' + code);
  ok(r.status === 200 && /Saluda a Pavi/.test(r.data) && /<form/.test(r.data) && /name="name"/.test(r.data) && !/07700/.test(r.data), 'the hello page is in Pavi\'s language, asks for a name, and never shows Pavi\'s number');
  const ua2 = crypto.createECDH('prime256v1'); ua2.generateKeys();
  await call('POST', '/api/push/sub', { sub: { endpoint: 'https://web.push.apple.com/QR' + Date.now(), keys: { p256dh: b64u(ua2.getPublicKey()), auth: b64u(crypto.randomBytes(16)) } } }, T1c);
  r = await call('GET', '/api/docs?since=0', undefined, T1c); const seqBefore = r.data.seq;
  sentPushes.length = 0;
  r = await call('POST', '/hi/' + code, 'name=' + encodeURIComponent('  Kwame   Boateng ') + '&phone=' + encodeURIComponent('+44 7700 900999') + '&agree=1', null, Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, HI_IP));
  const loc = r.headers.get('Location') || '';
  ok(r.status === 303 && loc.startsWith('https://wa.me/447700900123?text='), 'sends them straight on to WhatsApp with Pavi\'s number');
  ok(decodeURIComponent(loc.split('text=')[1]) === '¡Hola, encantado de conocerte! Conseguí tu contacto con Shepherd. Espero saber de ti pronto.', 'the old default message becomes the new short one, in Pavi\'s language (Spanish)');
  r = await call('GET', '/api/docs?since=' + seqBefore, undefined, T1c);
  const added = r.data.docs.find(d => d.p.startsWith('profile/contacts/') && d.d && d.d.source === 'qr');
  ok(added && added.d.name === 'Kwame Boateng' && added.d.phone === '+44 7700 900999' && added.d.stage === 'First contact' && added.d.everyDays === 4 && added.d.consent === true, 'they are added to Pavi\'s list by themselves, as First contact');
  ok(added && added.d.replyState === 'me' && /^\d{4}-\d{2}-\d{2}$/.test(added.d.metOn) && /QR code/.test(added.d.log[0].text), 'marked as waiting on Pavi, with today as the day they met');
  ok(sentPushes.some(x => x.url.includes('/QR')), 'Pavi\'s phone gets a notification straight away');
  await call('POST', '/api/docs', { ops: [{ p: 'profile', d: { name: 'Pavi Example', phone: '07700 900123', intro: 'Hey, Pavi here!' }, t: Date.now() + 5 }] }, T1c);
  r = await call('POST', '/hi/' + code, { name: 'Esi', agree: '1' }, null, HI_IP);
  ok(r.status === 303 && decodeURIComponent(r.headers.get('Location').split('text=')[1]) === 'Hey, Pavi here!', 'uses Pavi\'s own message when changed');
  r = await call('POST', '/hi/' + code, { name: '   ' }, null, { 'CF-Connecting-IP': '9.9.9.8' });
  ok(r.status === 400 && /<form/.test(r.data), 'a name is needed');
  for (let i = 0; i < 3; i++) await call('POST', '/hi/' + code, { name: 'Spam ' + i, agree: '1' }, null, HI_IP);
  r = await call('POST', '/hi/' + code, { name: 'Spam again', agree: '1' }, null, HI_IP);
  ok(r.status === 429, 'too many from one phone are slowed down');
  r = await call('GET', '/hi/nonexistent-code-123');
  ok(r.status === 404, 'unknown codes go nowhere');
  r = await call('GET', '/hi/' + code, undefined, null, { Origin: 'https://evil.example.com' });
  ok(r.status === 200 && !/Pavi Example/.test(r.data), 'only Pavi\'s first name is shown to the person scanning');
}

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

/* ===== Launch fixes (29 October 2026): each check below failed on the server before the fix ===== */
const ipH = ip => ({ 'CF-Connecting-IP': ip });
async function fresh(email, ip) { const x = await call('POST', '/api/signup', { email, key: key(email), name: 'Test ' + email.split('@')[0], invite: env.INVITE_CODE || undefined }, null, ipH(ip || '10.0.0.' + Math.floor(Math.random() * 250))); return x.data; }
const docOf = async (tok, p) => ((await call('GET', '/api/docs?since=0', undefined, tok)).data.docs || []).find(d => d.p === p);

current = 'Fix 3: two phones editing the same person';
try {
  const A = await fresh('merge@example.com', '10.1.0.1');
  const tB = (await call('POST', '/api/login', { email: 'merge@example.com', key: key('merge@example.com') }, null, ipH('10.1.0.2'))).data.token;
  const t0 = Date.now() - 60e3;
  const base = { id: 'g1', name: 'Grace Owusu', stage: 'First contact', notes: '', log: [{ t: t0, k: 'change', text: 'Added' }], updatedAt: t0 };
  await call('POST', '/api/docs', { ops: [{ p: 'profile/contacts/g1', d: base, t: t0, b: null }] }, A.token);
  // phone A (offline) adds a note and logs a message; phone B (offline, later) moves Grace to Interested and logs a study
  const a = Object.assign({}, base, { notes: 'Note written on phone A', log: base.log.concat([{ t: t0 + 1000, k: 'msg', text: 'Messaged' }]), updatedAt: t0 + 1000 });
  const b = Object.assign({}, base, { stage: 'Interested', log: base.log.concat([{ t: t0 + 2000, k: 'study', text: 'Study logged' }]), updatedAt: t0 + 2000 });
  await call('POST', '/api/docs', { ops: [{ p: 'profile/contacts/g1', d: b, t: b.updatedAt, b: base }] }, tB);
  r = await call('POST', '/api/docs', { ops: [{ p: 'profile/contacts/g1', d: a, t: a.updatedAt, b: base }] }, A.token);
  let g = (await docOf(A.token, 'profile/contacts/g1')).d;
  ok(g.notes === 'Note written on phone A' && g.stage === 'Interested', 'both changes are kept: phone A\'s note and phone B\'s new stage');
  ok(g.log.length === 3 && g.log.some(x => x.text === 'Messaged') && g.log.some(x => x.text === 'Study logged'), 'activity logged on both phones is kept, in time order');
  ok(r.data.kept && r.data.kept.length === 1 && r.data.kept[0].d.stage === 'Interested', 'the phone is sent back the merged copy straight away');
  // a phone with a slow clock: its change is older by the clock but touches a different field
  const slowBase = g, slow = Object.assign({}, g, { phone: '07700 900555', updatedAt: t0 - 3600e3 });
  await call('POST', '/api/docs', { ops: [{ p: 'profile/contacts/g1', d: slow, t: slow.updatedAt, b: slowBase }] }, tB);
  g = (await docOf(A.token, 'profile/contacts/g1')).d;
  ok(g.phone === '07700 900555' && g.notes === 'Note written on phone A', 'a phone whose clock is slow still has its change kept');
  // both phones change the same thing: the later change wins
  const x1 = Object.assign({}, g, { stage: 'Studying', updatedAt: Date.now() + 1000 }), x2 = Object.assign({}, g, { stage: 'Baptised', updatedAt: Date.now() + 2000 });
  await call('POST', '/api/docs', { ops: [{ p: 'profile/contacts/g1', d: x2, t: x2.updatedAt, b: g }] }, tB);
  await call('POST', '/api/docs', { ops: [{ p: 'profile/contacts/g1', d: x1, t: x1.updatedAt, b: g }] }, A.token);
  ok((await docOf(A.token, 'profile/contacts/g1')).d.stage === 'Baptised', 'when both change the same field, the later change wins');
  // deleted on one phone at the person's request, edited on the other: stays deleted
  const cur = (await docOf(A.token, 'profile/contacts/g1')).d;
  await call('POST', '/api/docs', { ops: [{ p: 'profile/contacts/g1', d: null, t: Date.now() }] }, A.token);
  r = await call('POST', '/api/docs', { ops: [{ p: 'profile/contacts/g1', d: Object.assign({}, cur, { notes: 'late edit', updatedAt: Date.now() + 9000 }), t: Date.now() + 9000, b: cur }] }, tB);
  ok((await docOf(A.token, 'profile/contacts/g1')).d === null && r.data.kept.some(k => k.d === null), 'someone deleted on one phone stays deleted when the other phone edits them');
  // older app versions (no starting copy): the newer copy wins but both activity logs are kept
  const o = { id: 'o1', name: 'Kofi', log: [{ t: 1, text: 'one' }], updatedAt: 1000 };
  await call('POST', '/api/docs', { ops: [{ p: 'profile/contacts/o1', d: o, t: 1000 }] }, A.token);
  await call('POST', '/api/docs', { ops: [{ p: 'profile/contacts/o1', d: Object.assign({}, o, { log: o.log.concat([{ t: 2, text: 'from A' }]), updatedAt: 3000 }), t: 3000 }] }, A.token);
  await call('POST', '/api/docs', { ops: [{ p: 'profile/contacts/o1', d: Object.assign({}, o, { stage: 'Interested', log: o.log.concat([{ t: 3, text: 'from B' }]), updatedAt: 2000 }), t: 2000 }] }, tB);
  const k1 = (await docOf(A.token, 'profile/contacts/o1')).d;
  ok(k1.log.length === 3, 'older app versions: activity logged on both phones is still kept');
} catch (e) { ok(false, 'crashed: ' + e.message); }

current = 'Fix 4: notification plan writes only what changed';
try {
  const A = await fresh('plan@example.com', '10.2.0.1');
  const base = Date.now() + 3600e3;
  const items = Array.from({ length: 50 }, (_, i) => ({ at: base + i * 60e3, title: 'Message P' + i, body: 'Tap to open.', tag: 'm-' + i, url: './?open=p' + i }));
  await call('POST', '/api/schedule', { items }, A.token);
  const idsBefore = env.DB.raw.exec("SELECT id FROM outbox WHERE uid = '" + A.user.id + "' ORDER BY id")[0].values.map(v => v[0]).join();
  r = await call('POST', '/api/schedule', { items }, A.token);
  const idsAfter = env.DB.raw.exec("SELECT id FROM outbox WHERE uid = '" + A.user.id + "' ORDER BY id")[0].values.map(v => v[0]).join();
  ok(idsBefore === idsAfter, 'sending the same plan again rewrites nothing');
  const changed = items.slice(); changed[3] = Object.assign({}, changed[3], { title: 'Reply to P3' });
  r = await call('POST', '/api/schedule', { items: changed }, A.token);
  const rows = env.DB.raw.exec("SELECT title FROM outbox WHERE uid = '" + A.user.id + "' AND sent = 0")[0].values.map(v => v[0]);
  const newIds = env.DB.raw.exec("SELECT id FROM outbox WHERE uid = '" + A.user.id + "' ORDER BY id")[0].values.map(v => v[0]);
  ok(rows.length === 50 && rows.includes('Reply to P3') && !rows.includes('Message P3') && newIds.filter(id => !idsBefore.split(',').includes(String(id))).length === 1, 'one changed notification means one row replaced, not fifty');
} catch (e) { ok(false, 'crashed: ' + e.message); }

current = 'Fix 5: notifications are marked sent only after they go';
try {
  const A = await fresh('send@example.com', '10.3.0.1');
  const ua3 = crypto.createECDH('prime256v1'); ua3.generateKeys();
  await call('POST', '/api/push/sub', { sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/fix5', keys: { p256dh: b64u(ua3.getPublicKey()), auth: b64u(crypto.randomBytes(16)) } } }, A.token);
  await call('POST', '/api/schedule', { items: [{ at: Date.now() + 60e3, title: 'Message Fix5', body: 'Tap to open.', tag: 'f5' }] }, A.token);
  const realNow2 = Date.now; Date.now = () => realNow2() + 5 * 60e3;
  pushStatus = 503;
  await sendDue(env);
  const st1 = env.DB.raw.exec("SELECT sent FROM outbox WHERE tag = 'f5'")[0].values[0][0];
  ok(st1 === 0, 'when the phone service is briefly down, the notification waits for the next run');
  pushStatus = 201; sentPushes.length = 0;
  await sendDue(env);
  const st2 = env.DB.raw.exec("SELECT sent FROM outbox WHERE tag = 'f5'")[0].values[0][0];
  ok(st2 === 1 && sentPushes.some(x => x.url.endsWith('/fix5')), 'and goes out on the next run');
  const kept5 = env.DB.raw.exec("SELECT title, body FROM outbox WHERE tag = 'f5'")[0].values[0];
  ok(kept5[0] === '' && kept5[1] === '', 'once sent, the names in it aren\'t kept on the server (as the privacy notice says)');
  Date.now = realNow2;
} catch (e) { pushStatus = 201; ok(false, 'crashed: ' + e.message); }

current = 'Fix 6: strangers can\'t lock someone out';
try {
  await fresh('locked@example.com', '10.4.0.1');
  for (let i = 0; i < 12; i++) await call('POST', '/api/login', { email: 'locked@example.com', key: key('bad' + i) }, null, ipH('66.6.6.6'));
  r = await call('POST', '/api/login', { email: 'locked@example.com', key: key('locked@example.com') }, null, ipH('10.4.0.9'));
  ok(r.status === 200, 'after a stranger\'s 12 wrong tries, the owner still signs in from their own phone');
  r = await call('POST', '/api/login', { email: 'locked@example.com', key: key('bad') }, null, ipH('66.6.6.6'));
  ok(r.status === 429, 'the stranger is the one slowed down');
  for (let i = 0; i < 10; i++) await call('POST', '/api/login', { email: 'locked@example.com', key: key('x' + i) }, null, ipH('77.0.0.' + i));
  r = await call('POST', '/api/login', { email: 'locked@example.com', key: key('locked@example.com') }, null, ipH('10.4.0.9'));
  ok(r.status === 200, 'wrong tries spread over 10 networks don\'t lock the owner out either');
} catch (e) { ok(false, 'crashed: ' + e.message); }

current = 'Fix 7 and 8: QR page consent, privacy link, home country';
try {
  const A = await fresh('qrfix@example.com', '10.5.0.1');
  await call('POST', '/api/docs', { ops: [{ p: 'profile', d: { name: 'Tunde', phone: '08031234567', country: 'NG' }, t: Date.now() }] }, A.token);
  const code = (await call('POST', '/api/qr', {}, A.token)).data.code;
  r = await call('GET', '/hi/' + code);
  ok(/type="checkbox"[^>]*name="agree"|name="agree"[^>]*type="checkbox"/.test(r.data) && /required/.test(r.data), 'the hello page has a required tick to agree');
  ok(/href="https:\/\/sitbackco\.github\.io\/shepherd\/privacy\.html"/.test(r.data), 'and a link to the privacy notice');
  r = await call('POST', '/hi/' + code, { name: 'No Tick' }, null, ipH('10.5.0.2'));
  const none = ((await call('GET', '/api/docs?since=0', undefined, A.token)).data.docs || []).filter(d => d.d && d.d.source === 'qr');
  ok(r.status === 400 && none.length === 0, 'without the tick nobody is added');
  r = await call('POST', '/hi/' + code, { name: 'With Tick', agree: '1' }, null, ipH('10.5.0.3'));
  const added = ((await call('GET', '/api/docs?since=0', undefined, A.token)).data.docs || []).find(d => d.d && d.d.name === 'With Tick');
  ok(r.status === 303 && added && added.d.consent === true, 'with the tick they are added, with their agreement recorded');
  ok((r.headers.get('Location') || '').startsWith('https://wa.me/2348031234567?'), 'a Nigerian owner\'s local number (08…) goes to WhatsApp as +234, not +44');
  if (mod.waNum) {
    ok(mod.waNum('+44 07700 900123') === '447700900123', '"+44 07…" drops the extra 0');
    ok(mod.waNum('0244123456', 'GH') === '233244123456' && mod.waNum('07700 900123') === '447700900123' && mod.waNum('07700 900123', 'GB') === '447700900123', 'Ghanaian and UK local numbers get the right country code');
  } else ok(false, 'no phone number helper');
} catch (e) { ok(false, 'crashed: ' + e.message); }

current = 'Fix 10: church invite code';
try {
  r = await call('GET', '/api/signup/options');
  ok(r.status === 200 && r.data.invite === false, 'with no code set, the app is told sign-up is open');
  env.INVITE_CODE = 'GRACE-2026';
  r = await call('GET', '/api/signup/options');
  ok(r.data.invite === true, 'with a code set, the app is told to ask for it');
  r = await call('POST', '/api/signup', { email: 'stranger@example.com', key: key('s'), name: 'Stranger' }, null, ipH('10.6.0.1'));
  ok(r.status === 403 && r.data.error === 'bad_invite', 'with an invite code set, sign-up without it is refused');
  r = await call('POST', '/api/signup', { email: 'stranger@example.com', key: key('s'), name: 'Stranger', invite: 'WRONG' }, null, ipH('10.6.0.1'));
  ok(r.status === 403, 'a wrong code is refused');
  r = await call('POST', '/api/signup', { email: 'member@example.com', key: key('m'), name: 'Member', invite: ' grace 2026 ' }, null, ipH('10.6.0.1'));
  ok(r.status === 200 && r.data.token, 'the right code works, whatever the capitals and spaces');
  r = await call('POST', '/api/login', { email: 'locked@example.com', key: key('locked@example.com') }, null, ipH('10.4.0.9'));
  ok(r.status === 200, 'people who already have an account sign in as before, no code needed');
  r = await call('POST', '/api/signup', { email: 'noname@example.com', key: key('n'), name: '   ', invite: 'grace-2026' }, null, ipH('10.6.0.1'));
  ok(r.status === 400, 'a blank name is refused');
  delete env.INVITE_CODE;
} catch (e) { delete env.INVITE_CODE; ok(false, 'crashed: ' + e.message); }

current = 'Fix 16: a new QR code, and a lower daily limit';
try {
  const A = await fresh('qrnew@example.com', '10.7.0.1');
  await call('POST', '/api/docs', { ops: [{ p: 'profile', d: { name: 'Ama', phone: '07700 900777' }, t: Date.now() }] }, A.token);
  const old = (await call('POST', '/api/qr', {}, A.token)).data.code;
  r = await call('POST', '/api/qr/new', {}, A.token);
  const nu = r.data && r.data.code;
  ok(r.status === 200 && nu && nu !== old, 'Make a new QR code gives a different code');
  ok((await call('GET', '/hi/' + old)).status === 404 && (await call('GET', '/hi/' + nu)).status === 200, 'the old code stops working and the new one works');
  ok((await call('POST', '/api/qr', {}, A.token)).data.code === nu, 'the app keeps showing the new code');
  let last = 0;
  for (let i = 0; i < 21; i++) last = (await call('POST', '/hi/' + nu, { name: 'Junk ' + i, agree: '1' }, null, ipH('20.0.' + i + '.1'))).status;
  ok(last === 429, 'at most 20 people a day can be added through one code');
} catch (e) { ok(false, 'crashed: ' + e.message); }

current = 'Fix 20: calendar file';
try {
  const ics = icsText([{ uid: 'x', title: 'Line\rbreak and ' + 'Изучение Библии с Анной '.repeat(5), date: '2026-11-02', time: '19:00', mins: 60, desc: 'a\r\nb' }], 'Shepherd');
  const lines = ics.split('\r\n');
  ok(!/[^\n]\r(?!\n)/.test(ics) && /SUMMARY:Line\\nbreak/.test(ics), 'line breaks inside a name are escaped');
  ok(lines.every(l => Buffer.byteLength(l, 'utf8') <= 75), 'no line is longer than 75 bytes, even in Russian');
  const unfolded = ics.replace(/\r\n /g, '');
  ok(unfolded.includes('Изучение Библии с Анной Изучение'), 'folding never splits a letter');
} catch (e) { ok(false, 'crashed: ' + e.message); }

current = 'Fix 21: admin page and health';
try {
  for (let i = 0; i < 21; i++) await worker.fetch(new Request('https://shepherd.test.workers.dev/admin', { method: 'POST', headers: { 'CF-Connecting-IP': '99.9.9.9' }, body: new URLSearchParams({ admin: 'wrong' + i, email: 'x@example.com' }) }), env);
  const res = await worker.fetch(new Request('https://shepherd.test.workers.dev/admin', { method: 'POST', headers: { 'CF-Connecting-IP': '10.8.0.1' }, body: new URLSearchParams({ admin: 'admin-secret-123', email: 'member@example.com' }) }), env);
  ok(/\d{6}<\/b>/.test(await res.text()), 'a stranger\'s wrong admin keys don\'t stop you making a reset code');
  r = await call('GET', '/health');
  ok(r.data.db === true && r.data.origins === undefined && r.data.admin === undefined && r.data.email === undefined, '/health no longer shows how the server is set up');
} catch (e) { ok(false, 'crashed: ' + e.message); }

current = 'Sign out on other phones, and sign-in length';
try {
  const A = await fresh('others@example.com', '10.9.0.1');
  const t2 = (await call('POST', '/api/login', { email: 'others@example.com', key: key('others@example.com') }, null, ipH('10.9.0.2'))).data.token;
  const t3 = (await call('POST', '/api/login', { email: 'others@example.com', key: key('others@example.com') }, null, ipH('10.9.0.3'))).data.token;
  r = await call('POST', '/api/logout/others', {}, A.token);
  ok(r.status === 200 && r.data.signedOut === 2, 'Sign out on all my other phones signs out the other 2');
  ok((await call('GET', '/api/me', undefined, t2)).status === 401 && (await call('GET', '/api/me', undefined, t3)).status === 401 && (await call('GET', '/api/me', undefined, A.token)).status === 200, 'this phone stays signed in, the others don\'t');
  env.DB.raw.run('UPDATE sessions SET seen = ? WHERE uid = ?', [Date.now() - 200 * 864e5, A.user.id]);
  ok((await call('GET', '/api/me', undefined, A.token)).status === 401, 'a phone not used for 200 days has to sign in again');
} catch (e) { ok(false, 'crashed: ' + e.message); }

current = 'Database set-up runs once';
try {
  const counted = { n: 0 };
  const DB2 = Object.assign({}, env.DB, { batch: async st => { if (st.some(x => /CREATE TABLE/.test(x.sql))) counted.n++; return env.DB.batch(st); }, prepare: env.DB.prepare });
  const m2 = await import(WORKER_URL + '?fresh=' + Date.now());
  const env2 = Object.assign({}, env, { DB: DB2 });
  await m2.default.fetch(new Request('https://shepherd.test.workers.dev/api/push/key', { headers: { Origin: ORIGIN } }), env2);
  ok(counted.n === 0, 'a server restart with the tables already there doesn\'t run the set-up statements again');
} catch (e) { ok(false, 'crashed: ' + e.message); }

current = 'Browser access';
r = await call('GET', '/api/push/key', undefined, null, { Origin: 'https://evil.example.com' });
ok(!r.headers.get('Access-Control-Allow-Origin'), 'other websites can\'t use the server');
const pre = await worker.fetch(new Request('https://shepherd.test.workers.dev/api/docs', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env);
ok(pre.status === 204 && /Authorization/.test(pre.headers.get('Access-Control-Allow-Headers')), 'answers the browser\'s pre-check');

const pass = results.filter(x => x.ok).length;
console.log('Worker: ' + pass + ' passed, ' + (results.length - pass) + ' failed');
process.exit(results.length === pass ? 0 : 1);
