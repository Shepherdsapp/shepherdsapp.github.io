// Builds lang/<code>.json from lang/keys.json (the English) and lang/src/<code>.txt (the translations), and checks
// that every line is there with the same {0} placeholders and <b>/<em> tags. Run: node lang/check.mjs
// Translation files: one line per text, "number<TAB>translation". Words that change with a number are written
// §one=…|few=…|many=…|other=… (the forms that language uses).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const keysTxt = fs.readFileSync(path.join(DIR, '_keys.txt'), 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
const kpath = path.join(DIR, 'keys.json');
const keys = fs.existsSync(kpath) ? JSON.parse(fs.readFileSync(kpath, 'utf8')) : {};
const have = new Set(Object.values(keys));
let next = Object.keys(keys).reduce((m, k) => Math.max(m, +k), 0) + 1;
for (const k of keysTxt) if (!have.has(k)) { keys[next++] = k; have.add(k); }
const live = new Set(keysTxt);
fs.writeFileSync(kpath, JSON.stringify(keys, null, 1) + '\n');
const ph = s => (s.match(/\{\d\}/g) || []).sort().join('');
const tags = s => ['<b>', '</b>', '<em>', '</em>'].map(t => s.split(t).length - 1).join(',');
let bad = 0;
const want = process.argv[2];
const files = {};
for (const f of fs.readdirSync(path.join(DIR, 'src')).sort()) if (f.endsWith('.txt')) (files[f.split('.')[0]] = files[f.split('.')[0]] || []).push(f);
for (const [code, parts] of Object.entries(files)) {
  if (want && want !== code) continue;
  const tr = {};
  parts.map(f => fs.readFileSync(path.join(DIR, 'src', f), 'utf8')).join('\n').split('\n').forEach((ln, i) => {
    if (!ln.trim() || ln.startsWith('#')) return;
    const m = /^(\d+)\t(.*)$/.exec(ln); if (!m) { console.log(code + ' line ' + (i + 1) + ': not "number<TAB>text"'); bad++; return; }
    if (!keys[m[1]]) { console.log(code + ' ' + m[1] + ': no such English line'); bad++; return; }
    let v = m[2].trim();
    if (v.startsWith('§')) { const o = {}; v.slice(1).split('|').forEach(p => { const e = p.indexOf('='); o[p.slice(0, e).trim()] = p.slice(e + 1).trim(); }); if (!o.other) { console.log(code + ' ' + m[1] + ': plural needs other='); bad++; } v = o; }
    tr[m[1]] = v;
  });
  const out = {}; let missing = 0;
  for (const [id, en] of Object.entries(keys)) {
    if (!live.has(en)) continue;
    const v = tr[id];
    if (v === undefined) { missing++; if (missing < 6) console.log(code + ' ' + id + ' missing: ' + en); continue; }
    for (const one of typeof v === 'object' ? Object.values(v) : [v]) {
      const okPlural = typeof v === 'object' && (en.match(/\{\d\}/g) || []).filter(x => !(one.match(/\{\d\}/g) || []).includes(x)).length <= 1 && (one.match(/\{\d\}/g) || []).every(x => en.includes(x));
      if (ph(one) !== ph(en) && !okPlural) { console.log(code + ' ' + id + ' placeholders differ: ' + en + ' → ' + one); bad++; }
      if (tags(one) !== tags(en)) { console.log(code + ' ' + id + ' <b>/<em> differ: ' + en + ' → ' + one); bad++; }
    }
    out[en] = v;
  }
  if (missing) { console.log(code + ': ' + missing + ' missing'); bad += missing; }
  fs.writeFileSync(path.join(DIR, code + '.json'), JSON.stringify(out));
  console.log(code + ': ' + Object.keys(out).length + ' lines');
}
console.log(Object.keys(keys).length + ' English lines' + (bad ? ', ' + bad + ' problems' : ', all good'));
process.exit(bad ? 1 : 0);
