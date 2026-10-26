// Which English text seen while the tests ran has no translation? Run the tests with I18N_COLLECT=<file> first.
// node lang/coverage.cjs <collected.json>... [code]
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2), code = args.find(a => !a.endsWith('.json')) || 'es';
const seen = new Set(); args.filter(a => a.endsWith('.json')).forEach(f => JSON.parse(fs.readFileSync(f, 'utf8')).forEach(s => seen.add(s)));
const dict = JSON.parse(fs.readFileSync(path.join(__dirname, code + '.json'), 'utf8'));
const store = { 'shepherd:lang': code };
global.window = { SHEPHERD_LANGS: { [code]: dict } };
global.localStorage = { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; }, removeItem: k => { delete store[k]; } };
global.navigator = { languages: ['en'] };
global.document = { documentElement: { lang: '' } };
eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n.js'), 'utf8'));
const I = window.I18N, miss = [];
for (const s of seen) { if (!I.has(s)) miss.push(s); }
miss.sort((a, b) => a.length - b.length).forEach(s => console.log(s));
console.log(code + ': ' + (seen.size - miss.length) + ' of ' + seen.size + ' covered');
