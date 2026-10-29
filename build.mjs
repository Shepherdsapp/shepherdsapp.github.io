// Builds the two pages from src/. Run:  node build.mjs
//   index.html            the app for GitHub Pages (phone Home Screen and laptop browser), with web.js for sign-in,
//                         saving to your Shepherd server, notifications and installing
//   hosted/shepherd.html  the same app for hosting inside Claude (no GitHub, no Cloudflare)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const END = '<!--shepherd:end-->'; // sw.js only stores a page that ends with this (proof the whole file arrived)

const app = rd('src/app.html');
const cut = app.indexOf('</style>') + '</style>'.length;
if (cut < 20 || !app.startsWith('<title>Shepherd</title>')) throw new Error('src/app.html should start with its <title> and have one <style> block');
const head = app.slice(0, cut), bodyPart = app.slice(cut);
const safe = js => js.replace(/<\/script/gi, '<\\/script');
const web = rd('src/web.js');
const i18n = rd('src/i18n.js');
const privacy = rd('src/privacy.js');
// language packs: lang/<code>.json (English is the app itself). The website fetches the one it needs; the Claude
// version has them all inside it because it is a single file.
const LANGDIR = path.join(ROOT, 'lang');
const packs = {};
const CODES = ['es', 'fr', 'pt', 'nl', 'pl', 'pcm', 'yo', 'ig', 'zh-Hans', 'zh-Hant', 'ja', 'de', 'ru', 'lt'];
for (const c of CODES) { const f = path.join(LANGDIR, c + '.json'); if (fs.existsSync(f)) packs[c] = JSON.parse(fs.readFileSync(f, 'utf8')); }
// phones keep the language they downloaded; this number changes whenever any translation changes, so they fetch the new one
const packVer = (await import('crypto')).createHash('sha256').update(JSON.stringify(packs)).digest('hex').slice(0, 10);
if (!i18n.includes('var PACK_VER = 1;')) throw new Error('src/i18n.js should say var PACK_VER = 1;');
const i18nTag = '\n<script>/* src/i18n.js */\n' + safe(i18n.replace('var PACK_VER = 1;', "var PACK_VER = '" + packVer + "';")) + '\n</script>\n';
const privacyTag = '\n<script>/* src/privacy.js */\n' + safe(privacy) + '\n</script>\n';
const packTag = '\n<script>window.SHEPHERD_LANGS = ' + safe(JSON.stringify(packs)) + ';</script>';

// the website serves its fonts and QR library itself (no Google or other sites); the Claude version keeps the CDN links
const GFONTS = '<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&family=Literata:opsz,wght@7..72,500;7..72,600&display=swap">';
const QRCDN = '<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>';
if (!head.includes(GFONTS) || !head.includes(QRCDN)) throw new Error('src/app.html font or QR lines changed: update build.mjs');
const webHead = head.replace(GFONTS, '<link rel="stylesheet" href="vendor/fonts.css">').replace(QRCDN, '<script src="vendor/qrcode.min.js"></script>');
const page = '<!doctype html>\n<html lang="en-GB">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="description" content="Shepherd helps you follow up with the people you share your faith with: who to message, who to reply to, Bible studies and disciples.">\n' +
  '<meta name="theme-color" content="#FAF3DF">\n<meta name="color-scheme" content="light">\n' +
  '<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="mobile-web-app-capable" content="yes">\n' +
  '<meta name="apple-mobile-web-app-title" content="Shepherd">\n<meta name="apple-mobile-web-app-status-bar-style" content="default">\n' +
  '<link rel="manifest" href="manifest.json">\n<link rel="icon" type="image/png" href="icon-192.png">\n<link rel="apple-touch-icon" href="apple-touch-icon.png">\n' +
  webHead + i18nTag + privacyTag + '\n<script src="config.js"></script>\n<script>/* src/web.js */\n' + safe(web) + '\n</script>\n</head>\n<body>\n' +
  bodyPart.replace(/^\s*/, '') + '\n</body>\n</html>\n' + END + '\n';
if (/claude\.ai\/artifact/.test(page)) throw new Error('The website still points at the Claude artifact');
if (/googleapis|gstatic|cdnjs/.test(page)) throw new Error('The website still loads something from another site');
fs.writeFileSync(path.join(ROOT, 'index.html'), page);
fs.mkdirSync(path.join(ROOT, 'hosted'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'hosted', 'shepherd.html'), head + packTag + i18nTag + privacyTag + bodyPart);
// privacy.html: the privacy notice and acceptable use statement on their own, for anyone to read before signing up
const pvPage = '<!doctype html>\n<html lang="en-GB">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
  '<title>Shepherd · Privacy and safe use</title>\n<meta name="theme-color" content="#FAF3DF">\n<link rel="icon" type="image/png" href="icon-192.png">\n' +
  '<link rel="stylesheet" href="vendor/fonts.css">\n' +
  '<style>:root{--bg:#FAF3DF;--surface:#FFFCF3;--fg:#241F18;--muted:#574D3E;--line:#D8C8A2;--accent:#4E5A33;color-scheme:light}*{box-sizing:border-box}' +
  'body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 "Figtree","Segoe UI",system-ui,-apple-system,sans-serif}' +
  'main{max-width:640px;margin:0 auto;padding:calc(env(safe-area-inset-top,0px) + 24px) 16px 40px;display:grid;gap:14px}' +
  'header{display:flex;align-items:center;gap:12px}header svg{width:48px;height:48px;border-radius:12px;flex:none}' +
  'h1{font-family:"Literata",Georgia,serif;font-weight:600;font-size:clamp(26px,7vw,32px);line-height:1.15;margin:0}h3{margin:0;font-size:17px}' +
  '.card{background:var(--surface);border:1.5px solid var(--line);border-radius:16px;padding:16px;display:grid;gap:10px}.note{margin:0;color:var(--muted);font-size:15px}' +
  '.steps{margin:0;padding-left:22px;display:grid;gap:8px}.steps li{font-size:15px}.steps li::marker{color:var(--accent);font-weight:700}' +
  'a.open{display:inline-flex;justify-content:center;align-items:center;min-height:48px;border-radius:14px;background:var(--accent);color:#FFFBF3;font-weight:700;text-decoration:none;padding:0 20px}' +
  '[hidden]{display:none!important}</style>\n' +
  '<script src="config.js"></script>\n' + i18nTag + privacyTag + '</head>\n<body>\n<main>\n' +
  '<header><svg viewBox="0 0 104 104" aria-hidden="true"><rect width="104" height="104" rx="24" fill="#FAF3DF" stroke="#D8C8A2" stroke-width="3"/><path d="M45 79 V37 a12 12 0 0 1 12 -12 a12 12 0 0 1 12 12 v6" fill="none" stroke="#4E5A33" stroke-width="7" stroke-linecap="round"/></svg><h1>Privacy and safe use</h1></header>\n' +
  '<div id="pv" style="display:grid;gap:14px"></div>\n<a class="open" href="./">Open Shepherd</a>\n</main>\n' +
  '<script>document.getElementById("pv").innerHTML = window.ShepherdPrivacy.html();</script>\n</body>\n</html>\n';
fs.writeFileSync(path.join(ROOT, 'privacy.html'), pvPage);
const kb = f => Math.round(fs.statSync(path.join(ROOT, f)).size / 1024);
console.log(Object.keys(packs).length + ' language packs · index.html ' + kb('index.html') + ' KB · hosted/shepherd.html ' + kb('hosted/shepherd.html') + ' KB');
