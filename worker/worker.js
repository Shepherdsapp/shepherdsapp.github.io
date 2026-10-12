/* ═══════════════════════════════════════════════════════════════════════════
   SHEPHERD — Cloudflare Worker (the server)
   Paste this whole file into a Cloudflare Worker (Edit code → select all → paste → Deploy).

   What it does
   • Accounts: everyone signs in with their own email and password. Each person's data is theirs only.
   • Saving:   every change from every phone is kept here, so nothing is lost if a phone is lost or reset.
               Earlier versions of each contact are kept too (Settings in the app can't remove them by accident).
   • Alerts:   sends phone notifications that name people ("Reply to Grace", "Message Daniel"), at the
               times the app works out. Works on Android and on iPhone (iOS 16.4+, app added to Home Screen).
   • Calendar: a private calendar link the phone's own Calendar app subscribes to, so studies and events
               show in the phone calendar (and from there in TimeTree).

   Setup (dash.cloudflare.com)
   1. Storage & Databases → D1 → Create database → name it  shepherd
   2. This Worker → Settings → Bindings → Add → D1 database → Variable name  DB  → pick  shepherd
   3. This Worker → Settings → Triggers → Cron Triggers → Add → choose "Every 5 minutes" (cron: star-slash-5 then four stars)
   4. Settings → Variables and Secrets (all optional):
        ALLOWED_ORIGINS  Text    where the app lives. Default https://sitbackco.github.io
        APP_URL          Text    the app's address. Default https://sitbackco.github.io/shepherd/
        ADMIN_KEY        Secret  a long passcode you make up; lets you give someone a password reset code
        RESEND_API_KEY   Secret  from resend.com, to email reset codes (needs your own domain on Resend)
        MAIL_FROM        Text    e.g. Shepherd <hello@yourchurch.org>
   The database tables and the notification keys are created by this Worker the first time it runs.
   Open https://<this worker>/health to check: you should see "db":true.
   ═══════════════════════════════════════════════════════════════════════════ */

export const VERSION = 1;
const DEFAULT_ORIGINS = 'https://sitbackco.github.io';
const DEFAULT_APP_URL = 'https://sitbackco.github.io/shepherd/';
const MAX_DOC = 256 * 1024;
const MAX_OPS = 200;
const SESSION_DAYS = 400;
const PATH_RE = /^profile(\/(contacts|events|disciples)\/[A-Za-z0-9_-]{1,80})?$/;
const PUSH_HOSTS = /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.api\.chromium\.org)$/;

/* ---------- small helpers ---------- */
const enc = new TextEncoder();
const now = () => Date.now();
function b64u(buf) { const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64u(s) { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
function hex(buf) { return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join(''); }
function rand(n) { return crypto.getRandomValues(new Uint8Array(n)); }
async function sha256(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
function same(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
function concat(...parts) { const len = parts.reduce((n, p) => n + p.length, 0); const out = new Uint8Array(len); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }
const cleanEmail = e => String(e || '').trim().toLowerCase();
const okEmail = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e);
const okKey = k => /^[0-9a-f]{64}$/.test(String(k || ''));
const str = (v, max) => String(v == null ? '' : v).slice(0, max);

function origins(env) { return String(env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean); }
function cors(req, env) {
  const o = req.headers.get('Origin') || '';
  const list = origins(env);
  const allow = list.includes('*') || list.includes(o) ? o : '';
  const h = { 'Vary': 'Origin' };
  if (allow) Object.assign(h, { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Access-Control-Max-Age': '86400' });
  return h;
}
function json(data, status, extra) { return new Response(JSON.stringify(data), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {}) }); }
class HttpError extends Error { constructor(status, code, message) { super(message || code); this.status = status; this.code = code; } }
const fail = (status, code, message) => { throw new HttpError(status, code, message); };
async function body(req) { const t = await req.text(); if (t.length > 4 * 1024 * 1024) fail(413, 'too_big', 'That is too much to save at once.'); try { return t ? JSON.parse(t) : {}; } catch (e) { fail(400, 'bad_json'); } }

/* ---------- database ---------- */
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, pw TEXT NOT NULL, salt TEXT NOT NULL, name TEXT, created INTEGER, cal TEXT UNIQUE)',
  'CREATE TABLE IF NOT EXISTS sessions (th TEXT PRIMARY KEY, uid TEXT NOT NULL, created INTEGER, seen INTEGER, ua TEXT)',
  'CREATE INDEX IF NOT EXISTS sessions_uid ON sessions(uid)',
  'CREATE TABLE IF NOT EXISTS docs (uid TEXT NOT NULL, path TEXT NOT NULL, data TEXT, del INTEGER DEFAULT 0, t INTEGER, seq INTEGER, PRIMARY KEY (uid, path))',
  'CREATE INDEX IF NOT EXISTS docs_seq ON docs(uid, seq)',
  'CREATE TABLE IF NOT EXISTS hist (uid TEXT NOT NULL, path TEXT NOT NULL, data TEXT, t INTEGER, at INTEGER)',
  'CREATE INDEX IF NOT EXISTS hist_path ON hist(uid, path, at)',
  'CREATE TABLE IF NOT EXISTS subs (ep TEXT PRIMARY KEY, uid TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created INTEGER, fails INTEGER DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS subs_uid ON subs(uid)',
  'CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, at INTEGER NOT NULL, title TEXT, body TEXT, tag TEXT, url TEXT, badge INTEGER, sent INTEGER DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS outbox_due ON outbox(sent, at)',
  'CREATE INDEX IF NOT EXISTS outbox_uid ON outbox(uid, sent, at)',
  'CREATE TABLE IF NOT EXISTS resets (uid TEXT PRIMARY KEY, ch TEXT, exp INTEGER, tries INTEGER DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS tries (k TEXT PRIMARY KEY, n INTEGER, since INTEGER)',
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)',
  "INSERT OR IGNORE INTO meta (k, v) VALUES ('seq', '0')"
];
let schemaReady = null;
function ready(env) {
  if (!env.DB) fail(503, 'no_db', 'The Shepherd server has no database yet. Add the D1 binding called DB.');
  if (!schemaReady) schemaReady = env.DB.batch(SCHEMA.map(s => env.DB.prepare(s))).catch(e => { schemaReady = null; throw e; });
  return schemaReady;
}
const one = (env, sql, ...a) => env.DB.prepare(sql).bind(...a).first();
const all = async (env, sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results || [];
const run = (env, sql, ...a) => env.DB.prepare(sql).bind(...a).run();

/* ---------- accounts ---------- */
async function rateLimit(env, k, max, windowMs) {
  const t = now(); const row = await one(env, 'SELECT n, since FROM tries WHERE k = ?', k);
  if (row && t - row.since < windowMs) {
    if (row.n >= max) fail(429, 'slow_down', 'Too many tries. Wait 15 minutes and try again.');
    await run(env, 'UPDATE tries SET n = n + 1 WHERE k = ?', k);
  } else await run(env, 'INSERT OR REPLACE INTO tries (k, n, since) VALUES (?, 1, ?)', k, t);
}
async function newSession(env, uid, req) {
  const token = b64u(rand(32)); const t = now();
  await run(env, 'INSERT INTO sessions (th, uid, created, seen, ua) VALUES (?, ?, ?, ?, ?)', await sha256(token), uid, t, t, str(req.headers.get('User-Agent'), 160));
  return token;
}
async function auth(req, env) {
  const h = req.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) fail(401, 'signed_out', 'Please sign in again.');
  const th = await sha256(token);
  const s = await one(env, 'SELECT s.uid, s.seen, u.email, u.name, u.cal FROM sessions s JOIN users u ON u.id = s.uid WHERE s.th = ?', th);
  if (!s || now() - s.seen > SESSION_DAYS * 864e5) fail(401, 'signed_out', 'Please sign in again.');
  if (now() - s.seen > 3600e3) await run(env, 'UPDATE sessions SET seen = ? WHERE th = ?', now(), th);
  return { uid: s.uid, email: s.email, name: s.name, cal: s.cal, th };
}
const pub = u => ({ id: u.id || u.uid, email: u.email, name: u.name || '', cal: u.cal });

async function signup(req, env) {
  const b = await body(req); const email = cleanEmail(b.email);
  if (!okEmail(email)) fail(400, 'bad_email', 'That email address doesn\'t look right.');
  if (!okKey(b.key)) fail(400, 'bad_password', 'Choose a password of at least 8 characters.');
  await rateLimit(env, 'signup:' + (req.headers.get('CF-Connecting-IP') || 'ip'), 20, 3600e3);
  if (await one(env, 'SELECT id FROM users WHERE email = ?', email)) fail(409, 'exists', 'There is already an account with that email. Sign in instead.');
  const id = 'u_' + b64u(rand(12)), salt = b64u(rand(16)), cal = b64u(rand(24));
  await run(env, 'INSERT INTO users (id, email, pw, salt, name, created, cal) VALUES (?, ?, ?, ?, ?, ?, ?)', id, email, await sha256(salt + b.key), salt, str(b.name, 80), now(), cal);
  return json({ token: await newSession(env, id, req), user: pub({ id, email, name: str(b.name, 80), cal }) });
}
async function login(req, env) {
  const b = await body(req); const email = cleanEmail(b.email);
  if (!okEmail(email) || !okKey(b.key)) fail(400, 'bad_login', 'Check your email and password.');
  await rateLimit(env, 'login:' + email, 10, 15 * 60e3);
  const u = await one(env, 'SELECT * FROM users WHERE email = ?', email);
  if (!u || !same(await sha256(u.salt + b.key), u.pw)) fail(401, 'wrong_password', 'That email and password don\'t match.');
  await run(env, 'DELETE FROM tries WHERE k = ?', 'login:' + email);
  return json({ token: await newSession(env, u.id, req), user: pub(u) });
}
async function changePassword(req, env, me) {
  const b = await body(req);
  if (!okKey(b.key) || !okKey(b.newKey)) fail(400, 'bad_password', 'Choose a password of at least 8 characters.');
  await rateLimit(env, 'login:' + me.email, 10, 15 * 60e3);
  const u = await one(env, 'SELECT * FROM users WHERE id = ?', me.uid);
  if (!same(await sha256(u.salt + b.key), u.pw)) fail(401, 'wrong_password', 'Your current password isn\'t right.');
  const salt = b64u(rand(16));
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw = ?, salt = ? WHERE id = ?').bind(await sha256(salt + b.newKey), salt, me.uid),
    env.DB.prepare('DELETE FROM sessions WHERE uid = ? AND th != ?').bind(me.uid, me.th)
  ]);
  return json({ ok: true });
}
async function makeResetCode(env, uid) {
  const code = String(100000 + (new Uint32Array(rand(4).buffer)[0] % 900000));
  await run(env, 'INSERT OR REPLACE INTO resets (uid, ch, exp, tries) VALUES (?, ?, ?, 0)', uid, await sha256(uid + ':' + code), now() + 60 * 60e3);
  return code;
}
async function resetRequest(req, env) {
  const b = await body(req); const email = cleanEmail(b.email);
  const canEmail = !!(env.RESEND_API_KEY && env.MAIL_FROM);
  if (!okEmail(email)) fail(400, 'bad_email', 'That email address doesn\'t look right.');
  await rateLimit(env, 'reset:' + email, 5, 60 * 60e3);
  const u = await one(env, 'SELECT id FROM users WHERE email = ?', email);
  if (u && canEmail) {
    const code = await makeResetCode(env, u.id);
    await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [email], subject: 'Your Shepherd code: ' + code, text: 'Your Shepherd password reset code is ' + code + '.\n\nIt works for one hour. If you didn\'t ask for it, you can ignore this email.' }) }).catch(() => null);
  }
  return json({ emailed: canEmail });
}
async function resetConfirm(req, env) {
  const b = await body(req); const email = cleanEmail(b.email); const code = String(b.code || '').replace(/\D/g, '');
  if (!okEmail(email) || code.length !== 6 || !okKey(b.key)) fail(400, 'bad_code', 'Check the code and choose a password of at least 8 characters.');
  const u = await one(env, 'SELECT id, email, name, cal FROM users WHERE email = ?', email);
  const r = u && await one(env, 'SELECT * FROM resets WHERE uid = ?', u.id);
  if (!r || r.exp < now() || r.tries >= 5) fail(400, 'bad_code', 'That code has run out. Ask for a new one.');
  if (!same(await sha256(u.id + ':' + code), r.ch)) { await run(env, 'UPDATE resets SET tries = tries + 1 WHERE uid = ?', u.id); fail(400, 'bad_code', 'That code isn\'t right.'); }
  const salt = b64u(rand(16));
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw = ?, salt = ? WHERE id = ?').bind(await sha256(salt + b.key), salt, u.id),
    env.DB.prepare('DELETE FROM sessions WHERE uid = ?').bind(u.id),
    env.DB.prepare('DELETE FROM resets WHERE uid = ?').bind(u.id)
  ]);
  return json({ token: await newSession(env, u.id, req), user: pub(u) });
}
async function deleteAccount(req, env, me) {
  const b = await body(req);
  const u = await one(env, 'SELECT * FROM users WHERE id = ?', me.uid);
  if (!okKey(b.key) || !same(await sha256(u.salt + b.key), u.pw)) fail(401, 'wrong_password', 'Your password isn\'t right.');
  await env.DB.batch(['docs', 'hist', 'subs', 'outbox', 'resets', 'sessions'].map(t => env.DB.prepare('DELETE FROM ' + t + ' WHERE uid = ?').bind(me.uid)).concat([env.DB.prepare('DELETE FROM users WHERE id = ?').bind(me.uid)]));
  return json({ ok: true });
}

/* ---------- saving ---------- */
async function nextSeqs(env, n) {
  const row = await one(env, "UPDATE meta SET v = CAST(v AS INTEGER) + ? WHERE k = 'seq' RETURNING v", n);
  const top = Number(row.v); return top - n + 1;
}
async function pull(req, env, me) {
  const u = new URL(req.url); const since = Math.max(0, Number(u.searchParams.get('since')) || 0);
  const rows = await all(env, 'SELECT path, data, del, seq FROM docs WHERE uid = ? AND seq > ? ORDER BY seq LIMIT 501', me.uid, since);
  const more = rows.length > 500; if (more) rows.pop();
  return json({ docs: rows.map(r => ({ p: r.path, d: r.del ? null : JSON.parse(r.data), seq: r.seq })), seq: rows.length ? rows[rows.length - 1].seq : since, more });
}
async function push(req, env, me) {
  const b = await body(req); const ops = Array.isArray(b.ops) ? b.ops : [];
  if (!ops.length) return json({ ok: true, kept: [] });
  if (ops.length > MAX_OPS) fail(413, 'too_many', 'Too many changes at once.');
  const latest = new Map();
  for (const op of ops) {
    if (!op || !PATH_RE.test(op.p)) fail(400, 'bad_path', 'Something in that save isn\'t allowed.');
    const del = op.d === null || op.d === undefined;
    const data = del ? null : JSON.stringify(op.d);
    if (data && data.length > MAX_DOC) fail(413, 'too_big', 'One item is too large to save.');
    const t = Math.min(Number(op.t) || now(), now() + 5 * 60e3);
    const prev = latest.get(op.p); if (!prev || t >= prev.t) latest.set(op.p, { p: op.p, data, del, t });
  }
  const list = [...latest.values()];
  const existing = new Map();
  for (let i = 0; i < list.length; i += 80) {
    const chunk = list.slice(i, i + 80);
    const rows = await all(env, 'SELECT path, data, del, t FROM docs WHERE uid = ? AND path IN (' + chunk.map(() => '?').join(',') + ')', me.uid, ...chunk.map(x => x.p));
    rows.forEach(r => existing.set(r.path, r));
  }
  const kept = [], apply = [];
  for (const op of list) {
    const ex = existing.get(op.p);
    if (ex && (ex.t || 0) > op.t) { kept.push({ p: op.p, d: ex.del ? null : JSON.parse(ex.data) }); continue; }
    if (ex && !ex.del && ex.data === op.data) continue; // nothing changed
    if (ex && ex.del && op.del) continue;
    apply.push({ op, ex });
  }
  if (apply.length) {
    const first = await nextSeqs(env, apply.length); const t = now(); const stmts = [];
    apply.forEach(({ op, ex }, i) => {
      if (op.del) stmts.push(env.DB.prepare('DELETE FROM hist WHERE uid = ? AND path = ?').bind(me.uid, op.p)); // deleted at their request: no copies kept
      else if (ex && !ex.del) stmts.push(env.DB.prepare('INSERT INTO hist (uid, path, data, t, at) VALUES (?, ?, ?, ?, ?)').bind(me.uid, op.p, ex.data, ex.t, t));
      stmts.push(env.DB.prepare('INSERT INTO docs (uid, path, data, del, t, seq) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(uid, path) DO UPDATE SET data = excluded.data, del = excluded.del, t = excluded.t, seq = excluded.seq')
        .bind(me.uid, op.p, op.data, op.del ? 1 : 0, op.t, first + i));
    });
    for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
  }
  return json({ ok: true, kept, saved: apply.length });
}
async function history(req, env, me) {
  const p = new URL(req.url).searchParams.get('p') || '';
  if (!PATH_RE.test(p)) fail(400, 'bad_path');
  const rows = await all(env, 'SELECT data, t, at FROM hist WHERE uid = ? AND path = ? ORDER BY at DESC LIMIT 30', me.uid, p);
  return json({ versions: rows.map(r => ({ d: JSON.parse(r.data), t: r.t, at: r.at })) });
}

/* ---------- notifications (Web Push, RFC 8291 + VAPID RFC 8292) ---------- */
async function vapid(env) {
  const row = await one(env, "SELECT v FROM meta WHERE k = 'vapid'");
  if (row) return JSON.parse(row.v);
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const v = { pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), jwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
  await run(env, "INSERT OR IGNORE INTO meta (k, v) VALUES ('vapid', ?)", JSON.stringify(v));
  return JSON.parse((await one(env, "SELECT v FROM meta WHERE k = 'vapid'")).v);
}
async function vapidHeader(env, v, endpoint, cache) {
  const aud = new URL(endpoint).origin;
  if (cache && cache[aud]) return cache[aud];
  const key = await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || env.APP_URL || DEFAULT_APP_URL })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + claims));
  const h = 'vapid t=' + head + '.' + claims + '.' + b64u(sig) + ', k=' + v.pub;
  if (cache) cache[aud] = h;
  return h;
}
async function hkdf(salt, ikm, info, bytes) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bytes * 8));
}
export async function encryptPush(payload, p256dh, authSecret) {
  const ua = unb64u(p256dh), secret = unb64u(authSecret);
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(secret, shared, concat(enc.encode('WebPush: info\0'), ua, asPub), 32);
  const salt = rand(16);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(enc.encode(payload), new Uint8Array([2]))));
  const head = new Uint8Array(21); head.set(salt, 0); new DataView(head.buffer).setUint32(16, 4096); head[20] = 65;
  return concat(head, asPub, ct);
}
async function sendPush(env, v, sub, msg, cache) {
  const bodyBytes = await encryptPush(JSON.stringify(msg), sub.p256dh, sub.auth);
  const r = await fetch(sub.ep, { method: 'POST', headers: { 'Authorization': await vapidHeader(env, v, sub.ep, cache), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', 'TTL': '43200', 'Urgency': 'normal' }, body: bodyBytes });
  return r.status;
}
async function afterSend(env, sub, status) {
  if (status === 404 || status === 410) await run(env, 'DELETE FROM subs WHERE ep = ?', sub.ep);
  else if (status >= 400) await run(env, 'UPDATE subs SET fails = fails + 1 WHERE ep = ?', sub.ep);
  else if (sub.fails) await run(env, 'UPDATE subs SET fails = 0 WHERE ep = ?', sub.ep);
}
async function subscribe(req, env, me) {
  const b = await body(req); const s = b.sub || {};
  let host = ''; try { const u = new URL(s.endpoint); host = u.protocol === 'https:' ? u.hostname : ''; } catch (e) {}
  if (!host || !PUSH_HOSTS.test(host)) fail(400, 'bad_sub', 'This phone gave a notification address Shepherd can\'t use.');
  const p = s.keys && s.keys.p256dh, a = s.keys && s.keys.auth;
  if (!p || !a || unb64u(p).length !== 65 || unb64u(a).length !== 16) fail(400, 'bad_sub', 'This phone gave notification keys Shepherd can\'t use.');
  await run(env, 'INSERT INTO subs (ep, uid, p256dh, auth, created, fails) VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT(ep) DO UPDATE SET uid = excluded.uid, p256dh = excluded.p256dh, auth = excluded.auth, fails = 0', s.endpoint, me.uid, p, a, now());
  const n = await one(env, 'SELECT COUNT(*) AS n FROM subs WHERE uid = ?', me.uid);
  return json({ ok: true, devices: n.n });
}
async function unsubscribe(req, env, me) { const b = await body(req); await run(env, 'DELETE FROM subs WHERE ep = ? AND uid = ?', str(b.endpoint, 1000), me.uid); return json({ ok: true }); }
async function testPush(req, env, me) {
  const subs = await all(env, 'SELECT * FROM subs WHERE uid = ?', me.uid);
  if (!subs.length) fail(400, 'no_devices', 'Turn on notifications on this phone first.');
  const v = await vapid(env), cache = {}; const res = [];
  for (const s of subs) {
    const st = await sendPush(env, v, s, { title: 'Shepherd notifications are on', body: 'Each morning you\'ll hear who to message, who to reply to and who to check on, by name.', tag: 'test', url: './' }, cache).catch(() => 0);
    await afterSend(env, s, st); res.push(st);
  }
  return json({ ok: res.some(s => s >= 200 && s < 300), sent: res.filter(s => s >= 200 && s < 300).length, devices: subs.length });
}
async function schedule(req, env, me) {
  const b = await body(req); const t = now();
  const items = (Array.isArray(b.items) ? b.items : []).filter(x => x && Number(x.at) > t && Number(x.at) < t + 16 * 864e5 && x.title).slice(0, 400);
  const stmts = [env.DB.prepare('DELETE FROM outbox WHERE uid = ? AND sent = 0 AND at > ?').bind(me.uid, t)];
  items.forEach(x => stmts.push(env.DB.prepare('INSERT INTO outbox (uid, at, title, body, tag, url, badge, sent) VALUES (?, ?, ?, ?, ?, ?, ?, 0)')
    .bind(me.uid, Math.round(Number(x.at)), str(x.title, 120), str(x.body, 300), str(x.tag, 80), str(x.url, 200), Number.isFinite(Number(x.badge)) ? Math.max(0, Math.min(999, Number(x.badge) | 0)) : null)));
  for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
  return json({ ok: true, scheduled: items.length });
}
/* every 5 minutes: send what's due */
export async function sendDue(env, limit) {
  await ready(env);
  const t = now();
  const due = await all(env, 'SELECT * FROM outbox WHERE sent = 0 AND at <= ? AND at > ? ORDER BY at LIMIT ?', t, t - 3 * 3600e3, limit || 60);
  if (!due.length) return { sent: 0 };
  const uids = [...new Set(due.map(d => d.uid))];
  const subs = {};
  for (const u of uids) subs[u] = await all(env, 'SELECT * FROM subs WHERE uid = ?', u);
  const v = await vapid(env), cache = {}; let sent = 0;
  for (const d of due) {
    await run(env, 'UPDATE outbox SET sent = 1 WHERE id = ?', d.id);
    for (const s of subs[d.uid] || []) {
      const st = await sendPush(env, v, s, { title: d.title, body: d.body, tag: d.tag, url: d.url || './', badge: d.badge }, cache).catch(() => 0);
      await afterSend(env, s, st); if (st >= 200 && st < 300) sent++;
    }
  }
  return { sent, items: due.length };
}
async function tidy(env) {
  const t = now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM outbox WHERE at < ?').bind(t - 3 * 864e5),
    env.DB.prepare('DELETE FROM hist WHERE at < ?').bind(t - 365 * 864e5),
    env.DB.prepare('DELETE FROM sessions WHERE seen < ?').bind(t - SESSION_DAYS * 864e5),
    env.DB.prepare('DELETE FROM tries WHERE since < ?').bind(t - 864e5),
    env.DB.prepare('DELETE FROM resets WHERE exp < ?').bind(t),
    env.DB.prepare('DELETE FROM subs WHERE fails > 30')
  ]);
}

/* ---------- calendar link for the phone's own Calendar app ---------- */
function icsEsc(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, m => '\\' + m); }
function icsFold(line) { const out = []; let s = line; while (s.length > 74) { out.push(s.slice(0, 74)); s = ' ' + s.slice(74); } out.push(s); return out.join('\r\n'); }
function icsWhen(date, time, mins) {
  const d = String(date || '').replace(/-/g, '');
  if (!/^\d{8}$/.test(d)) return null;
  if (!/^\d\d:\d\d$/.test(time || '')) {
    const n = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8) + 1));
    return { start: 'DTSTART;VALUE=DATE:' + d, end: 'DTEND;VALUE=DATE:' + n.toISOString().slice(0, 10).replace(/-/g, '') };
  }
  const [h, m] = time.split(':').map(Number);
  const s = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), h, m)); const e = new Date(s.getTime() + (mins || 60) * 60e3);
  const f = x => x.toISOString().replace(/[-:]/g, '').slice(0, 15); // floating local time: the phone shows it at that clock time
  return { start: 'DTSTART:' + f(s), end: 'DTEND:' + f(e) };
}
const firstName = n => String(n || '').trim().split(/\s+/)[0];
export function calItems(rows) {
  const out = []; const cutoff = new Date(now() - 45 * 864e5).toISOString().slice(0, 10);
  for (const r of rows) {
    if (r.del || !r.data) continue;
    let d; try { d = JSON.parse(r.data); } catch (e) { continue; }
    const id = r.path.split('/').pop();
    if (r.path.indexOf('profile/contacts/') === 0 && d && d.name && d.nextStudy && d.nextStudy.date && d.status !== 'archived' && d.nextStudy.date >= cutoff)
      out.push({ uid: 'study-' + id + '-' + d.nextStudy.date, kind: 'study', id, title: 'Bible study – ' + firstName(d.name), date: d.nextStudy.date, time: d.nextStudy.time, desc: d.nextStudy.topic ? 'Study: ' + d.nextStudy.topic : '', mins: 60 });
    if (r.path.indexOf('profile/events/') === 0 && d && d.name && d.date && d.date >= cutoff && d.source !== 'calendar')
      out.push({ uid: 'event-' + id, kind: 'event', id, title: d.name, date: d.date, time: d.time, desc: d.place ? 'Where: ' + d.place : '', place: d.place, mins: 90 });
  }
  return out;
}
export function icsText(items, name) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Shepherd//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:' + icsEsc(name || 'Shepherd'), 'X-PUBLISHED-TTL:PT1H', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H'];
  for (const x of items) {
    const w = icsWhen(x.date, x.time, x.mins); if (!w) continue;
    L.push('BEGIN:VEVENT', 'UID:' + x.uid + '@shepherd', 'DTSTAMP:' + stamp, w.start, w.end, 'SUMMARY:' + icsEsc(x.title));
    if (x.desc) L.push('DESCRIPTION:' + icsEsc(x.desc));
    if (x.place) L.push('LOCATION:' + icsEsc(x.place));
    if (x.time) L.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEsc(x.title), 'TRIGGER:-PT60M', 'END:VALARM');
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(icsFold).join('\r\n') + '\r\n';
}
async function calendar(req, env, parts) {
  const token = (parts[1] || '').replace(/\.ics$/, '');
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return new Response('Not found', { status: 404 });
  const u = await one(env, 'SELECT id FROM users WHERE cal = ?', token);
  if (!u) return new Response('This calendar link has been replaced. Connect again from Shepherd.', { status: 404 });
  let rows;
  if (parts.length === 4) { // /cal/<token>/<study|event>/<id>.ics : one item, for "Add to phone calendar"
    const id = parts[3].replace(/\.ics$/, '');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return new Response('Not found', { status: 404 });
    rows = await all(env, 'SELECT path, data, del FROM docs WHERE uid = ? AND path = ?', u.id, (parts[2] === 'study' ? 'profile/contacts/' : 'profile/events/') + id);
  } else rows = await all(env, "SELECT path, data, del FROM docs WHERE uid = ? AND (path LIKE 'profile/contacts/%' OR path LIKE 'profile/events/%')", u.id);
  const items = calItems(rows).filter(x => parts.length !== 4 || x.kind === parts[2]);
  if (parts.length === 4 && !items.length) return new Response('That study or event isn\'t saved yet. Wait a moment and try again.', { status: 404 });
  return new Response(icsText(items, 'Shepherd'), { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': (parts.length === 4 ? 'inline' : 'inline') + '; filename="shepherd.ics"', 'Cache-Control': 'no-store' } });
}
async function newCalLink(req, env, me) { const cal = b64u(rand(24)); await run(env, 'UPDATE users SET cal = ? WHERE id = ?', cal, me.uid); return json({ cal }); }

/* ---------- admin: give a church member a reset code ---------- */
function adminPage(msg) {
  return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shepherd admin</title>' +
    '<style>body{font:17px system-ui;background:#FAF3DF;color:#241F18;max-width:440px;margin:40px auto;padding:0 16px}input,button{font:inherit;width:100%;padding:12px;margin:6px 0;border-radius:12px;border:1.5px solid #D8C8A2;box-sizing:border-box}button{background:#4E5A33;color:#fff;border:0;font-weight:700}.m{background:#fff;padding:14px;border-radius:12px;border:1.5px solid #D8C8A2}</style>' +
    '<h1>Shepherd: reset a password</h1>' + (msg ? '<p class="m">' + msg + '</p>' : '') +
    '<p>Make a one-hour reset code for someone who forgot their password. Give it to them in person or by message. In Shepherd they tap <b>Forgot password?</b> and enter it. Nobody here can see their contacts.</p>' +
    '<form method="post"><input name="admin" type="password" placeholder="Admin key" required><input name="email" type="email" placeholder="Their email" required><button>Make a reset code</button></form>', { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } });
}
async function admin(req, env) {
  if (!env.ADMIN_KEY) return adminPage('Add a secret called ADMIN_KEY to this Worker first (Settings → Variables and Secrets).');
  if (req.method !== 'POST') return adminPage('');
  const f = await req.formData();
  await rateLimit(env, 'admin', 20, 3600e3);
  if (!same(String(f.get('admin') || ''), env.ADMIN_KEY)) return adminPage('That admin key isn\'t right.');
  const email = cleanEmail(f.get('email'));
  const u = await one(env, 'SELECT id FROM users WHERE email = ?', email);
  if (!u) return adminPage('No Shepherd account uses ' + email.replace(/[<>&"]/g, '') + '.');
  return adminPage('Reset code for ' + email.replace(/[<>&"]/g, '') + ': <b style="font-size:28px;letter-spacing:.1em">' + await makeResetCode(env, u.id) + '</b><br>It works for one hour.');
}

/* ---------- routes ---------- */
async function route(req, env) {
  const url = new URL(req.url); const parts = url.pathname.split('/').filter(Boolean); const m = req.method;
  if (url.pathname === '/' || url.pathname === '/health') {
    let db = false; try { await ready(env); db = true; } catch (e) {}
    return json({ app: 'Shepherd', version: VERSION, db, email: !!(env.RESEND_API_KEY && env.MAIL_FROM), admin: !!env.ADMIN_KEY, origins: origins(env) });
  }
  if (parts[0] === 'cal') { await ready(env); return calendar(req, env, parts); }
  if (parts[0] === 'admin') { await ready(env); return admin(req, env); }
  if (parts[0] !== 'api') return json({ error: 'not_found' }, 404);
  await ready(env);
  const p = parts.slice(1).join('/');
  if (m === 'POST' && p === 'signup') return signup(req, env);
  if (m === 'POST' && p === 'login') return login(req, env);
  if (m === 'POST' && p === 'reset/request') return resetRequest(req, env);
  if (m === 'POST' && p === 'reset/confirm') return resetConfirm(req, env);
  if (m === 'GET' && p === 'push/key') return json({ key: (await vapid(env)).pub });
  const me = await auth(req, env);
  if (m === 'GET' && p === 'me') return json({ user: pub(me), devices: (await one(env, 'SELECT COUNT(*) AS n FROM subs WHERE uid = ?', me.uid)).n });
  if (m === 'POST' && p === 'logout') { await run(env, 'DELETE FROM sessions WHERE th = ?', me.th); return json({ ok: true }); }
  if (m === 'POST' && p === 'password') return changePassword(req, env, me);
  if (m === 'POST' && p === 'account/delete') return deleteAccount(req, env, me);
  if (m === 'GET' && p === 'docs') return pull(req, env, me);
  if (m === 'POST' && p === 'docs') return push(req, env, me);
  if (m === 'GET' && p === 'history') return history(req, env, me);
  if (m === 'POST' && p === 'push/sub') return subscribe(req, env, me);
  if (m === 'POST' && p === 'push/unsub') return unsubscribe(req, env, me);
  if (m === 'POST' && p === 'push/test') return testPush(req, env, me);
  if (m === 'POST' && p === 'schedule') return schedule(req, env, me);
  if (m === 'POST' && p === 'cal/new') return newCalLink(req, env, me);
  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(req, env) {
    const c = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: c });
    let res;
    try { res = await route(req, env); }
    catch (e) {
      if (e instanceof HttpError) res = json({ error: e.code, message: e.message }, e.status);
      else { console.error(e && e.stack || e); res = json({ error: 'server', message: 'Something went wrong on the Shepherd server. Your changes are kept on your phone.' }, 500); }
    }
    const h = new Headers(res.headers); Object.entries(c).forEach(([k, v]) => h.set(k, v));
    return new Response(res.body, { status: res.status, headers: h });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => { await sendDue(env, 60); if (new Date().getUTCHours() === 3 && new Date().getUTCMinutes() < 5) await tidy(env); })().catch(e => console.error(e && e.stack || e)));
  }
};
