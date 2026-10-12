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

const page = '<!doctype html>\n<html lang="en-GB">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="description" content="Shepherd helps you follow up with the people you share your faith with: who to message, who to reply to, Bible studies and disciples.">\n' +
  '<meta name="theme-color" content="#FAF3DF">\n<meta name="color-scheme" content="light">\n' +
  '<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="mobile-web-app-capable" content="yes">\n' +
  '<meta name="apple-mobile-web-app-title" content="Shepherd">\n<meta name="apple-mobile-web-app-status-bar-style" content="default">\n' +
  '<link rel="manifest" href="manifest.json">\n<link rel="icon" type="image/png" href="icon-192.png">\n<link rel="apple-touch-icon" href="apple-touch-icon.png">\n' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
  head + '\n<script src="config.js"></script>\n<script>/* src/web.js */\n' + safe(web) + '\n</script>\n</head>\n<body>\n' +
  bodyPart.replace(/^\s*/, '') + '\n</body>\n</html>\n' + END + '\n';
if (/claude\.ai\/artifact/.test(page)) throw new Error('The website still points at the Claude artifact');
fs.writeFileSync(path.join(ROOT, 'index.html'), page);
fs.mkdirSync(path.join(ROOT, 'hosted'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'hosted', 'shepherd.html'), app);
const kb = f => Math.round(fs.statSync(path.join(ROOT, f)).size / 1024);
console.log('index.html ' + kb('index.html') + ' KB · hosted/shepherd.html ' + kb('hosted/shepherd.html') + ' KB');
