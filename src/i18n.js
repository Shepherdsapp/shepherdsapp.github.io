/* Shepherd languages. The app is written in English; this swaps each piece of text on screen for the chosen language
   as it appears. Bible verses (marked data-noi18n) always stay in English (NIV). Names and notes people type are left
   alone because they are not in the dictionary. */
(function () {
  var LANGS = [
    ['en', 'English', 'en-GB'], ['es', 'Español', 'es'], ['fr', 'Français', 'fr'], ['pt', 'Português', 'pt'],
    ['nl', 'Nederlands', 'nl'], ['pl', 'Polski', 'pl'], ['pcm', 'Naijá', 'en-NG'], ['yo', 'Yorùbá', 'yo'],
    ['ig', 'Igbo', 'ig'], ['zh-Hans', '中文（简体）', 'zh-CN'], ['zh-Hant', '中文（繁體・香港／台灣）', 'zh-TW'],
    ['ja', '日本語', 'ja'], ['de', 'Deutsch', 'de'], ['ru', 'Русский', 'ru'], ['lt', 'Lietuvių', 'lt']
  ];
  var CODES = LANGS.map(function (l) { return l[0]; });
  var PACK_VER = 1;
  var lang = 'en', dict = null, tpls = [], cache = new Map(), outs = new WeakMap(), plural = null;
  var collect = typeof window !== 'undefined' && window.__i18nCollect ? window.__i18nCollect : null;
  var INLINE = { B: 1, STRONG: 1, I: 1, EM: 1, BR: 1, U: 1, SMALL: 1, CODE: 1 };
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, svg: 1, SVG: 1, NOSCRIPT: 1, TEMPLATE: 1 };
  var ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];

  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } }
  function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }
  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function detect() {
    var want = (typeof navigator !== 'undefined' && (navigator.languages || [navigator.language])) || [];
    for (var i = 0; i < want.length; i++) {
      var w = String(want[i] || '').toLowerCase();
      if (/^zh-(tw|hk|mo|hant)/.test(w)) return 'zh-Hant';
      if (/^zh/.test(w)) return 'zh-Hans';
      if (/^pcm/.test(w)) return 'pcm';
      var b = w.split('-')[0];
      if (b === 'en') return 'en';
      if (CODES.indexOf(b) > -1) return b;
    }
    return 'en';
  }
  function setDict(code, d) {
    lang = code; dict = d || null; cache = new Map(); tpls = [];
    var loc = locale();
    try { plural = new Intl.PluralRules(loc); } catch (e) { plural = null; }
    if (!dict) return;
    Object.keys(dict).forEach(function (k) {
      if (k.indexOf('{0}') < 0) return;
      var lit = k.replace(/\{\d\}/g, '');
      var re = new RegExp('^' + esc(k).replace(/\\\{(\d)\\\}/g, '(.+?)') + '$');
      tpls.push({ re: re, out: dict[k], w: lit.length, joiner: !/[A-Za-z]/.test(lit.replace(/<[^>]+>/g, '')), order: (k.match(/\{\d\}/g) || []).map(function (x) { return +x[1]; }) });
    });
    tpls.sort(function (a, b) { return b.w - a.w; });
  }
  function pick(v, n) {
    if (v && typeof v === 'object') { var cat = 'other'; try { if (plural && n !== null && !isNaN(n)) cat = plural.select(n); } catch (e) {} return v[cat] || v.other || v.one || ''; }
    return v;
  }
  function lookup(s) {
    var k = norm(s);
    if (!k || !/[A-Za-z]/.test(k)) return null;
    if (collect && !dict) { collect(k); return null; }
    if (!dict) return null;
    if (Object.prototype.hasOwnProperty.call(dict, k)) { var v = dict[k]; return typeof v === 'object' ? pick(v, null) : v; }
    if (cache.has(k)) return cache.get(k);
    var out = null;
    for (var i = 0; i < tpls.length; i++) {
      var m = tpls[i].re.exec(k); if (!m) continue;
      var t = tpls[i], firstNum = null, bad = false;
      for (var j = 1; j < m.length; j++) if (firstNum === null && /^-?\d+$/.test(m[j])) firstNum = +m[j];
      var res = String(pick(t.out, firstNum)).replace(/\{(\d)\}/g, function (_, n) {
        var cap = m[t.order.indexOf(+n) + 1]; if (cap === undefined) return '';
        var tr2 = lookup(cap);
        // a joiner like "{0}, {1}" only glues short pieces; it never half-translates a whole English sentence
        if (tr2 === null && t.joiner && cap.split(/\s+/).length > 3) bad = true;
        return tr2 === null ? cap : tr2;
      });
      if (bad) continue;
      out = res; break;
    }
    if (out === k) out = null; // a joiner matched but nothing in it had a translation
    if (out === null && collect) collect(k);
    if (cache.size > 4000) cache.clear();
    cache.set(k, out);
    return out;
  }
  function tr(s) {
    if (s == null) return s;
    if (typeof s === 'string' && s.indexOf('\n') > -1 && dict) return s.split('\n').map(tr).join('\n');
    var r = lookup(s); if (r === null) return s;
    var lead = /^\s*/.exec(s)[0], tail = /\s*$/.exec(s)[0];
    return lead + r + tail;
  }
  function inlineBlock(el) {
    var kids = el.childNodes, hasEl = false, hasText = false;
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType === 3) { if (/\S/.test(n.nodeValue)) hasText = true; continue; }
      if (n.nodeType !== 1) continue;
      if (!INLINE[n.tagName] || n.attributes.length) return false;
      for (var j = 0; j < n.childNodes.length; j++) if (n.childNodes[j].nodeType !== 3) return false;
      hasEl = true;
    }
    return hasEl && hasText;
  }
  function doText(n) {
    var v = n.nodeValue; if (!v || !/[A-Za-z]/.test(v)) return;
    if (outs.get(n) === v) return;
    var t = /\n\s*\S/.test(v.trim()) ? v.split('\n').map(tr).join('\n') : tr(v); if (t !== v) { outs.set(n, t); n.nodeValue = t; }
  }
  function doAttrs(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i]; if (!el.hasAttribute || !el.hasAttribute(a)) continue;
      var v = el.getAttribute(a), mark = 'i18n:' + a;
      if (el[mark] === v) continue;
      var t = tr(v); if (t !== v) { el[mark] = t; el.setAttribute(a, t); }
    }
    if (el.tagName === 'INPUT' && (el.type === 'button' || el.type === 'submit') && el.value) { var tv = tr(el.value); if (tv !== el.value) el.value = tv; }
  }
  function walk(root) {
    if (!dict && !collect) return;
    if (!root) return;
    if (root.nodeType === 3) { var p = root.parentNode; if (p && !skipped(p)) { if (inlineBlock(p)) doBlock(p); else doText(root); } return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1 && root.tagName === 'TEXTAREA' && !skipped(root.parentNode || root)) { doAttrs(root); return; }
    if (root.nodeType === 1 && skipped(root)) return;
    if (root.nodeType === 1) {
      doAttrs(root);
      if (inlineBlock(root) && doBlock(root)) return;
    }
    var kids = root.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType === 3) doText(n);
      else if (n.nodeType === 1) {
        if (!SKIP[n.tagName] && !(n.hasAttribute && n.hasAttribute('data-noi18n'))) walk(n);
        else if (n.tagName === 'TEXTAREA' && !n.hasAttribute('data-noi18n')) doAttrs(n); // what's typed stays as typed, but the hint inside is translated
      }
    }
  }
  function doBlock(el) {
    var html = el.innerHTML; if (outs.get(el) === html) return true;
    var t = lookup(html);
    if (t === null) {
      if (collect && !dict) return true; // collected as one sentence
      return false;
    }
    outs.set(el, t); el.innerHTML = t; outs.set(el, el.innerHTML);
    return true;
  }
  function skipped(el) {
    for (var e = el; e && e.nodeType === 1; e = e.parentNode) { if (SKIP[e.tagName] || e.hasAttribute('data-noi18n')) return true; }
    return false;
  }
  var mo = null;
  function observe() {
    if (mo || typeof MutationObserver === 'undefined' || (!dict && !collect)) return;
    mo = new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (m.type === 'childList') { for (var j = 0; j < m.addedNodes.length; j++) walk(m.addedNodes[j]); if (m.target.nodeType === 1 && inlineBlock(m.target) && !skipped(m.target)) doBlock(m.target); }
        else if (m.type === 'characterData') walk(m.target);
        else if (m.type === 'attributes') { if (m.target.nodeType === 1 && (!skipped(m.target) || (m.target.tagName === 'TEXTAREA' && !m.target.hasAttribute('data-noi18n')))) doAttrs(m.target); }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    walk(document.documentElement);
  }
  function locale() { for (var i = 0; i < LANGS.length; i++) if (LANGS[i][0] === lang) return LANGS[i][2]; return 'en-GB'; }
  function packUrl(code) { return 'lang/' + code + '.json?v=' + PACK_VER; } // a new address for each version, so no old copy is used
  function loadPack(code) {
    var embedded = typeof window !== 'undefined' && window.SHEPHERD_LANGS && window.SHEPHERD_LANGS[code];
    if (embedded) return Promise.resolve(embedded);
    var cached = ls('shepherd:langpack:' + code);
    if (cached) { try { var o = JSON.parse(cached); if (o && o.v === PACK_VER && o.d) return Promise.resolve(o.d); } catch (e) {} }
    if (typeof fetch === 'undefined') return Promise.resolve(null);
    return fetch(packUrl(code), { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (d) ls('shepherd:langpack:' + code, JSON.stringify({ v: PACK_VER, d: d }));
      return d;
    }).catch(function () { return null; });
  }
  function cachedPackSync(code) {
    var embedded = typeof window !== 'undefined' && window.SHEPHERD_LANGS && window.SHEPHERD_LANGS[code];
    if (embedded) return embedded;
    var cached = ls('shepherd:langpack:' + code);
    if (cached) { try { var o = JSON.parse(cached); if (o && o.v === PACK_VER) return o.d; } catch (e) {} }
    return null;
  }
  var ready = Promise.resolve();
  function start(code) {
    code = CODES.indexOf(code) > -1 ? code : 'en';
    if (code === 'en') { setDict('en', null); applyDoc(); observe(); return Promise.resolve(); }
    var d = cachedPackSync(code);
    if (d) { setDict(code, d); applyDoc(); observe(); ready = Promise.resolve(); loadPack(code); return ready; }
    setDict(code, null); applyDoc();
    ready = loadPack(code).then(function (p) { if (p && lang === code) { setDict(code, p); observe(); walk(document.documentElement); } });
    return ready;
  }
  function applyDoc() {
    try { document.documentElement.lang = locale(); } catch (e) {}
  }
  var saved = ls('shepherd:lang');
  var I18N = {
    LANGS: LANGS, codes: CODES,
    get lang() { return lang; },
    locale: locale, tr: tr, detect: detect, ready: function () { return ready; },
    has: function (s) { return lookup(s) !== null; },
    // translate this part of the page now (before measuring it)
    apply: function (el) { if (dict && el) walk(el); },
    // fill a sentence: fmt('Hi {0}!', ['Ama']) in the chosen language (for text that leaves the screen, like an invite)
    fmt: function (key, args) {
      args = args || []; var v = dict && Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
      var n = null; for (var i = 0; i < args.length; i++) if (typeof args[i] === 'number') { n = args[i]; break; }
      return String(pick(v, n)).replace(/\{(\d)\}/g, function (_, j) { return args[+j] == null ? '' : String(args[+j]); });
    },
    // remember the choice on this phone, then reload so every screen starts fresh in the new language
    use: function (code, reload) {
      code = CODES.indexOf(code) > -1 ? code : 'en';
      ls('shepherd:lang', code);
      if (code === lang) return Promise.resolve(false);
      return loadPack(code).then(function () { if (reload !== false && typeof location !== 'undefined') location.reload(); return true; });
    },
    chosen: function () { return saved || ''; }
  };
  window.I18N = I18N;
  start(collect ? 'en' : (saved || detect()));
  if (collect) observe();
})();
