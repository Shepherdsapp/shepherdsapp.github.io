/* Shepherd on the web: sign-in, saving to your own Shepherd server, phone notifications and installing.
   The app itself (app.js) asks for storage the same way it does inside Claude; this file answers. */
(function () {
'use strict';
var CFG = window.SHEPHERD_CONFIG || {};
var API = String(CFG.api || '').trim().replace(/\/+$/, '');
if (/YOUR-NAME|example/i.test(API) || !/^https?:\/\//.test(API)) API = ''; // config.js not filled in yet
var TK = 'shepherd:token', UK = 'shepherd:user', LAST = 'shepherd:last-uid';
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
var te = new TextEncoder();
function hex(b) { return Array.from(new Uint8Array(b)).map(function (x) { return x.toString(16).padStart(2, '0'); }).join(''); }
function unb64u(s) { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; var bin = atob(s), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

var token = lsGet(TK) || '';
var user = null; try { user = JSON.parse(lsGet(UK) || 'null'); } catch (e) {}

/* ---------- talking to the server ---------- */
var onSignedOut = null;
async function api(method, path, body) {
  if (!API) { var n = new Error('Shepherd has no server address yet.'); n.code = 'no_server'; throw n; }
  var r, data = null;
  try {
    r = await fetch(API + path, { method: method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  } catch (e) { var off = new Error('No connection. Your changes are kept on this phone.'); off.code = 'unavailable'; throw off; }
  try { data = await r.json(); } catch (e) {}
  if (!r.ok) {
    var er = new Error((data && data.message) || 'Something went wrong. Try again.');
    er.status = r.status; er.code = (data && data.error) || (r.status >= 500 ? 'unavailable' : 'error');
    if (r.status === 401 && token && path.indexOf('/api/login') < 0 && path.indexOf('/api/password') < 0 && path.indexOf('/api/account') < 0) { token = ''; lsDel(TK); if (onSignedOut) onSignedOut(); }
    throw er;
  }
  return data;
}
async function pwKey(email, pw) {
  var base = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveBits']);
  var bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: te.encode('shepherd-v1:' + String(email).trim().toLowerCase()), iterations: 210000 }, base, 256);
  return hex(bits);
}

/* ---------- storage the app uses (same shape as inside Claude) ---------- */
var mirror = { docs: {}, seq: 0 }, loaded = false, listeners = [], pulling = null, pullAgain = false, pollTimer = null;
function mkey() { return 'shepherd:mirror:' + (user && user.id); }
function loadMirror() { try { var o = JSON.parse(lsGet(mkey()) || 'null'); if (o && o.docs) mirror = o; } catch (e) {} }
function saveMirror() { lsSet(mkey(), JSON.stringify(mirror)); }
function rel(path) { return String(path).replace(/^data\/users\/[^/]+\//, ''); }
function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
function snapFor(l) {
  if (l.kind === 'doc') { var d = mirror.docs[l.rel]; return { exists: d != null, id: l.rel.split('/').pop(), data: function () { return clone(d); } }; }
  var pre = l.rel + '/', docs = [];
  Object.keys(mirror.docs).forEach(function (k) { if (k.indexOf(pre) === 0 && k.slice(pre.length).indexOf('/') < 0 && mirror.docs[k] != null) { var v = mirror.docs[k]; docs.push({ id: k.slice(pre.length), data: function () { return clone(v); } }); } });
  return { docs: docs, empty: !docs.length, size: docs.length, metadata: { fromCache: !loaded } };
}
function emit() { listeners.slice().forEach(function (l) { try { l.cb(snapFor(l)); } catch (e) { console.error(e); } }); }
async function pull() {
  if (!token) return;
  if (pulling) { pullAgain = true; return pulling; }
  pulling = (async function () {
    var changed = false;
    try {
      for (var i = 0; i < 40; i++) {
        var r = await api('GET', '/api/docs?since=' + mirror.seq);
        (r.docs || []).forEach(function (d) { var cur = mirror.docs[d.p]; if (d.d === null) { if (cur !== undefined) { delete mirror.docs[d.p]; changed = true; } } else if (JSON.stringify(cur) !== JSON.stringify(d.d)) { mirror.docs[d.p] = d.d; changed = true; } });
        mirror.seq = r.seq || mirror.seq;
        if (!r.more) break;
      }
      saveMirror();
      if (changed || !loaded) { loaded = true; emit(); }
      W.lastSync = Date.now();
    } catch (e) {
      if (e.code !== 'unavailable' && e.code !== 'signed_out') listeners.forEach(function (l) { if (l.err) try { l.err(e); } catch (x) {} });
    } finally { pulling = null; if (pullAgain) { pullAgain = false; setTimeout(pull, 50); } }
  })();
  return pulling;
}
var soonT = null;
function pullSoon(ms) { clearTimeout(soonT); soonT = setTimeout(pull, ms || 1200); }
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(function () { if (!document.hidden && navigator.onLine !== false) pull(); }, 20000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) pull(); });
  window.addEventListener('online', function () { pull(); });
  window.addEventListener('focus', function () { pull(); });
}
function docRef(path) {
  var r = rel(path);
  return {
    set: async function (d) {
      var res = await api('POST', '/api/docs', { ops: [{ p: r, d: d, t: (d && Number(d.updatedAt)) || Date.now() }] });
      mirror.docs[r] = clone(d);
      (res.kept || []).forEach(function (k) { if (k.d === null) delete mirror.docs[k.p]; else mirror.docs[k.p] = k.d; });
      saveMirror(); if (res.kept && res.kept.length) emit(); pullSoon();
    },
    delete: async function () { await api('POST', '/api/docs', { ops: [{ p: r, d: null, t: Date.now() }] }); delete mirror.docs[r]; saveMirror(); pullSoon(); },
    onSnapshot: function (cb, err) { var l = { kind: 'doc', rel: r, cb: cb, err: err }; listeners.push(l); if (Object.keys(mirror.docs).length) cb(snapFor(l)); return function () { listeners = listeners.filter(function (x) { return x !== l; }); }; },
    collection: function (name) {
      var cr = r + '/' + name;
      return { onSnapshot: function (cb, err) { var l = { kind: 'col', rel: cr, cb: cb, err: err }; listeners.push(l); if (Object.keys(mirror.docs).length) cb(snapFor(l)); return function () { listeners = listeners.filter(function (x) { return x !== l; }); }; } };
    }
  };
}
var DBSHIM = { doc: docRef };
var USERSHIM = { id: async function () { return user.id; }, isOwner: async function () { return false; }, email: async function () { return user.email; } };
var DOWNSHIM = {
  save: async function (o) {
    var file = new File([o.data], o.filename, { type: 'application/json' });
    if (navigator.canShare && navigator.share && navigator.canShare({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
      try { await navigator.share({ files: [file], title: o.filename }); return { status: 'saved' }; } catch (e) { if (e && e.name === 'AbortError') { var d = new Error('declined'); d.code = 'declined'; throw d; } }
    }
    var a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = o.filename; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    return { status: 'saved' };
  }
};

/* ---------- sign in ---------- */
var readyResolve, readyPromise = new Promise(function (res) { readyResolve = res; });
function finishSignIn(t, u) {
  var last = lsGet(LAST);
  token = t; user = u; lsSet(TK, t); lsSet(UK, JSON.stringify(u));
  if (last && last !== u.id) { // someone else used Shepherd on this phone: start clean, never mix two people's lists
    lsDel('shepherd:v1:' + last); lsDel('shepherd:mirror:' + last); lsDel(LAST);
    location.reload(); return;
  }
  hideAuth(); go();
  if (W.onSignedIn) setTimeout(W.onSignedIn, 300); // anything changed while signed out is saved now
}
function go() { loadMirror(); startPolling(); readyResolve(); pull(); }

var authEl = null;
function authHtml(mode, msg) {
  var create = mode === 'create', forgot = mode === 'forgot', code = mode === 'code';
  return '<form class="auth-in" id="authForm" novalidate>' +
    '<svg class="mark" viewBox="0 0 104 104" aria-hidden="true"><rect width="104" height="104" rx="24"/><path d="M45 79 V37 a12 12 0 0 1 12 -12 a12 12 0 0 1 12 12 v6"/></svg>' +
    '<h1 class="h1" style="text-align:center">Shepherd</h1>' +
    (forgot || code ? '<p class="lede" style="text-align:center">' + (code ? esc(msg || 'Enter your 6-digit code and choose a new password.') : 'Enter your email and we\'ll help you choose a new password.') + '</p>'
      : '<div class="seg" style="grid-template-columns:1fr 1fr" role="group"><button type="button" data-auth="signin" aria-pressed="' + !create + '">Sign in</button><button type="button" data-auth="create" aria-pressed="' + create + '">Create account</button></div>' +
        '<p class="note" style="text-align:center">' + (create ? 'Your list is private: nobody else using Shepherd can see it.' : 'You only need to sign in once on this phone.') + '</p>') +
    (create ? '<label class="field" for="aName">Your name<input class="inp" id="aName" autocomplete="name"></label>' : '') +
    '<label class="field" for="aEmail">Email<input class="inp" id="aEmail" type="email" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" value="' + esc(lsGet('shepherd:email') || '') + '"' + (code ? ' readonly' : '') + '></label>' +
    (code ? '<label class="field" for="aCode">6-digit code<input class="inp" id="aCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></label>' : '') +
    (forgot ? '' : '<label class="field" for="aPw">' + (code ? 'New password' : 'Password') + '<span class="pwrow"><input class="inp" id="aPw" type="password" autocomplete="' + (create || code ? 'new-password' : 'current-password') + '" minlength="8"><button type="button" class="btn ghost small" id="aShow">Show</button></span></label>') +
    '<p class="small" id="aErr" role="alert" style="margin:0;color:var(--bad)" hidden></p>' +
    '<button class="btn primary block" type="submit" id="aGo">' + (create ? 'Create my account' : forgot ? 'Get a reset code' : code ? 'Save new password' : 'Sign in') + '</button>' +
    (create || forgot || code ? '' : '<button type="button" class="linkrow" data-auth="forgot" style="justify-self:center">Forgot password?</button>') +
    (forgot || code ? '<button type="button" class="linkrow" data-auth="signin" style="justify-self:center">Back to sign in</button>' : '') +
    (!API ? '<p class="banner"><span>Shepherd isn\'t connected to its server yet. Put your Cloudflare Worker address in <b>config.js</b>.</span></p>' : '') +
    '</form>';
}
function showAuth(mode, msg) {
  if (!authEl) { authEl = document.createElement('div'); authEl.className = 'auth'; authEl.id = 'auth'; document.body.appendChild(authEl); }
  authEl.hidden = false; document.body.classList.add('noscroll');
  authEl.innerHTML = authHtml(mode || 'signin', msg); authEl.dataset.mode = mode || 'signin';
  bindAuth();
  setTimeout(function () { var f = authEl.querySelector(mode === 'code' ? '#aCode' : '#aEmail'); if (f && !f.value) try { f.focus(); } catch (e) {} }, 60);
}
function hideAuth() { if (authEl) { authEl.hidden = true; authEl.innerHTML = ''; } document.body.classList.remove('noscroll'); }
function bindAuth() {
  var f = authEl.querySelector('#authForm'), err = authEl.querySelector('#aErr'), btn = authEl.querySelector('#aGo');
  var mode = authEl.dataset.mode;
  authEl.querySelectorAll('[data-auth]').forEach(function (b) { b.addEventListener('click', function () { var em = authEl.querySelector('#aEmail'); if (em) lsSet('shepherd:email', em.value.trim()); showAuth(b.dataset.auth); }); });
  var show = authEl.querySelector('#aShow');
  if (show) show.addEventListener('click', function () { var p = authEl.querySelector('#aPw'); p.type = p.type === 'password' ? 'text' : 'password'; show.textContent = p.type === 'password' ? 'Show' : 'Hide'; });
  var say = function (m) { err.hidden = !m; err.textContent = m || ''; };
  f.addEventListener('submit', async function (e) {
    e.preventDefault(); say('');
    var email = authEl.querySelector('#aEmail').value.trim().toLowerCase();
    var pwEl = authEl.querySelector('#aPw'), pw = pwEl ? pwEl.value : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return say('Enter your email address.');
    if (pwEl && pw.length < 8) return say(mode === 'signin' ? 'Enter your password.' : 'Choose a password of at least 8 characters.');
    lsSet('shepherd:email', email);
    btn.disabled = true; var label = btn.textContent; btn.textContent = 'One moment…';
    try {
      if (mode === 'forgot') {
        var rq = await api('POST', '/api/reset/request', { email: email });
        showAuth('code', rq.emailed ? 'If ' + email + ' has an account, we\'ve emailed a 6-digit code. Enter it and choose a new password.' : 'Ask the person who runs Shepherd at your church for a reset code, then enter it and choose a new password.');
        return;
      }
      var key = await pwKey(email, pw), r;
      if (mode === 'create') r = await api('POST', '/api/signup', { email: email, key: key, name: (authEl.querySelector('#aName').value || '').trim() });
      else if (mode === 'code') r = await api('POST', '/api/reset/confirm', { email: email, code: authEl.querySelector('#aCode').value, key: key });
      else r = await api('POST', '/api/login', { email: email, key: key });
      finishSignIn(r.token, r.user);
      if (mode === 'create' && r.user.name) W.newName = r.user.name;
    } catch (x) {
      say(x.code === 'unavailable' ? 'No connection. Check your signal and try again.' : x.message);
    } finally { btn.disabled = false; btn.textContent = label; }
  });
}

/* ---------- notifications ---------- */
function standalone() { return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true; }
function isIOS() { return /iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Mac/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1); }
var push = {
  state: async function () {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return isIOS() && !standalone() ? 'install' : 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    try { var reg = await navigator.serviceWorker.getRegistration(); var s = reg && await reg.pushManager.getSubscription(); return s && Notification.permission === 'granted' ? 'on' : 'off'; } catch (e) { return 'off'; }
  },
  enable: async function () {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return { ok: false, why: isIOS() && !standalone() ? 'install' : 'unsupported' };
    var perm = await Notification.requestPermission(); // first, while the tap still counts
    if (perm !== 'granted') return { ok: false, why: perm === 'denied' ? 'denied' : 'dismissed' };
    try {
      var reg = await navigator.serviceWorker.ready;
      var sub = await reg.pushManager.getSubscription();
      if (!sub) { var k = await api('GET', '/api/push/key'); sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(k.key) }); }
      await api('POST', '/api/push/sub', { sub: sub.toJSON() });
      lastSchedule = ''; lsDel('shepherd:sched:' + user.id);
      return { ok: true };
    } catch (e) { return { ok: false, why: 'error', message: e.message }; }
  },
  disable: async function () {
    try { var reg = await navigator.serviceWorker.getRegistration(); var s = reg && await reg.pushManager.getSubscription(); if (s) { await api('POST', '/api/push/unsub', { endpoint: s.endpoint }).catch(function () {}); await s.unsubscribe(); } } catch (e) {}
    return { ok: true };
  },
  test: function () { return api('POST', '/api/push/test', {}); }
};
var lastSchedule = '';
async function schedule(items) {
  if (!token || !user) return;
  var key = 'shepherd:sched:' + user.id, body = JSON.stringify(items);
  if (body === lastSchedule || body === lsGet(key)) { lastSchedule = body; return; }
  try { await api('POST', '/api/schedule', { items: items }); lastSchedule = body; lsSet(key, body); } catch (e) { /* tried again on the next change */ }
}

/* ---------- installing ---------- */
var deferredInstall = null;
window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredInstall = e; if (W.onInstallable) W.onInstallable(); });
window.addEventListener('appinstalled', function () { deferredInstall = null; if (W.onInstallable) W.onInstallable(); });
var install = {
  standalone: standalone, isIOS: isIOS,
  canPrompt: function () { return !!deferredInstall; },
  prompt: async function () { if (!deferredInstall) return false; deferredInstall.prompt(); var c = await deferredInstall.userChoice.catch(function () { return {}; }); deferredInstall = null; return c && c.outcome === 'accepted'; }
};
if ('serviceWorker' in navigator && location.protocol !== 'file:') window.addEventListener('load', function () { navigator.serviceWorker.register('./sw.js').catch(function () {}); });
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', function (e) { if (e.data && e.data.open && W.onOpen) W.onOpen(e.data.open); });

/* ---------- the account ---------- */
async function signOut() {
  try { await push.disable(); } catch (e) {}
  try { await api('POST', '/api/logout', {}); } catch (e) {}
  var id = user && user.id;
  [TK, UK, LAST, 'shepherd:v1:' + id, 'shepherd:mirror:' + id, 'shepherd:sched:' + id, 'shepherd:tourDone:' + id].forEach(lsDel);
  location.reload();
}
var W = window.SHEPHERD_WEB = {
  api: api, pwKey: pwKey, push: push, schedule: schedule, install: install, signOut: signOut, pull: pull,
  user: function () { return user; },
  apiBase: API,
  feedUrl: function () { return user && user.cal && API ? API.replace(/^https?:/, 'webcal:') + '/cal/' + user.cal + '.ics' : ''; },
  feedHttps: function () { return user && user.cal && API ? API + '/cal/' + user.cal + '.ics' : ''; },
  itemUrl: function (kind, id) { return user && user.cal && API ? API + '/cal/' + user.cal + '/' + kind + '/' + id + '.ics' : ''; },
  refreshMe: async function () { try { var r = await api('GET', '/api/me'); user = r.user; lsSet(UK, JSON.stringify(user)); W.devices = r.devices; return r; } catch (e) { return null; } },
  newCalLink: async function () { var r = await api('POST', '/api/cal/new', {}); user.cal = r.cal; lsSet(UK, JSON.stringify(user)); return r.cal; },
  changePassword: async function (oldPw, newPw) { return api('POST', '/api/password', { key: await pwKey(user.email, oldPw), newKey: await pwKey(user.email, newPw) }); },
  deleteAccount: async function (pw) { await api('POST', '/api/account/delete', { key: await pwKey(user.email, pw) }); var id = user.id; [TK, UK, LAST, 'shepherd:v1:' + id, 'shepherd:mirror:' + id, 'shepherd:sched:' + id].forEach(lsDel); location.reload(); }
};

/* the app asks for these exactly as it does inside Claude */
window.claude = {
  use: function (name) {
    if (name === 'db') return readyPromise.then(function () { return DBSHIM; });
    if (name === 'user') return readyPromise.then(function () { return USERSHIM; });
    if (name === 'downloads') return Promise.resolve(DOWNSHIM);
    return Promise.reject(new Error('not available'));
  }
};
onSignedOut = function () { showAuth('signin'); readyPromise = new Promise(function (res) { readyResolve = res; }); };

function start() {
  if (token && user && user.id) { lsSet(LAST, user.id); go(); W.refreshMe(); }
  else showAuth(lsGet('shepherd:email') ? 'signin' : 'create');
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
