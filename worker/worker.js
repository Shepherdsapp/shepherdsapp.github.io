/* ═══════════════════════════════════════════════════════════════════════════
   SHEPHERD — Cloudflare Worker (the server)
   Paste this whole file into a Cloudflare Worker (Edit code → select all → paste → Deploy).

   What it does
   • Accounts: everyone signs in with their own email and password. Each person's data is theirs only.
   • Saving:   every change from every phone is kept here, so nothing is lost if a phone is lost or reset.
               Earlier versions of each contact are kept too (Settings in the app can't remove them by accident).
   • Alerts:   sends phone notifications that name people ("Reply to Grace", "Message Daniel"), at the
               times the app works out. Works on Android and on iPhone (iOS 16.4+, app added to Home Screen).
   • QR code: people scan it, type their name, are added to your list, then WhatsApp opens for them.
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
        GMAIL_USER       Text    a Gmail address to email reset codes from (free), e.g. lostshepherdapp@gmail.com
        GMAIL_APP_PASSWORD Secret an App Password made in that Google account (Security → App passwords)
        RESEND_API_KEY   Secret  from resend.com, to email reset codes (needs your own domain on Resend)
        MAIL_FROM        Text    e.g. Shepherd <hello@yourchurch.org>
        INVITE_CODE      Text    the church invite code new people type to create an account.
                                 Change it any time; people already signed up are not affected.
                                 Leave it out and anyone can create an account.
   The database tables and the notification keys are created by this Worker the first time it runs.
   Open https://<this worker>/health to check: you should see "db":true.
   ═══════════════════════════════════════════════════════════════════════════ */

export const VERSION = 3;
const DEFAULT_ORIGINS = 'https://sitbackco.github.io';
const DEFAULT_APP_URL = 'https://sitbackco.github.io/shepherd/';
const MAX_DOC = 256 * 1024;
const MAX_OPS = 200;
const SESSION_DAYS = 180;
const SCHEMA_VERSION = '3';
const PATH_RE = /^profile(\/(contacts|events|disciples|prayers)\/[A-Za-z0-9_-]{1,80})?$/;
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
  'CREATE TABLE IF NOT EXISTS qrcodes (code TEXT PRIMARY KEY, uid TEXT UNIQUE NOT NULL, created INTEGER)',
  "INSERT OR IGNORE INTO meta (k, v) VALUES ('seq', '0')",
  "INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', '" + SCHEMA_VERSION + "')"
];
// The tables are set up once. After that each server start does one small read instead of 17 setup statements.
let schemaReady = null;
async function setUp(env) {
  let v = null;
  try { v = await env.DB.prepare("SELECT v FROM meta WHERE k = 'schema'").first('v'); } catch (e) { v = null; }
  if (v === SCHEMA_VERSION) return true;
  await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
  return true;
}
function ready(env) {
  if (!env.DB) fail(503, 'no_db', 'The Shepherd server has no database yet. Add the D1 binding called DB.');
  if (!schemaReady) schemaReady = setUp(env).catch(e => { schemaReady = null; throw e; });
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
const ipOf = req => req.headers.get('CF-Connecting-IP') || 'ip';
// the church invite code: case, spaces and dashes don't matter
const inviteNorm = s => String(s || '').toLowerCase().replace(/[\s-]+/g, '');

async function signup(req, env) {
  const b = await body(req); const email = cleanEmail(b.email);
  if (!okEmail(email)) fail(400, 'bad_email', 'That email address doesn\'t look right.');
  if (!okKey(b.key)) fail(400, 'bad_password', 'Choose a password of at least 8 characters.');
  await rateLimit(env, 'signup:' + ipOf(req), 20, 3600e3);
  if (env.INVITE_CODE && !same(inviteNorm(b.invite), inviteNorm(env.INVITE_CODE))) fail(403, 'bad_invite', 'That invite code isn\'t right. Ask the person who runs Shepherd at your church.');
  if (await one(env, 'SELECT id FROM users WHERE email = ?', email)) fail(409, 'exists', 'There is already an account with that email. Sign in instead.');
  if (!String(b.name || '').trim()) fail(400, 'bad_name', 'Add your name.');
  const id = 'u_' + b64u(rand(12)), salt = b64u(rand(16)), cal = b64u(rand(24));
  await run(env, 'INSERT INTO users (id, email, pw, salt, name, created, cal) VALUES (?, ?, ?, ?, ?, ?, ?)', id, email, await sha256(salt + b.key), salt, str(String(b.name).trim(), 80), now(), cal);
  return json({ token: await newSession(env, id, req), user: pub({ id, email, name: str(String(b.name).trim(), 80), cal }) });
}
async function login(req, env) {
  const b = await body(req); const email = cleanEmail(b.email);
  if (!okEmail(email) || !okKey(b.key)) fail(400, 'bad_login', 'Check your email and password.');
  // Wrong tries are counted per network address and email, so a stranger elsewhere can't lock the owner out.
  // A much higher limit per email alone still stops guessing spread over many addresses.
  const k1 = 'login:' + ipOf(req) + ':' + email, k2 = 'loginall:' + email;
  await rateLimit(env, k1, 10, 15 * 60e3);
  await rateLimit(env, k2, 100, 60 * 60e3);
  const u = await one(env, 'SELECT * FROM users WHERE email = ?', email);
  if (!u || !same(await sha256(u.salt + b.key), u.pw)) fail(401, 'wrong_password', 'That email and password don\'t match.');
  await run(env, 'DELETE FROM tries WHERE k = ?', k1);
  return json({ token: await newSession(env, u.id, req), user: pub(u) });
}
async function changePassword(req, env, me) {
  const b = await body(req);
  if (!okKey(b.key) || !okKey(b.newKey)) fail(400, 'bad_password', 'Choose a password of at least 8 characters.');
  await rateLimit(env, 'pw:' + me.uid, 10, 15 * 60e3);
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
/* ---------- emailing reset codes ----------
   Either through Gmail (free: GMAIL_USER + GMAIL_APP_PASSWORD, an app password from that Google account)
   or through Resend (RESEND_API_KEY + MAIL_FROM). Gmail is used when both are set. */
const CONTACT = 'lostshepherdapp@gmail.com';
const MAILT = {
  en: ['Your Shepherd code: {code}', 'Your Shepherd password reset code is {code}.', 'It works for one hour. If you didn\'t ask for it, you can ignore this email.', 'Questions or problems? Email {contact}.'],
  es: ['Tu código de Shepherd: {code}', 'Tu código para restablecer la contraseña de Shepherd es {code}.', 'Sirve durante una hora. Si no lo pediste, puedes ignorar este correo.', '¿Preguntas o problemas? Escribe a {contact}.'],
  fr: ['Votre code Shepherd : {code}', 'Votre code pour réinitialiser le mot de passe Shepherd est {code}.', 'Il est valable une heure. Si vous ne l\'avez pas demandé, ignorez cet e-mail.', 'Des questions ou un problème ? Écrivez à {contact}.'],
  pt: ['Seu código do Shepherd: {code}', 'Seu código para redefinir a senha do Shepherd é {code}.', 'Ele vale por uma hora. Se você não pediu, pode ignorar este e-mail.', 'Dúvidas ou problemas? Escreva para {contact}.'],
  nl: ['Je Shepherd-code: {code}', 'Je code om je Shepherd-wachtwoord opnieuw in te stellen is {code}.', 'Hij werkt een uur. Heb je hier niet om gevraagd, dan kun je deze e-mail negeren.', 'Vragen of problemen? Mail naar {contact}.'],
  pl: ['Twój kod Shepherd: {code}', 'Twój kod do zresetowania hasła Shepherd to {code}.', 'Działa przez godzinę. Jeśli o niego nie prosiłeś, zignoruj tę wiadomość.', 'Pytania lub problemy? Napisz na {contact}.'],
  pcm: ['Your Shepherd code: {code}', 'Your Shepherd password reset code na {code}.', 'E go work for one hour. If no be you ask for am, you fit ignore dis email.', 'Question or problem? Email {contact}.'],
  yo: ['Kóòdù Shepherd rẹ: {code}', 'Kóòdù láti tún ọ̀rọ̀ aṣínà Shepherd rẹ ṣe ni {code}.', 'Ó máa ṣiṣẹ́ fún wákàtí kan. Bí kì í bá ṣe ìwọ ló béèrè, o lè fojú fo ímeèlì yìí.', 'Ìbéèrè tàbí ìṣòro? Kọ ímeèlì sí {contact}.'],
  ig: ['Koodu Shepherd gị: {code}', 'Koodu iji tọgharịa okwuntughe Shepherd gị bụ {code}.', 'Ọ na-arụ ọrụ otu awa. Ọ bụrụ na ọ bụghị gị rịọrọ ya, ị nwere ike ileghara email a anya.', 'Ajụjụ ma ọ bụ nsogbu? Zitere {contact} email.'],
  'zh-Hans': ['你的 Shepherd 验证码：{code}', '你的 Shepherd 重设密码验证码是 {code}。', '验证码一小时内有效。如果不是你本人申请的，可以忽略这封邮件。', '有问题？请发邮件到 {contact}。'],
  'zh-Hant': ['你的 Shepherd 驗證碼：{code}', '你的 Shepherd 重設密碼驗證碼是 {code}。', '驗證碼一小時內有效。如果不是你本人申請的，可以忽略這封郵件。', '有問題？請寄信到 {contact}。'],
  ja: ['Shepherd の確認コード：{code}', 'Shepherd のパスワード再設定コードは {code} です。', '有効期間は 1 時間です。心当たりがない場合は、このメールを無視してください。', 'ご質問や問題は {contact} までメールでどうぞ。'],
  de: ['Dein Shepherd-Code: {code}', 'Dein Code zum Zurücksetzen deines Shepherd-Passworts lautet {code}.', 'Er gilt eine Stunde. Wenn du ihn nicht angefordert hast, ignoriere diese E-Mail.', 'Fragen oder Probleme? Schreib an {contact}.'],
  ru: ['Твой код Shepherd: {code}', 'Твой код для сброса пароля Shepherd: {code}.', 'Он действует один час. Если ты его не запрашивал(а), просто не обращай внимания на это письмо.', 'Вопросы или проблемы? Пиши на {contact}.'],
  lt: ['Tavo Shepherd kodas: {code}', 'Tavo Shepherd slaptažodžio atkūrimo kodas yra {code}.', 'Jis galioja vieną valandą. Jei jo neprašei, gali nekreipti dėmesio į šį laišką.', 'Klausimų ar problemų? Rašyk {contact}.']
};
export function resetMail(lang, code) {
  const T = MAILT[lang] || MAILT.en, f = s => s.replace('{code}', code).replace('{contact}', CONTACT);
  return { subject: f(T[0]), text: f(T[1]) + '\n\n' + f(T[2]) + '\n\n' + f(T[3]) + '\n' };
}
const b64 = s => { const b = enc.encode(s); let o = ''; for (let i = 0; i < b.length; i++) o += String.fromCharCode(b[i]); return btoa(o); };
// a plain email in the form mail servers expect: encoded subject, base64 body in lines of 76
export function mimeMessage(from, to, subject, text) {
  const body = b64(text).replace(/.{1,76}/g, '$&\r\n');
  return ['From: "Shepherd" <' + from + '>', 'To: <' + to + '>', 'Subject: =?UTF-8?B?' + b64(subject) + '?=', 'Date: ' + new Date().toUTCString(),
    'Message-ID: <' + b64u(rand(12)) + '@shepherd>', 'Reply-To: <' + CONTACT + '>', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body].join('\r\n');
}
// sends one email through Gmail's mail server (smtp.gmail.com, port 465, encrypted), signing in with an app password
export async function gmailSend(env, to, subject, text) {
  const connect = env.__connect || (await import('cloudflare:sockets')).connect;
  const sock = connect({ hostname: 'smtp.gmail.com', port: 465 }, { secureTransport: 'on', allowHalfOpen: false });
  const w = sock.writable.getWriter(), r = sock.readable.getReader(), dec = new TextDecoder();
  let buf = '';
  const reply = async () => {
    for (;;) {
      const lines = buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) if (/^\d{3} /.test(lines[i])) { const code = +lines[i].slice(0, 3); buf = lines.slice(i + 1).join('\r\n'); return code; }
      const { value, done } = await r.read(); if (done) throw new Error('mail server closed the connection');
      buf += dec.decode(value, { stream: true });
    }
  };
  const say = async (line, want) => { if (line !== null) await w.write(enc.encode(line + '\r\n')); const c = await reply(); if (!want.includes(c)) throw new Error('mail server said ' + c); return c; };
  try {
    await say(null, [220]);
    await say('EHLO shepherd', [250]);
    await say('AUTH PLAIN ' + b64('\0' + env.GMAIL_USER + '\0' + String(env.GMAIL_APP_PASSWORD).replace(/\s+/g, '')), [235]);
    await say('MAIL FROM:<' + env.GMAIL_USER + '>', [250]);
    await say('RCPT TO:<' + to + '>', [250, 251]);
    await say('DATA', [354]);
    await say(mimeMessage(env.GMAIL_USER, to, subject, text).replace(/\r\n\./g, '\r\n..') + '\r\n.', [250]);
    await w.write(enc.encode('QUIT\r\n')).catch(() => {});
    return true;
  } finally { try { await sock.close(); } catch (e) {} }
}
const mailOn = env => !!((env.GMAIL_USER && env.GMAIL_APP_PASSWORD) || (env.RESEND_API_KEY && env.MAIL_FROM));
async function sendResetMail(env, uid, email, code) {
  let lang = 'en';
  try { const p = await one(env, "SELECT data FROM docs WHERE uid = ? AND path = 'profile' AND del = 0", uid); if (p) lang = JSON.parse(p.data).lang || 'en'; } catch (e) {}
  const m = resetMail(lang, code);
  if (env.GMAIL_USER && env.GMAIL_APP_PASSWORD) return gmailSend(env, email, m.subject, m.text);
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [email], reply_to: CONTACT, subject: m.subject, text: m.text }) });
  if (!r.ok) throw new Error('Resend said ' + r.status);
  return true;
}
async function resetRequest(req, env) {
  const b = await body(req); const email = cleanEmail(b.email);
  const canEmail = mailOn(env);
  if (!okEmail(email)) fail(400, 'bad_email', 'That email address doesn\'t look right.');
  await rateLimit(env, 'reset:' + email, 5, 60 * 60e3);
  if (canEmail) { await rateLimit(env, 'resetip:' + ipOf(req), 20, 60 * 60e3); await rateLimit(env, 'resetday', 300, 864e5); } // keeps well inside Gmail's daily limit
  const u = await one(env, 'SELECT id FROM users WHERE email = ?', email);
  if (u && canEmail) {
    const code = await makeResetCode(env, u.id);
    try { await sendResetMail(env, u.id, email, code); } catch (e) { console.error('reset email failed: ' + (e && e.message)); } // the answer is the same either way, so nobody can tell who has an account
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
  await env.DB.batch(['docs', 'hist', 'subs', 'outbox', 'resets', 'sessions', 'qrcodes'].map(t => env.DB.prepare('DELETE FROM ' + t + ' WHERE uid = ?').bind(me.uid)).concat([env.DB.prepare('DELETE FROM users WHERE id = ?').bind(me.uid)]));
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
/* Two phones changing the same person: changes are merged field by field.
   Each save says what the phone started from (b). A field only this phone changed takes this phone's value,
   a field only the other phone changed keeps the other phone's value, and lists such as the activity log keep
   the entries added on both phones. Only when both phones changed the same field differently does the
   later change win. */
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const itemKey = x => (isObj(x) && x.id != null ? 'id:' + x.id : 'j:' + JSON.stringify(x));
function mergeList(base, theirs, mine, mineNewer) {
  const m = arr => new Map((Array.isArray(arr) ? arr : []).map(x => [itemKey(x), x]));
  const bm = m(base), tm = m(theirs), mm = m(mine);
  const out = [], seen = new Set();
  for (const x of theirs.concat(mine)) {
    const k = itemKey(x); if (seen.has(k)) continue; seen.add(k);
    if (bm.has(k) && (!tm.has(k) || !mm.has(k))) continue; // removed on one phone
    out.push(tm.has(k) && mm.has(k) ? mergeDoc(bm.get(k), tm.get(k), mm.get(k), mineNewer) : x);
  }
  if (out.length && out.every(x => isObj(x) && typeof x.t === 'number')) out.sort((a, b) => a.t - b.t);
  return out;
}
export function mergeDoc(base, theirs, mine, mineNewer) {
  if (eq(mine, base)) return theirs;
  if (eq(theirs, base) || eq(theirs, mine)) return mine;
  if (Array.isArray(theirs) && Array.isArray(mine)) return mergeList(base, theirs, mine, mineNewer);
  if (!isObj(theirs) || !isObj(mine)) return mineNewer ? mine : theirs;
  const b = isObj(base) ? base : {};
  const out = {};
  new Set([...Object.keys(theirs), ...Object.keys(mine)]).forEach(k => {
    let v;
    if (k === 'updatedAt' && typeof theirs[k] === 'number' && typeof mine[k] === 'number') v = Math.max(theirs[k], mine[k]);
    else v = mergeDoc(b[k], theirs[k], mine[k], mineNewer);
    if (v !== undefined) out[k] = v;
  });
  return out;
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
    const hasBase = Object.prototype.hasOwnProperty.call(op, 'b'); // newer phones say what they started from
    const prev = latest.get(op.p); if (!prev || t >= prev.t) latest.set(op.p, { p: op.p, data, del, t, hasBase, base: hasBase ? op.b : undefined });
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
    if (ex && ex.del && op.del) continue;
    if (op.del) { apply.push({ op, ex }); continue; } // a deletion (often at the person's request) always goes through
    if (!ex) { apply.push({ op, ex }); continue; }
    if (op.hasBase) {
      if (ex.del) {
        // deleted on another phone after this phone last saw it: stays deleted
        if (op.base) { kept.push({ p: op.p, d: null }); continue; }
        apply.push({ op, ex }); continue; // new on this phone, same path: keep it
      }
      const theirs = JSON.parse(ex.data), mine = JSON.parse(op.data);
      const merged = mergeDoc(op.base === null ? {} : op.base, theirs, mine, op.t >= (ex.t || 0));
      const mdata = JSON.stringify(merged);
      if (mdata !== op.data) kept.push({ p: op.p, d: merged });
      if (mdata === ex.data) continue; // nothing new for the server
      apply.push({ op: Object.assign({}, op, { data: mdata, t: Math.max(op.t, ex.t || 0) }), ex });
      continue;
    }
    // older app versions: the newer copy wins, but activity logs from both copies are kept
    if (ex.del) { if ((ex.t || 0) > op.t) { kept.push({ p: op.p, d: null }); continue; } apply.push({ op, ex }); continue; }
    const theirs = JSON.parse(ex.data), mine = JSON.parse(op.data);
    const win = (ex.t || 0) > op.t ? theirs : mine, lose = win === theirs ? mine : theirs;
    const out = Object.assign({}, win);
    if (Array.isArray(lose.log) && Array.isArray(win.log)) out.log = mergeList([], win.log, lose.log, false).slice(-300);
    const odata = JSON.stringify(out);
    if (odata !== op.data) kept.push({ p: op.p, d: out });
    if (odata === ex.data) continue;
    apply.push({ op: Object.assign({}, op, { data: odata, t: Math.max(op.t, ex.t || 0) }), ex });
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
  const b = await body(req).catch(() => ({}));
  const tt = typeof b.title === 'string' && b.title.trim() ? str(b.title, 120) : 'Shepherd notifications are on';
  const tb = typeof b.body === 'string' && b.body.trim() ? str(b.body, 240) : 'Each morning you\'ll hear who to message, who to reply to and who to check on, by name.';
  const subs = await all(env, 'SELECT * FROM subs WHERE uid = ?', me.uid);
  if (!subs.length) fail(400, 'no_devices', 'Turn on notifications on this phone first.');
  const v = await vapid(env), cache = {}; const res = [];
  for (const s of subs) {
    const st = await sendPush(env, v, s, { title: tt, body: tb, tag: 'test', url: './' }, cache).catch(() => 0);
    await afterSend(env, s, st); res.push(st);
  }
  return json({ ok: res.some(s => s >= 200 && s < 300), sent: res.filter(s => s >= 200 && s < 300).length, devices: subs.length });
}
// The app sends its whole plan for the next two weeks. Only the notifications that changed are written,
// so everyday use stays far inside the database's free daily write limit.
const outKey = x => [Math.round(Number(x.at)), x.title, x.body, x.tag, x.url, x.badge == null ? '' : x.badge].join('\u0001');
async function schedule(req, env, me) {
  const b = await body(req); const t = now();
  const items = (Array.isArray(b.items) ? b.items : []).filter(x => x && Number(x.at) > t && Number(x.at) < t + 16 * 864e5 && x.title).slice(0, 400)
    .map(x => ({ at: Math.round(Number(x.at)), title: str(x.title, 120), body: str(x.body, 300), tag: str(x.tag, 80), url: str(x.url, 200), badge: Number.isFinite(Number(x.badge)) && x.badge !== null && x.badge !== '' ? Math.max(0, Math.min(999, Number(x.badge) | 0)) : null }));
  const have = await all(env, 'SELECT id, at, title, body, tag, url, badge FROM outbox WHERE uid = ? AND sent = 0 AND at > ?', me.uid, t);
  const pool = new Map(); have.forEach(r => { const k = outKey(r); if (!pool.has(k)) pool.set(k, []); pool.get(k).push(r.id); });
  const add = [];
  items.forEach(x => { const ids = pool.get(outKey(x)); if (ids && ids.length) ids.pop(); else add.push(x); });
  const drop = [].concat(...pool.values());
  const stmts = [];
  for (let i = 0; i < drop.length; i += 80) { const c = drop.slice(i, i + 80); stmts.push(env.DB.prepare('DELETE FROM outbox WHERE uid = ? AND id IN (' + c.map(() => '?').join(',') + ')').bind(me.uid, ...c)); }
  add.forEach(x => stmts.push(env.DB.prepare('INSERT INTO outbox (uid, at, title, body, tag, url, badge, sent) VALUES (?, ?, ?, ?, ?, ?, ?, 0)').bind(me.uid, x.at, x.title, x.body, x.tag, x.url, x.badge)));
  for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
  return json({ ok: true, scheduled: items.length, added: add.length, removed: drop.length });
}
/* every 5 minutes: send what's due */
// Each notification is marked sent only after it has been tried, so if a run is stopped part-way the rest
// go out on the next run. If every phone was unreachable for a moment it is tried again (for up to 3 hours).
export async function sendDue(env, limit) {
  await ready(env);
  const t = now();
  const due = await all(env, 'SELECT * FROM outbox WHERE sent = 0 AND at <= ? AND at > ? ORDER BY at LIMIT ?', t, t - 3 * 3600e3, limit || 40);
  if (!due.length) return { sent: 0 };
  const subs = {};
  for (const u of [...new Set(due.map(d => d.uid))]) subs[u] = await all(env, 'SELECT * FROM subs WHERE uid = ?', u);
  const v = await vapid(env), cache = {}; let sent = 0, retry = 0;
  for (const d of due) {
    let good = 0, later = 0;
    const list = subs[d.uid] || [];
    for (const s of list) {
      const st = await sendPush(env, v, s, { title: d.title, body: d.body, tag: d.tag, url: d.url || './', badge: d.badge }, cache).catch(() => 0);
      await afterSend(env, s, st);
      if (st >= 200 && st < 300) good++; else if (!st || st === 429 || st >= 500) later++;
    }
    sent += good;
    if (list.length && !good && later === list.length) { retry++; continue; } // phones unreachable right now: try next run
    await run(env, "UPDATE outbox SET sent = 1, title = '', body = '', url = '' WHERE id = ?", d.id); // once sent, only the time is kept (for 3 days)
  }
  return { sent, items: due.length, retry };
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
function icsEsc(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/[,;]/g, m => '\\' + m); }
// lines are folded at 75 bytes (not letters), never splitting a letter, as calendar apps expect
export function icsFold(line) {
  const out = []; let cur = '', bytes = 0, max = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > max) { out.push(cur); cur = ' '; bytes = 1; max = 75; }
    cur += ch; bytes += n;
  }
  out.push(cur); return out.join('\r\n');
}
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
// calendar words in the language the owner uses Shepherd in
const CAL = {"es":{"study":"Estudio bíblico","studyT":"Estudio: {0}","where":"Dónde: {0}"},"fr":{"study":"Étude biblique","studyT":"Étude : {0}","where":"Lieu : {0}"},"pt":{"study":"Estudo bíblico","studyT":"Estudo: {0}","where":"Onde: {0}"},"nl":{"study":"Bijbelstudie","studyT":"Studie: {0}","where":"Waar: {0}"},"pl":{"study":"Studium biblijne","studyT":"Studium: {0}","where":"Gdzie: {0}"},"pcm":{"study":"Bible study","studyT":"Study: {0}","where":"Where: {0}"},"yo":{"study":"Ẹ̀kọ́ Bíbélì","studyT":"Ẹ̀kọ́: {0}","where":"Ibo: {0}"},"ig":{"study":"Ọmụmụ Baịbụl","studyT":"Ọmụmụ: {0}","where":"Ebee: {0}"},"zh-Hans":{"study":"查经","studyT":"查经：{0}","where":"地点：{0}"},"zh-Hant":{"study":"查經","studyT":"查經：{0}","where":"地點：{0}"},"ja":{"study":"聖書研究","studyT":"研究：{0}","where":"場所：{0}"},"de":{"study":"Bibelstudium","studyT":"Studie: {0}","where":"Ort: {0}"},"ru":{"study":"Изучение Библии","studyT":"Изучение: {0}","where":"Где: {0}"},"lt":{"study":"Biblijos studija","studyT":"Studija: {0}","where":"Kur: {0}"}};
export function calItems(rows) {
  const out = []; const cutoff = new Date(now() - 45 * 864e5).toISOString().slice(0, 10);
  let lang = 'en'; for (const r of rows) if (r.path === 'profile' && !r.del && r.data) { try { lang = JSON.parse(r.data).lang || 'en'; } catch (e) {} }
  const C = CAL[lang] || { study: 'Bible study', studyT: 'Study: {0}', where: 'Where: {0}' };
  for (const r of rows) {
    if (r.del || !r.data) continue;
    let d; try { d = JSON.parse(r.data); } catch (e) { continue; }
    const id = r.path.split('/').pop();
    if (r.path.indexOf('profile/contacts/') === 0 && d && d.name && d.nextStudy && d.nextStudy.date && d.status !== 'archived' && d.nextStudy.date >= cutoff)
      out.push({ uid: 'study-' + id + '-' + d.nextStudy.date, kind: 'study', id, title: C.study + ' – ' + firstName(d.name), date: d.nextStudy.date, time: d.nextStudy.time, desc: d.nextStudy.topic ? C.studyT.replace('{0}', d.nextStudy.topic) : '', mins: 60 });
    if (r.path.indexOf('profile/events/') === 0 && d && d.name && d.date && d.date >= cutoff && d.source !== 'calendar')
      out.push({ uid: 'event-' + id, kind: 'event', id, title: d.name, date: d.date, time: d.time, desc: d.place ? C.where.replace('{0}', d.place) : '', place: d.place, mins: 90 });
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
    rows = await all(env, "SELECT path, data, del FROM docs WHERE uid = ? AND (path = ? OR path = 'profile')", u.id, (parts[2] === 'study' ? 'profile/contacts/' : 'profile/events/') + id);
  } else rows = await all(env, "SELECT path, data, del FROM docs WHERE uid = ? AND (path = 'profile' OR path LIKE 'profile/contacts/%' OR path LIKE 'profile/events/%')", u.id);
  const items = calItems(rows).filter(x => parts.length !== 4 || x.kind === parts[2]);
  if (parts.length === 4 && !items.length) return new Response('That study or event isn\'t saved yet. Wait a moment and try again.', { status: 404 });
  return new Response(icsText(items, 'Shepherd'), { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': (parts.length === 4 ? 'inline' : 'inline') + '; filename="shepherd.ics"', 'Cache-Control': 'no-store' } });
}
async function newCalLink(req, env, me) { const cal = b64u(rand(24)); await run(env, 'UPDATE users SET cal = ? WHERE id = ?', cal, me.uid); return json({ cal }); }

/* ---------- QR code: a hello page that adds the person to your list, then opens WhatsApp ---------- */
const HI = {
  en: { title: 'Say hi to {name}', lead: '{name} uses Shepherd to keep in touch. Type your name, then WhatsApp opens so you can send a message.', yourName: 'Your name', yourNum: 'Your WhatsApp number (optional)', go: 'Continue to WhatsApp', privacy: 'Your name and number go only to {name}.', notReady: 'This QR code isn\'t ready yet. Ask {name} to add their WhatsApp number in Shepherd.', needName: 'Please type your name.', slow: 'Too many tries. Please wait a little and try again.', pushT: '{name} scanned your QR code', pushB: 'They should message you on WhatsApp now. Tap to see them.', agree: "I'm happy for {name} to keep my name and number and stay in touch.", needAgree: "Please tick the box to say you're happy to be added.", privLink: "How Shepherd uses your details" },
  es: { title: 'Saluda a {name}', lead: '{name} usa Shepherd para mantenerse en contacto. Escribe tu nombre y se abrirá WhatsApp para que puedas enviar un mensaje.', yourName: 'Tu nombre', yourNum: 'Tu número de WhatsApp (opcional)', go: 'Continuar a WhatsApp', privacy: 'Tu nombre y número solo los verá {name}.', notReady: 'Este código QR aún no está listo. Pídele a {name} que añada su número de WhatsApp en Shepherd.', needName: 'Escribe tu nombre, por favor.', slow: 'Demasiados intentos. Espera un poco y vuelve a intentarlo.', pushT: '{name} escaneó tu código QR', pushB: 'Debería escribirte por WhatsApp ahora. Toca para verlo.', agree: "Acepto que {name} guarde mi nombre y mi número y siga en contacto conmigo.", needAgree: "Marca la casilla para confirmar que aceptas que te añada.", privLink: "Cómo usa Shepherd tus datos" },
  fr: { title: 'Dites bonjour à {name}', lead: '{name} utilise Shepherd pour garder le contact. Écrivez votre nom, puis WhatsApp s\'ouvre pour envoyer un message.', yourName: 'Votre nom', yourNum: 'Votre numéro WhatsApp (facultatif)', go: 'Continuer vers WhatsApp', privacy: 'Votre nom et votre numéro sont envoyés uniquement à {name}.', notReady: 'Ce code QR n\'est pas encore prêt. Demandez à {name} d\'ajouter son numéro WhatsApp dans Shepherd.', needName: 'Veuillez écrire votre nom.', slow: 'Trop de tentatives. Patientez un peu et réessayez.', pushT: '{name} a scanné votre code QR', pushB: 'Cette personne devrait vous écrire sur WhatsApp. Touchez pour la voir.', agree: "J'accepte que {name} garde mon nom et mon numéro et reste en contact avec moi.", needAgree: "Cochez la case pour confirmer que vous acceptez d'être ajouté.", privLink: "Comment Shepherd utilise vos coordonnées" },
  pt: { title: 'Diga olá a {name}', lead: '{name} usa o Shepherd para manter contacto. Escreva o seu nome e o WhatsApp abre para enviar uma mensagem.', yourName: 'O seu nome', yourNum: 'O seu número de WhatsApp (opcional)', go: 'Continuar para o WhatsApp', privacy: 'O seu nome e número vão apenas para {name}.', notReady: 'Este código QR ainda não está pronto. Peça a {name} para adicionar o número de WhatsApp no Shepherd.', needName: 'Por favor, escreva o seu nome.', slow: 'Demasiadas tentativas. Espere um pouco e tente de novo.', pushT: '{name} leu o seu código QR', pushB: 'Deve enviar-lhe uma mensagem no WhatsApp agora. Toque para ver.', agree: "Concordo que {name} guarde o meu nome e número e mantenha contacto comigo.", needAgree: "Marque a caixa para confirmar que concorda em ser adicionado.", privLink: "Como o Shepherd usa os seus dados" },
  nl: { title: 'Zeg hallo tegen {name}', lead: '{name} gebruikt Shepherd om contact te houden. Typ je naam, daarna opent WhatsApp zodat je een bericht kunt sturen.', yourName: 'Je naam', yourNum: 'Je WhatsApp-nummer (optioneel)', go: 'Verder naar WhatsApp', privacy: 'Je naam en nummer gaan alleen naar {name}.', notReady: 'Deze QR-code is nog niet klaar. Vraag {name} om een WhatsApp-nummer toe te voegen in Shepherd.', needName: 'Typ je naam.', slow: 'Te veel pogingen. Wacht even en probeer het opnieuw.', pushT: '{name} heeft je QR-code gescand', pushB: 'Diegene stuurt je nu een WhatsApp-bericht. Tik om te bekijken.', agree: "Ik vind het goed dat {name} mijn naam en nummer bewaart en contact houdt.", needAgree: "Vink het vakje aan om te laten weten dat je toegevoegd wilt worden.", privLink: "Hoe Shepherd je gegevens gebruikt" },
  pl: { title: 'Przywitaj się z {name}', lead: '{name} używa Shepherd, by być w kontakcie. Wpisz swoje imię, a potem otworzy się WhatsApp, żebyś mógł wysłać wiadomość.', yourName: 'Twoje imię', yourNum: 'Twój numer WhatsApp (opcjonalnie)', go: 'Przejdź do WhatsApp', privacy: 'Twoje imię i numer trafią tylko do {name}.', notReady: 'Ten kod QR nie jest jeszcze gotowy. Poproś {name} o dodanie numeru WhatsApp w Shepherd.', needName: 'Wpisz swoje imię.', slow: 'Zbyt wiele prób. Odczekaj chwilę i spróbuj ponownie.', pushT: '{name} zeskanował(a) Twój kod QR', pushB: 'Powinien(na) teraz napisać do Ciebie na WhatsApp. Dotknij, aby zobaczyć.', agree: "Zgadzam się, aby {name} przechowywał(a) moje imię i numer i utrzymywał(a) ze mną kontakt.", needAgree: "Zaznacz pole, aby potwierdzić, że zgadzasz się na dodanie.", privLink: "Jak Shepherd używa Twoich danych" },
  pcm: { title: 'Greet {name}', lead: '{name} dey use Shepherd take keep in touch. Type your name, then WhatsApp go open make you fit send message.', yourName: 'Your name', yourNum: 'Your WhatsApp number (if you want)', go: 'Go WhatsApp', privacy: 'Na only {name} go see your name and number.', notReady: 'Dis QR code never ready. Tell {name} make e add im WhatsApp number for Shepherd.', needName: 'Abeg type your name.', slow: 'You don try too many times. Wait small, then try again.', pushT: '{name} don scan your QR code', pushB: 'E suppose message you for WhatsApp now. Tap make you see am.', agree: "I gree make {name} keep my name and number and dey in touch with me.", needAgree: "Abeg tick di box to show say you gree make dem add you.", privLink: "How Shepherd dey use your details" },
  yo: { title: 'Kí {name}', lead: '{name} ń lo Shepherd láti máa bá àwọn ènìyàn sọ̀rọ̀. Kọ orúkọ rẹ, lẹ́yìn náà WhatsApp yóò ṣí kí o lè fi ìfiránṣẹ́ ránṣẹ́.', yourName: 'Orúkọ rẹ', yourNum: 'Nọ́mbà WhatsApp rẹ (kò pọn dandan)', go: 'Tẹ̀síwájú sí WhatsApp', privacy: '{name} nìkan ni yóò rí orúkọ àti nọ́mbà rẹ.', notReady: 'Kóòdù QR yìí kò tíì ṣetán. Sọ fún {name} kí ó fi nọ́mbà WhatsApp rẹ̀ kún un nínú Shepherd.', needName: 'Jọ̀wọ́ kọ orúkọ rẹ.', slow: 'O ti gbìyànjú lọ́pọ̀ ìgbà. Dúró díẹ̀ kí o tún gbìyànjú.', pushT: '{name} ti ṣàyẹ̀wò kóòdù QR rẹ', pushB: 'Ó yẹ kí ó fi ìfiránṣẹ́ ránṣẹ́ sí ọ lórí WhatsApp báyìí. Tẹ̀ láti rí i.', agree: "Inú mi dùn kí {name} tọ́jú orúkọ àti nọ́mbà mi kí ó sì máa bá mi sọ̀rọ̀.", needAgree: "Jọ̀wọ́ fi àmì sí àpótí náà láti fi hàn pé inú rẹ dùn kí a fi ọ́ kún un.", privLink: "Bí Shepherd ṣe ń lo àwọn àlàyé rẹ" },
  ig: { title: 'Kelee {name}', lead: '{name} na-eji Shepherd na-akpakọrịta. Dee aha gị, mgbe ahụ WhatsApp ga-emeghe ka ị zitere ozi.', yourName: 'Aha gị', yourNum: 'Nọmba WhatsApp gị (ọ bụghị iwu)', go: 'Gaa n\'ihu na WhatsApp', privacy: 'Ọ bụ naanị {name} ga-ahụ aha na nọmba gị.', notReady: 'Koodu QR a adịbeghị njikere. Gwa {name} ka ọ tinye nọmba WhatsApp ya na Shepherd.', needName: 'Biko dee aha gị.', slow: 'Ị nwalere ọtụtụ ugboro. Chere obere oge ma nwaa ọzọ.', pushT: '{name} enyochala koodu QR gị', pushB: 'O kwesịrị iziga gị ozi na WhatsApp ugbu a. Pịa ka ịhụ ya.', agree: "Ekwenyere m ka {name} debe aha m na nọmba m ma na-akpọtụrụ m.", needAgree: "Biko kaa igbe ahụ akara iji gosi na i kwenyere ka e tinye gị.", privLink: "Otú Shepherd si eji nkọwa gị" },
  'zh-Hans': { title: '向{name}问好', lead: '{name}用 Shepherd 保持联系。输入你的名字，然后会打开 WhatsApp，方便你发送消息。', yourName: '你的名字', yourNum: '你的 WhatsApp 号码（可选）', go: '继续前往 WhatsApp', privacy: '你的名字和号码只会发给{name}。', notReady: '这个二维码还不能用。请让{name}在 Shepherd 里添加 WhatsApp 号码。', needName: '请输入你的名字。', slow: '尝试次数太多。请稍等片刻再试。', pushT: '{name}扫描了你的二维码', pushB: '对方现在应该会在 WhatsApp 上给你发消息。点按查看。', agree: "我同意{name}保存我的名字和号码，并与我保持联系。", needAgree: "请勾选方框，表示你同意被添加。", privLink: "Shepherd 如何使用你的资料" },
  'zh-Hant': { title: '向{name}問好', lead: '{name}用 Shepherd 保持聯絡。輸入你的名字，然後會打開 WhatsApp，方便你傳送訊息。', yourName: '你的名字', yourNum: '你的 WhatsApp 號碼（可選）', go: '繼續前往 WhatsApp', privacy: '你的名字和號碼只會傳給{name}。', notReady: '這個 QR 碼還不能使用。請{name}在 Shepherd 加入 WhatsApp 號碼。', needName: '請輸入你的名字。', slow: '嘗試次數太多。請稍候再試。', pushT: '{name}掃描了你的 QR 碼', pushB: '對方現在應該會在 WhatsApp 傳訊息給你。點按查看。', agree: "我同意{name}保存我的名字和號碼，並與我保持聯絡。", needAgree: "請勾選方框，表示你同意被加入。", privLink: "Shepherd 如何使用你的資料" },
  ja: { title: '{name}さんにあいさつ', lead: '{name}さんは Shepherd で連絡を取り合っています。名前を入力すると WhatsApp が開き、メッセージを送れます。', yourName: 'お名前', yourNum: 'WhatsApp の番号（任意）', go: 'WhatsApp へ進む', privacy: 'お名前と番号は{name}さんにだけ届きます。', notReady: 'この QR コードはまだ使えません。{name}さんに Shepherd で WhatsApp の番号を登録してもらってください。', needName: 'お名前を入力してください。', slow: '試行回数が多すぎます。少し待ってからもう一度お試しください。', pushT: '{name}さんが QR コードを読み取りました', pushB: 'まもなく WhatsApp でメッセージが届くはずです。タップして確認。', agree: "{name}さんが私の名前と番号を保存し、連絡を取り合うことに同意します。", needAgree: "追加に同意する場合は、チェックを入れてください。", privLink: "Shepherd での情報の扱い" },
  de: { title: 'Sag {name} Hallo', lead: '{name} nutzt Shepherd, um in Kontakt zu bleiben. Gib deinen Namen ein, dann öffnet sich WhatsApp, damit du eine Nachricht senden kannst.', yourName: 'Dein Name', yourNum: 'Deine WhatsApp-Nummer (optional)', go: 'Weiter zu WhatsApp', privacy: 'Dein Name und deine Nummer gehen nur an {name}.', notReady: 'Dieser QR-Code ist noch nicht bereit. Bitte {name}, in Shepherd eine WhatsApp-Nummer einzutragen.', needName: 'Bitte gib deinen Namen ein.', slow: 'Zu viele Versuche. Bitte warte kurz und versuche es erneut.', pushT: '{name} hat deinen QR-Code gescannt', pushB: 'Die Person sollte dir jetzt auf WhatsApp schreiben. Tippe, um sie zu sehen.', agree: "Ich bin einverstanden, dass {name} meinen Namen und meine Nummer speichert und mit mir in Kontakt bleibt.", needAgree: "Bitte hake das Kästchen an, wenn du hinzugefügt werden möchtest.", privLink: "Wie Shepherd deine Angaben verwendet" },
  ru: { title: 'Поздоровайтесь с {name}', lead: '{name} использует Shepherd, чтобы оставаться на связи. Введите своё имя, и откроется WhatsApp, чтобы вы могли отправить сообщение.', yourName: 'Ваше имя', yourNum: 'Ваш номер WhatsApp (необязательно)', go: 'Перейти в WhatsApp', privacy: 'Ваше имя и номер увидит только {name}.', notReady: 'Этот QR-код ещё не готов. Попросите {name} добавить номер WhatsApp в Shepherd.', needName: 'Пожалуйста, введите своё имя.', slow: 'Слишком много попыток. Подождите немного и попробуйте снова.', pushT: '{name} отсканировал(а) ваш QR-код', pushB: 'Сейчас вам должны написать в WhatsApp. Нажмите, чтобы посмотреть.', agree: "Я согласен(на), чтобы {name} сохранил(а) моё имя и номер и оставался(лась) на связи.", needAgree: "Отметьте галочку, чтобы подтвердить согласие на добавление.", privLink: "Как Shepherd использует ваши данные" },
  lt: { title: 'Pasisveikinkite su {name}', lead: '{name} naudoja Shepherd, kad palaikytų ryšį. Įrašykite savo vardą, tada atsidarys WhatsApp ir galėsite parašyti žinutę.', yourName: 'Jūsų vardas', yourNum: 'Jūsų WhatsApp numeris (nebūtina)', go: 'Tęsti į WhatsApp', privacy: 'Jūsų vardą ir numerį matys tik {name}.', notReady: 'Šis QR kodas dar neparuoštas. Paprašykite {name} įrašyti WhatsApp numerį Shepherd programėlėje.', needName: 'Įrašykite savo vardą.', slow: 'Per daug bandymų. Palaukite ir bandykite dar kartą.', pushT: '{name} nuskenavo jūsų QR kodą', pushB: 'Netrukus turėtų parašyti jums per WhatsApp. Palieskite, kad pamatytumėte.', agree: "Sutinku, kad {name} išsaugotų mano vardą ir numerį ir palaikytų su manimi ryšį.", needAgree: "Pažymėkite langelį, kad sutinkate būti pridėti.", privLink: "Kaip Shepherd naudoja jūsų duomenis" }
};
const hiT = (lang, k, name) => String((HI[lang] || HI.en)[k] || HI.en[k]).replace(/\{name\}/g, name);
const htmlEsc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// the standard first message, in the language the owner uses Shepherd in (Settings can change it)
const HI_INTRO = {
 "es": "¡Hola, encantado de conocerte! Conseguí tu contacto con Shepherd. Espero saber de ti pronto.",
 "fr": "Bonjour, ravi de te rencontrer ! J'ai eu ton contact grâce à Shepherd. J'espère avoir de tes nouvelles bientôt.",
 "pt": "Oi, prazer em te conhecer! Peguei seu contato pelo Shepherd. Espero ter notícias suas em breve.",
 "nl": "Hoi, leuk je te ontmoeten! Ik heb je contact via Shepherd. Ik hoop snel van je te horen.",
 "pl": "Cześć, miło Cię poznać! Mam Twój kontakt przez Shepherd. Mam nadzieję, że wkrótce się odezwiesz.",
 "pcm": "Hi, e sweet me to meet you! I get your contact from Shepherd. I hope to hear from you soon.",
 "yo": "Báwo ni, inú mi dùn láti pàdé rẹ! Mo rí nọ́ńbà rẹ láti Shepherd. Mo nírètí láti gbọ́ láti ọ̀dọ̀ rẹ láìpẹ́.",
 "ig": "Ndewo, ọ dị m ụtọ izute gị! Enwetara m kọntaktị gị site na Shepherd. Ana m atụ anya ịnụ n'aka gị n'oge na-adịghị anya.",
 "zh-Hans": "你好，很高兴认识你！我通过 Shepherd 得到了你的联系方式。希望很快收到你的消息。",
 "zh-Hant": "你好，很高興認識你！我透過 Shepherd 得到了你的聯絡方式。希望很快收到你的訊息。",
 "ja": "こんにちは、お会いできてうれしいです！Shepherd で連絡先を知りました。またお話しできるのを楽しみにしています。",
 "de": "Hallo, schön dich kennenzulernen! Ich habe deinen Kontakt über Shepherd. Ich freue mich, bald von dir zu hören.",
 "ru": "Привет, рад(а) знакомству! Я получил(а) твой контакт через Shepherd. Надеюсь скоро получить от тебя весточку.",
 "lt": "Labas, malonu susipažinti! Tavo kontaktą gavau per Shepherd. Tikiuosi greitai išgirsti iš tavęs."
};
// [code, name, dialling code, length of a local number without its first 0 (0 = varies)] — the same table as the app
const COUNTRIES = [['GB', 'United Kingdom', '44', 10], ['NG', 'Nigeria', '234', 10], ['GH', 'Ghana', '233', 9], ['IE', 'Ireland', '353', 9], ['US', 'United States / Canada', '1', 10], ['FR', 'France', '33', 9], ['DE', 'Germany', '49', 0], ['NL', 'Netherlands', '31', 9], ['ES', 'Spain', '34', 9], ['PT', 'Portugal', '351', 9], ['PL', 'Poland', '48', 9], ['LT', 'Lithuania', '370', 8], ['RU', 'Russia', '7', 10], ['JP', 'Japan', '81', 0], ['CN', 'China', '86', 11], ['HK', 'Hong Kong', '852', 8], ['TW', 'Taiwan', '886', 9], ['ZA', 'South Africa', '27', 9], ['KE', 'Kenya', '254', 9], ['IN', 'India', '91', 10], ['BR', 'Brazil', '55', 0], ['CM', 'Cameroon', '237', 9], ['ZW', 'Zimbabwe', '263', 9], ['JM', 'Jamaica', '1', 10]];
// a phone number as WhatsApp wants it (digits with the country code); numbers starting with + are used as typed
export function waNum(p, country) {
  if (!p) return '';
  const raw = String(p).trim(); let d = raw.replace(/\D/g, '');
  const hc = COUNTRIES.find(c => c[0] === country) || COUNTRIES[0];
  if (!d) return '';
  if (raw.charAt(0) === '+' || d.indexOf('00') === 0) {
    if (d.indexOf('00') === 0 && raw.charAt(0) !== '+') d = d.slice(2);
    for (const c of COUNTRIES) { const cc = c[2]; if (d.indexOf(cc + '0') === 0 && d.length > cc.length + 8) { d = cc + d.slice(cc.length + 1); break; } }
    return d.length >= 8 && d.length <= 15 ? d : '';
  }
  if (d.charAt(0) === '0') { const nat = d.slice(1); if (hc[3] && nat.length !== hc[3]) return ''; if (nat.length < 6) return ''; return hc[2] + nat; }
  if (hc[3] && d.length === hc[3]) return hc[2] + d;
  return d.length >= 8 && d.length <= 15 ? d : '';
}
const DEFAULT_INTRO = 'Hi, nice to meet you, I got your contact from Shepherd! Hoping to hear from you soon.';
const OLD_INTRO = "Hi! It was great meeting you today. Here's my number so we can keep in touch about studying the Bible.";
async function qrCode(req, env, me) {
  const row = await one(env, 'SELECT code FROM qrcodes WHERE uid = ?', me.uid);
  if (row) return json({ code: row.code });
  const code = b64u(rand(9));
  await run(env, 'INSERT OR IGNORE INTO qrcodes (code, uid, created) VALUES (?, ?, ?)', code, me.uid, now());
  return json({ code: (await one(env, 'SELECT code FROM qrcodes WHERE uid = ?', me.uid)).code });
}
async function qrNew(req, env, me) {
  await rateLimit(env, 'qrnew:' + me.uid, 10, 864e5);
  const code = b64u(rand(9));
  await run(env, 'INSERT INTO qrcodes (code, uid, created) VALUES (?, ?, ?) ON CONFLICT(uid) DO UPDATE SET code = excluded.code, created = excluded.created', code, me.uid, now());
  return json({ code });
}
function hiPage(lang, ownerName, opts) {
  const T = k => htmlEsc(hiT(lang, k, ownerName));
  const dir = 'ltr';
  return new Response('<!doctype html><html lang="' + htmlEsc(lang) + '" dir="' + dir + '"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex"><title>' + T('title') + '</title>' +
    '<style>:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#FAF3DF;color:#241F18;font:17px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;padding:max(28px,env(safe-area-inset-top)) 18px 28px}main{max-width:420px;margin:0 auto;display:grid;gap:16px}' +
    '.mark{width:76px;height:76px;justify-self:center;border-radius:20px;background:#FAF3DF;box-shadow:0 10px 22px -16px rgba(70,52,22,.55),0 0 0 1.5px #D8C8A2}h1{font:600 30px/1.15 Georgia,serif;margin:0;text-align:center}p{margin:0}.lead{color:#574D3E;text-align:center}' +
    'label{display:grid;gap:6px;font-weight:600;font-size:15.5px}input{font:inherit;width:100%;min-height:52px;padding:10px 14px;border-radius:14px;border:1.5px solid #D8C8A2;background:#FFFEFA;color:#241F18}input:focus{outline:none;border-color:#4E5A33;box-shadow:0 0 0 3px #E3E2C7}' +
    'button{font:inherit;font-weight:700;min-height:54px;border-radius:14px;border:0;background:#4E5A33;color:#FFFBF3;width:100%;box-shadow:0 6px 14px -8px rgba(78,90,51,.8)}.small{font-size:14px;color:#574D3E;text-align:center}.err{color:#A9423A;font-weight:600;text-align:center}' +
    '.tick{display:flex;gap:12px;align-items:flex-start;font-weight:500}.tick input{width:26px;min-height:26px;height:26px;flex:0 0 26px;margin:2px 0 0;accent-color:#4E5A33}a{color:#4E5A33;font-weight:600}</style>' +
    '<main><svg class="mark" viewBox="0 0 104 104" aria-hidden="true"><path d="M45 79 V37 a12 12 0 0 1 12 -12 a12 12 0 0 1 12 12 v6" fill="none" stroke="#4E5A33" stroke-width="7" stroke-linecap="round"/></svg>' +
    '<h1>' + T('title') + '</h1>' + (opts.notReady ? '<p class="lead">' + T('notReady') + '</p>' :
      '<p class="lead">' + T('lead') + '</p>' + (opts.err ? '<p class="err" role="alert">' + T(opts.err) + '</p>' : '') +
      '<form method="post"><div style="display:grid;gap:14px"><label>' + T('yourName') + '<input name="name" autocomplete="name" required maxlength="60" value="' + htmlEsc(opts.name || '') + '"></label>' +
      '<label>' + T('yourNum') + '<input name="phone" type="tel" autocomplete="tel" maxlength="30" value="' + htmlEsc(opts.phone || '') + '"></label>' +
      '<label class="tick"><input name="agree" type="checkbox" value="1" required' + (opts.agree ? ' checked' : '') + '><span>' + T('agree') + '</span></label>' +
      '<button type="submit">' + T('go') + '</button></div></form><p class="small">' + T('privacy') + ' <a href="' + htmlEsc(opts.privacyUrl || '') + '">' + T('privLink') + '</a></p>') + '</main></html>',
    { status: opts.status || 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' } });
}
function ymdIn(tz) { try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); } catch (e) { return new Date().toISOString().slice(0, 10); } }
async function hello(req, env, parts) {
  const code = parts[1] || '';
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(code)) return new Response('Not found', { status: 404 });
  const q = await one(env, 'SELECT uid FROM qrcodes WHERE code = ?', code);
  if (!q) return new Response('Not found', { status: 404 });
  const prow = await one(env, "SELECT data FROM docs WHERE uid = ? AND path = 'profile' AND del = 0", q.uid);
  const prof = prow ? JSON.parse(prow.data) : {};
  const u = await one(env, 'SELECT name FROM users WHERE id = ?', q.uid);
  const owner = firstName(prof.name || (u && u.name) || '') || 'them';
  const lang = HI[prof.lang] ? prof.lang : 'en';
  const num = waNum(prof.phone, prof.country);
  const privacyUrl = String(env.APP_URL || DEFAULT_APP_URL).replace(/\/?$/, '/') + 'privacy.html';
  if (!num) return hiPage(lang, owner, { notReady: true });
  if (req.method !== 'POST') return hiPage(lang, owner, { privacyUrl });
  let name = '', phone = '', agree = '';
  const ct = req.headers.get('Content-Type') || '';
  if (ct.includes('json')) { const b = await body(req); name = b.name; phone = b.phone; agree = b.agree; }
  else { const f = await req.formData(); name = f.get('name'); phone = f.get('phone'); agree = f.get('agree'); }
  name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60); phone = String(phone || '').trim().slice(0, 30);
  const agreed = agree === true || agree === '1' || agree === 'on' || agree === 1;
  if (!name) return hiPage(lang, owner, { err: 'needName', phone, agree: agreed, privacyUrl, status: 400 });
  if (!agreed) return hiPage(lang, owner, { err: 'needAgree', name, phone, privacyUrl, status: 400 });
  try { await rateLimit(env, 'hi:' + code + ':' + ipOf(req), 5, 3600e3); await rateLimit(env, 'hiday:' + code, 20, 864e5); }
  catch (e) { return hiPage(lang, owner, { err: 'slow', name, phone, agree: agreed, privacyUrl, status: 429 }); }
  const t = now(), id = (t.toString(36) + b64u(rand(5))).replace(/[^A-Za-z0-9_-]/g, '');
  const c = { id, name, phone, instagram: '', social2: '', social2Platform: '', notes: '', consent: true, consentAt: t, source: 'qr', createdAt: t, updatedAt: t, status: 'active', stage: 'First contact', everyDays: Number(prof.defaultEvery) || 3, metOn: ymdIn(prof.tz), replyState: 'me', meSince: t, studies: [], log: [{ t, k: 'change', text: 'Added from your QR code' }] };
  const seq = await nextSeqs(env, 1);
  await run(env, 'INSERT INTO docs (uid, path, data, del, t, seq) VALUES (?, ?, ?, 0, ?, ?)', q.uid, 'profile/contacts/' + id, JSON.stringify(c), t, seq);
  // tell the owner straight away
  const subs = await all(env, 'SELECT * FROM subs WHERE uid = ?', q.uid);
  if (subs.length) {
    const v = await vapid(env), cache = {};
    for (const s2 of subs) { const st = await sendPush(env, v, s2, { title: hiT(lang, 'pushT', firstName(name)), body: hiT(lang, 'pushB', ''), tag: 'qr-' + id, url: './?open=' + id }, cache).catch(() => 0); await afterSend(env, s2, st); }
  }
  const intro = !prof.intro || prof.intro === OLD_INTRO || prof.intro === DEFAULT_INTRO ? (HI_INTRO[lang] || DEFAULT_INTRO) : prof.intro;
  const wa = 'https://wa.me/' + num + '?text=' + encodeURIComponent(intro);
  return new Response(null, { status: 303, headers: { Location: wa, 'Cache-Control': 'no-store' } });
}

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
  await rateLimit(env, 'admin:' + ipOf(req), 20, 3600e3); // per network address, so a stranger can't block you
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
    return json({ app: 'Shepherd', version: VERSION, db }); // nothing about how the server is set up
  }
  if (parts[0] === 'cal') { await ready(env); return calendar(req, env, parts); }
  if (parts[0] === 'admin') { await ready(env); return admin(req, env); }
  if (parts[0] === 'hi') { await ready(env); return hello(req, env, parts); }
  if (parts[0] !== 'api') return json({ error: 'not_found' }, 404);
  await ready(env);
  const p = parts.slice(1).join('/');
  if (m === 'POST' && p === 'signup') return signup(req, env);
  if (m === 'POST' && p === 'login') return login(req, env);
  if (m === 'POST' && p === 'reset/request') return resetRequest(req, env);
  if (m === 'POST' && p === 'reset/confirm') return resetConfirm(req, env);
  if (m === 'GET' && p === 'push/key') return json({ key: (await vapid(env)).pub });
  if (m === 'GET' && p === 'signup/options') return json({ invite: !!env.INVITE_CODE }); // whether sign-up asks for the church invite code
  const me = await auth(req, env);
  if (m === 'GET' && p === 'me') return json({ user: pub(me), devices: (await one(env, 'SELECT COUNT(*) AS n FROM subs WHERE uid = ?', me.uid)).n });
  if (m === 'POST' && p === 'logout') { await run(env, 'DELETE FROM sessions WHERE th = ?', me.th); return json({ ok: true }); }
  if (m === 'POST' && p === 'logout/others') { const n = await one(env, 'SELECT COUNT(*) AS n FROM sessions WHERE uid = ? AND th != ?', me.uid, me.th); await run(env, 'DELETE FROM sessions WHERE uid = ? AND th != ?', me.uid, me.th); return json({ ok: true, signedOut: n ? n.n : 0 }); }
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
  if (m === 'POST' && p === 'qr') return qrCode(req, env, me);
  if (m === 'POST' && p === 'qr/new') return qrNew(req, env, me);
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
    ctx.waitUntil((async () => { await sendDue(env, 40); if (new Date().getUTCHours() === 3 && new Date().getUTCMinutes() < 5) await tidy(env); })().catch(e => console.error(e && e.stack || e)));
  }
};
