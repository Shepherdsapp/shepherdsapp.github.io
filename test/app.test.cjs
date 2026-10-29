const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const nodeCrypto = require('crypto');
const { TextEncoder } = require('util');

const SRC = fs.readFileSync(require('path').join(__dirname, '..', 'hosted', 'shepherd.html'), 'utf8');
const results = []; let current = '';
const I18N_SINK = new Set();
function ok(cond, msg) { results.push({ group: current, ok: !!cond, msg }); if (!cond) console.log('  FAIL:', current, '-', msg); }
const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));

/* ---------- fake artifact store (same contract as the real db capability) ---------- */
function makeStore() {
  const docs = new Map(); const ls = []; const store = { docs, fail: null, writes: 0 };
  const clone = o => JSON.parse(JSON.stringify(o));
  const parentOf = p => p.split('/').slice(0, -1).join('/');
  const docSnap = p => ({ id: p.split('/').pop(), exists: docs.has(p), data: () => docs.has(p) ? clone(docs.get(p)) : undefined, metadata: { fromCache: false, hasPendingWrites: false } });
  const colSnap = c => { const d = [...docs.keys()].filter(k => parentOf(k) === c).sort().map(docSnap); return { docs: d, size: d.length, empty: !d.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } }; };
  const safe = f => () => { try { f(); } catch (e) { if (!/querySelector|closed/.test(String(e))) throw e; } };
  const notify = p => ls.forEach(l => { if (l.kind === 'doc' && l.path === p) setTimeout(safe(() => l.fn(docSnap(p))), 0); if (l.kind === 'col' && l.path === parentOf(p)) setTimeout(safe(() => l.fn(colSnap(l.path))), 0); });
  const check = p => { const n = p.split('/').length; if (n % 2) throw new TypeError('doc path needs even segments: ' + p); };
  function doc(p) {
    check(p);
    return {
      id: p.split('/').pop(), path: p,
      get: async () => docSnap(p),
      set: async d => { if (store.fail) throw { code: store.fail, message: 'fail' }; if (JSON.stringify(d).length > 256 * 1024) throw { code: 'invalid_argument' }; docs.set(p, clone(d)); store.writes++; notify(p); },
      update: async d => { if (!docs.has(p)) throw { code: 'invalid_argument' }; docs.set(p, Object.assign(docs.get(p), clone(d))); notify(p); },
      delete: async () => { if (store.fail) throw { code: store.fail, message: 'fail' }; docs.delete(p); notify(p); },
      onSnapshot: (fn) => { const l = { kind: 'doc', path: p, fn }; ls.push(l); setTimeout(() => fn(docSnap(p)), 0); return () => ls.splice(ls.indexOf(l), 1); },
      collection: sub => col(p + '/' + sub)
    };
  }
  function col(c) {
    if (c.split('/').length % 2 === 0) throw new TypeError('collection path needs odd segments: ' + c);
    return { path: c, doc: id => doc(c + '/' + (id || Math.random().toString(36).slice(2))), get: async () => colSnap(c), onSnapshot: (fn) => { const l = { kind: 'col', path: c, fn }; ls.push(l); setTimeout(() => fn(colSnap(c)), 0); return () => ls.splice(ls.indexOf(l), 1); } };
  }
  store.db = { doc, collection: col };
  return store;
}

async function open(store, opts = {}) {
  const errors = []; const copied = []; const saves = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/Not implemented: (navigation|window\.scrollTo)/.test(String(e.message))) errors.push(String(e.message)); });
  vc.on('error', e => errors.push(String(e && e.message || e)));
  const html = '<!doctype html><html><head><meta charset="utf8"></head><body>' + SRC.replace(/<script src="https:\/\/cdnjs[^>]*><\/script>/, '') + '</body></html>';
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://artifact.test/', virtualConsole: vc,
    storageQuota: 10000000,
    beforeParse(w) {
      if (opts.localStorage) for (const [k, v] of Object.entries(opts.localStorage)) w.localStorage.setItem(k, v);
      Object.defineProperty(w, 'crypto', { value: nodeCrypto.webcrypto });
      w.TextEncoder = TextEncoder;
      if (process.env.I18N_COLLECT) w.__i18nCollect = k => I18N_SINK.add(k);
      Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: t => { copied.push(t); return Promise.resolve(); } } });
      w.addEventListener('error', e => errors.push(String(e.message)));
      if (store) {
        const user = { id: async () => 'u_test', isOwner: async () => true };
        const downloads = { save: async r => { saves.push(r); return { status: 'saved' }; } };
        w.claude = { use: async n => n === 'db' ? store.db : n === 'user' ? user : n === 'downloads' ? downloads : null };
      }
    }
  });
  await wait(80);
  const w = dom.window, d = w.document;
  const $ = s => d.querySelector(s), $$ = s => [...d.querySelectorAll(s)];
  const click = el => { if (el === '#cAnother') tickConsent(); if (typeof el === 'string') el = $(el); if (!el) throw new Error('missing element'); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); };
  const setVal = (sel, v) => { const el = typeof sel === 'string' ? $(sel) : sel; el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); };
  // adding someone needs the consent tick; tests tick it unless they're checking that it's required
  const consent = { auto: true };
  const tickConsent = () => { const c = $('#cConsent'); if (consent.auto && c && $('#cAnother') && !c.checked) c.checked = true; };
  const submit = sel => { if (sel === '#cForm') tickConsent(); return $(sel).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); };
  const byText = (sel, text) => $$(sel).find(e => e.textContent.trim().includes(text));
  const S = () => w.__shepherd.S;
  return { dom, w, d, $, $$, click, setVal, submit, byText, S, errors, copied, saves, consent };
}
const TOURTEXT_OK = A => true;
const dayDiffNow = t => { const a = new Date(t); a.setHours(0, 0, 0, 0); const b = new Date(); b.setHours(0, 0, 0, 0); return Math.round((b - a) / 864e5); };
const ymd = t => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const addDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
const contactDocs = st => [...st.docs.entries()].filter(([k]) => k.startsWith('data/users/u_test/profile/contacts/')).map(([, v]) => v);
const eventDocs = st => [...st.docs.entries()].filter(([k]) => k.startsWith('data/users/u_test/profile/events/')).map(([, v]) => v);

(async () => {
  const store = makeStore();
  let A = await open(store);
  const { $, $$, click, setVal, submit, byText, S, w } = A;

  current = 'Acceptable use';
  await wait(400);
  ok($('#agree') && !$('#agree').hidden && /Before you start/.test($('#agree').textContent), 'a new user is asked to agree to the acceptable use statement first');
  const rules = $$('#agree .agree-in > .steps li').map(li => li.textContent);
  ok(rules.length === 6 && /responsible for the people you choose to contact/.test(rules[0]) && /got fairly/.test(rules[1]) && /stop/.test(rules[2]) && /share anyone's contact details/.test(rules[3]) && /spam, bulk messages, harassment/.test(rules[4]) && /data protection and privacy law/.test(rules[5]), 'it covers the six points from the data protection team');
  ok($('#tour').hidden, 'the tour waits until they agree');
  click('#agreeMore'); await wait();
  ok(!$('#agreeFull').hidden && /Who is responsible/.test($('#agreeFull').textContent) && /Pavi/.test($('#agreeFull').textContent), 'the full privacy notice can be read right there');
  click('#agreeGo'); await wait(500);
  ok($('#agree').hidden && store.docs.get('data/users/u_test/profile').agreed.v === 1 && store.docs.get('data/users/u_test/profile').agreed.at > 0, 'agreeing is recorded on their account, with the date');

  current = 'Tour for new users';
  ok(!$('#tour').hidden, 'tour starts by itself the first time someone opens Shepherd');
  ok($('#tourStep').textContent === '1 of 16' && /Welcome/.test($('#tourTitle').textContent), 'starts at step 1 of 16');
  ok(/no one you're checking up on slips through/.test($('#tourText').textContent), 'welcome uses the new wording');
  const titles = [$('#tourTitle').textContent];
  click('#tourNext'); await wait(30); titles.push($('#tourTitle').textContent);
  ok(S().view === 'settings' && $('#tourText').textContent === 'First, open Settings and add your WhatsApp number and the first message that will be sent automatically when they scan your QR code.', 'opens Settings by itself, with the new wording');
  ok($('#tourMore').textContent === 'Add my number now' && $('#tourNext').textContent === 'Skip this step', 'offers to do it now, or skip');
  click('#tourMore'); await wait(30);
  ok($('#tour').hidden && !$('#tourPill').hidden && /tap Save/.test($('#tourPill').textContent), 'steps aside while you add your number, with a Continue tour bar');
  setVal('#pPhone', '07700 900111'); submit('#profForm'); await wait(1200);
  ok(!$('#tour').hidden && $('#tourPill').hidden, 'carries on by itself once you save');
  titles.push($('#tourTitle').textContent);
  ok(/Most people use Shepherd on their phone, so turn on notifications/.test($('#tourText').textContent) && S().view === 'settings', 'next step: turn on phone alerts');
  click('#tourMore'); await wait(60);
  ok($('#tour').hidden && $('#sheetTitle').textContent === 'Turn on notifications', 'opens the notifications guide');
  const ng = $('#sheetBody').textContent;
  ok(/Shepherd app/.test(ng) && ng.includes('sitbackco.github.io/shepherd') && /Add to Home Screen/.test(ng) && /Install app/.test(ng), 'inside Claude, the guide points to the Shepherd app and how to install it');
  ok(!/Claude/.test(ng) && !/Google/.test(ng) && !/TimeTree/.test(ng), 'notifications guide has nothing to do with Claude, Google or TimeTree');
  ok($$('#sheetBody .osb[data-os="ios"]').length === 1 && $$('#sheetBody .osb[data-os="android"]').length === 1, 'install steps for iPhone and Android');
  click($$('#sheetBody [data-act="closesheet"]').find(b => /Back to the tour/.test(b.textContent))); await wait(450);
  ok(!$('#tour').hidden && $('#tourTitle').textContent === 'Turn on notifications', 'returns to the tour after the guide');
  for (let i = 0; i < 7; i++) {
    click('#tourNext'); await wait(30); titles.push($('#tourTitle').textContent);
    if (i === 0) ok(S().view === 'today' && /Add someone/.test($('#tourText').textContent), 'goes to Today by itself, to Add someone');
    if (i === 1) ok(/QR code/.test($('#tourText').textContent), 'shows the QR code');
    if (i === 5) ok(S().view === 'people' && /log a Bible study/i.test($('#tourText').textContent) && /No longer contact/.test($('#tourText').textContent), 'explains a person\'s page');
    if (i === 6) ok(/Journey/.test($('#tourText').textContent), 'explains List and Journey');
  }
  click('#tourNext'); await wait(30); titles.push($('#tourTitle').textContent);
  ok(S().view === 'disciples' && /already disciples/.test($('#tourText').textContent) && /1 Thessalonians 5:11/.test($('#tourText').textContent) && $('#tourMore').textContent === 'Add a disciple', 'opens Disciples by itself with the verse');
  click('#tourNext'); await wait(30); titles.push($('#tourTitle').textContent);
  ok(S().view === 'today' && /pray for/.test($('#tourText').textContent), 'explains the prayer list');
  click('#tourNext'); await wait(30); titles.push($('#tourTitle').textContent);
  ok(S().view === 'events' && $('#tourText').textContent === 'Invite people and tick who came. Connect Shepherd to your phone\'s calendar so your studies and events show there by themselves.', 'opens Calendar by itself, with the new wording');
  ok(/link my calendar/.test($('#tourMore').textContent), 'Calendar step offers the step-by-step guide');
  click('#tourMore'); await wait(60);
  ok($('#tour').hidden && $('#sheetTitle').textContent === 'Link your calendar', 'calendar guide opens');
  const guide = $('#sheetBody').textContent;
  ok(/1\. Connect Shepherd to your phone calendar/.test(guide) && /2\. Keep your personal TimeTree events in your calendar too/.test(guide) && !/Select Display Filters|Settings › TimeTree/.test(guide), 'step 1 connects Shepherd to the phone calendar; no linking TimeTree');
  ok(!/Google/.test(guide) && $$('#sheetBody section .h3, #sheetBody section h3').length === 2, 'two steps, no Google');
  ok($$('#sheetBody .osb[data-os="ios"]').length === 1 && $$('#sheetBody .osb[data-os="android"]').length === 1 && /works in the Shepherd app/.test(guide), 'iPhone and Android steps; connecting points to the Shepherd app inside Claude');
  click($$('#sheetBody [data-act="closesheet"]').find(b => /Back to the tour/.test(b.textContent))); await wait(450);
  ok(!$('#tour').hidden && $('#tourTitle').textContent === 'Your calendar', 'closing the guide returns to the tour');
  click('#tourNext'); await wait(30); titles.push($('#tourTitle').textContent);
  ok(S().view === 'week', 'shows the Week tab');
  click('#tourNext'); await wait(30); titles.push($('#tourTitle').textContent);
  ok(S().view === 'settings' && /language/.test($('#tourText').textContent) && /PIN/.test($('#tourText').textContent) && /Privacy and safe use/.test($('#tourText').textContent), 'points out language, contacts, PIN, backups and privacy in Settings');
  click('#tourNext'); await wait(30); titles.push($('#tourTitle').textContent);
  ok(/responsible for the people you contact/.test($('#tourText').textContent), 'ends with the reminder that you are responsible for who you contact');
  ok(titles.join('|') === "Welcome to Shepherd|Start in Settings|Turn on notifications|Add someone|Or show your QR code|Start each day here|Message in one tap|When they reply|Everyone's page|List or Journey|Disciples|Pray for people|Your calendar|Your week|Settings has the rest|You're all set", 'all 16 steps in order: ' + titles.join(' / '));
  ok($('#tourNext').textContent === 'Done', 'last step says Done');
  click('#tourNext'); await wait(60);
  ok($('#tour').hidden && S().view === 'today', 'finishing goes back to Today');
  ok(store.docs.get('data/users/u_test/profile').tourDone === true && store.docs.get('data/users/u_test/profile').phone === '07700 900111', 'tour marked done, and the number you added is saved');

  current = 'Boot';
  ok($('.empty'), 'empty state shows for a new user');
  ok($('#sync').textContent.trim() === 'Saved', 'sync status reads Saved (got ' + $('#sync').textContent.trim() + ')');
  ok($('.brand').textContent.includes('Shepherd'), 'app name is Shepherd');
  ok($('.mark path').getAttribute('d') === 'M45 79 V37 a12 12 0 0 1 12 -12 a12 12 0 0 1 12 12 v6', 'header uses the chosen crook icon');

  current = 'Add contact: groups and where-met removed';
  click('#fab'); await wait();
  ok($('#sheet').hidden === false, 'add sheet opens');
  ok(!$('#cGroup') && !/Group/.test($('#sheetBody').textContent), 'no group field');
  ok(!$('#cMet'), 'no "where you met" field when adding');
  ok($('#cSp') && $('#cSh'), 'social media field present');
  ok($('#cSp').options[0].value === 'Instagram' && $('#cSp').value === 'Instagram', 'Instagram is the first and default social option');
  ok(!$('#cChan') && !/usually message/i.test($('#sheetBody').textContent), '"They usually message on" removed');

  current = 'Add contact: validation';
  submit('#cForm'); await wait();
  ok(!$('#cErr').hidden && /name/i.test($('#cErr').textContent), 'empty name shows an error');
  ok(contactDocs(store).length === 0, 'nothing saved without a name');
  setVal('#cName', 'Sam Test'); setVal('#cPhone', '123'); submit('#cForm'); await wait();
  ok(/phone number/i.test($('#cErr').textContent), 'bad phone shows an error');
  ok(contactDocs(store).length === 0, 'nothing saved with a bad number');

  current = 'Add contact: save';
  setVal('#cPhone', '07700 900123'); setVal('#cSh', 'https://instagram.com/sam.t/'); setVal('#cNotes', 'Met outside the station');
  submit('#cForm'); await wait(60);
  let cs = contactDocs(store);
  ok(cs.length === 1, 'contact saved to the store');
  const sam = cs[0];
  ok(sam && sam.instagram === 'sam.t', 'Instagram link cleaned to a handle (' + (sam && sam.instagram) + ')');
  ok(sam && !('group' in sam) && !sam.met, 'no group or where-met saved');
  ok(sam && sam.everyDays === 3, 'default check-in every 3 days');
  ok($('#sheet').classList.contains('on') === false, 'sheet closes after saving');
  ok(!$('#toastAct').hidden && $('#toastAct').textContent === 'Save to phone', 'toast offers to save them to phone contacts');
  click('#toastAct'); await wait();
  ok(A.copied.pop() === 'Sam Test\n07700 900123\nInstagram: @sam.t', 'inside Claude, details are copied ready to paste into Contacts');

  current = 'Save and add another';
  click('#fab'); await wait();
  setVal('#cName', 'Second Person'); click('#cAnother'); await wait(60);
  ok(contactDocs(store).length === 2 && $('#sheet').classList.contains('on') && $('#cName').value === '', 'second contact saved and a fresh form opens');
  click(byText('#sheet [data-act="closesheet"]', '') || '#sheet [data-act="closesheet"]'); await wait(400);

  current = 'Today list and WhatsApp';
  click('[data-act="tab"][data-v="today"]'); await wait();
  const samId = sam.id;
  let row = $$('.prow').find(r => r.textContent.includes('Sam Test'));
  ok(row && byText('.sec h2', 'Message today'), 'new contact appears under Message today');
  const wa = row && row.querySelector('a.ch');
  ok(wa && wa.getAttribute('href') === 'https://wa.me/447700900123', 'chat button opens WhatsApp with UK number (' + (wa && wa.getAttribute('href')) + ')');
  click(wa); await wait(60);
  let c = S().contacts[samId];
  ok(c.lastContact && c.log.some(l => l.text === 'Messaged on WhatsApp'), 'tapping WhatsApp logs the contact');
  ok(w.__shepherd.state(c) === 'ok', 'status turns green after contact');
  ok(c.replyState === 'them' && c.waitingSince, 'messaging marks them Waiting on them');
  ok(/Waiting on Sam to reply/.test($('#toastMsg').textContent), 'toast confirms Shepherd is waiting');
  ok(!$$('#main .prow').some(r => r.textContent.includes('Sam Test')), 'once messaged, they leave Today (Today only shows who to chase)');
  click('[data-act="tab"][data-v="people"]'); await wait();
  row = $$('.prow').find(r => r.textContent.includes('Sam Test'));
  ok(row && row.querySelector('.rep') && row.querySelector('.rep').textContent === 'Replied', 'on People, their row shows a Replied button');
  ok(/waiting on them/.test(row.textContent), 'row says waiting on them');
  click('#toastAct'); await wait(60);
  c = S().contacts[samId];
  ok(!c.lastContact && !c.log.some(l => l.text === 'Messaged on WhatsApp') && c.replyState !== 'them', 'Undo reverses it');
  ok(contactDocs(store).find(x => x.id === samId).lastContact == null, 'Undo is saved too');

  current = 'Contact page: channels and reply state';
  click($$('.prow-main').find(b => b.textContent.includes('Sam Test'))); await wait();
  ok($('.h1').textContent.includes('Sam Test'), 'contact page opens');
  const ig = $$('a.btn').find(a => a.textContent.includes('Message on Instagram'));
  ok(ig && ig.getAttribute('href') === 'https://ig.me/m/sam.t', 'Instagram button opens a DM');
  click(ig); await wait(60);
  ok(S().contacts[samId].log.some(l => l.text === 'Messaged on Instagram'), 'Instagram message logged');
  click('[data-act="reply"][data-r="me"]'); await wait(40);
  ok(S().contacts[samId].replyState === 'me', 'I need to reply saved');
  click('[data-act="tab"][data-v="today"]'); await wait();
  ok(byText('.sec h2', 'Reply to') && $$('.prow').some(r => r.textContent.includes('Sam Test') && r.textContent.includes('You need to reply')), 'Today shows Reply to');
  ok(!$('#badge').hidden, 'Today tab shows a badge');
  click($$('.prow-main').find(b => b.textContent.includes('Sam Test'))); await wait();
  click('[data-act="contacted"]'); await wait(60);
  ok(S().contacts[samId].replyState === 'none', 'logging a contact clears "I need to reply"');

  current = 'One-tap replies';
  click('[data-act="tab"][data-v="people"]'); await wait();
  click($$('.prow').find(r => r.textContent.includes('Sam Test')).querySelector('a.ch')); await wait(60);
  ok(S().contacts[samId].replyState === 'them', 'waiting after messaging');
  ok($$('.prow').some(r => r.textContent.includes('Sam Test') && r.querySelector('.rep')), 'People shows who you\'re waiting on, with Replied');
  click($$('.prow').find(r => r.textContent.includes('Sam Test')).querySelector('.rep')); await wait(60);
  c = S().contacts[samId];
  ok(c.replyState === 'me' && c.meSince && c.log.some(l => l.text === 'Sam replied'), 'Replied moves them to Reply to');
  click('[data-act="tab"][data-v="today"]'); await wait();
  row = $$('.prow').find(r => r.textContent.includes('Sam Test'));
  ok(byText('.sec h2', 'Reply to') && row.querySelector('.rep.me').textContent === 'I replied', 'row now offers I replied');
  click(row.querySelector('.rep.me')); await wait(60);
  c = S().contacts[samId];
  ok(c.replyState === 'them' && c.log.some(l => l.text === 'You replied'), 'I replied puts them back to waiting');

  current = 'Daily catch-up';
  const twoDaysAgo = Date.now() - 2 * 86400e3;
  Object.assign(w.__shepherd.S.contacts[samId], { waitingSince: twoDaysAgo, catchAskedOn: '' });
  click('[data-act="tab"][data-v="today"]'); await wait();
  ok($('#catchCard') && /Did Sam reply\?/.test($('#catchCard').textContent) && /2 days ago/.test($('#catchCard').textContent), 'asks whether someone you messaged 2 days ago replied');
  ok(/Did they reply\? Sam \(2d\)/.test(w.__shepherd.digest()), 'morning alert asks too');
  click('#catchCard [data-act="catchwait"]'); await wait(60);
  ok(!$('#catchCard') && S().contacts[samId].catchAskedOn === ymd(Date.now()) && S().contacts[samId].replyState === 'them', 'Still waiting hides it until tomorrow');
  Object.assign(w.__shepherd.S.contacts[samId], { catchAskedOn: '' }); click('[data-act="tab"][data-v="today"]'); await wait();
  const chase = $$('#catchCard a').find(a => /Chase Sam/.test(a.textContent));
  ok(chase && /wa\.me/.test(chase.href), 'Chase opens their chat');
  click(chase); await wait(60);
  c = S().contacts[samId];
  ok(c.log.some(l => l.text === 'Chased up on WhatsApp') && c.catchAskedOn === ymd(Date.now()) && dayDiffNow(c.waitingSince) === 0, 'chasing is logged and the wait restarts');
  Object.assign(w.__shepherd.S.contacts[samId], { waitingSince: twoDaysAgo, catchAskedOn: '' }); click('[data-act="tab"][data-v="today"]'); await wait();
  click('#catchCard [data-act="theyreplied"]'); await wait(60);
  ok(S().contacts[samId].replyState === 'me', 'answering Sam replied moves them to Reply to');
  Object.assign(w.__shepherd.S.contacts[samId], { meSince: Date.now() - 3 * 3600e3, catchAskedOn: '' }); click('[data-act="tab"][data-v="today"]'); await wait();
  ok($('#catchCard') && /Have you replied to Sam yet\?/.test($('#catchCard').textContent), 'asks whether you replied');
  click('#catchCard [data-act="ireplied"]'); await wait(60);
  ok(S().contacts[samId].replyState === 'them' && !$('#catchCard'), 'Yes, I replied puts them back to waiting');
  Object.assign(w.__shepherd.S.contacts[samId], { waitingSince: twoDaysAgo, catchAskedOn: '' }); click('[data-act="tab"][data-v="today"]'); await wait();
  click('#catchCard [data-act="catchskip"]'); await wait(60);
  ok(!$('#catchCard'), 'Ask me tomorrow clears the card');
  click('[data-act="tab"][data-v="people"]'); await wait();
  click('[data-act="filter"][data-f="waiting"]'); await wait();
  ok($$('#plist .prow').length === 1 && /gone quiet|waiting/.test($('#plist').textContent), 'Waiting on them filter');
  click('[data-act="filter"][data-f="all"]'); await wait();
  click($$('.prow-main').find(b => b.textContent.includes('Sam Test'))); await wait();
  click('[data-act="reply"][data-r="none"]'); await wait(40);

  current = 'Edit: switch social app';
  click('[data-act="edit"]'); await wait();
  ok($('#cMet'), 'edit form keeps optional where-you-met');
  ok($('#cSp').value === 'Instagram' && $('#cSh').value === '@sam.t', 'edit form shows their Instagram');
  setVal('#cSp', 'Snapchat'); setVal('#cSh', '@samsnap');
  click('#cStage button[data-v="Interested"]');
  submit('#cForm'); await wait(60);
  c = S().contacts[samId];
  ok(c.social2 === 'samsnap' && c.social2Platform === 'Snapchat' && c.instagram === '' && c.stage === 'Interested', 'switching to Snapchat replaces the Instagram handle');
  ok($$('a.btn')[0] && $$('a.btn')[0].textContent.includes('WhatsApp'), 'WhatsApp shows first when they have a number');
  ok($$('a.btn').some(a => a.getAttribute('href') === 'https://www.snapchat.com/add/samsnap'), 'Snapchat button links to their profile');
  click('[data-act="tophone"]'); await wait();
  ok(A.copied.pop().includes('Snapchat: samsnap'), 'Add to phone contacts copies all details');

  current = 'Check-in rhythm';
  setVal('#every', '7'); await wait(40);
  ok(S().contacts[samId].everyDays === 7, 'rhythm changed to weekly');

  current = 'Log a study';
  click('[data-act="logstudy"]'); await wait();
  setVal('#sTopic', 'Intro'); setVal('#nDate', addDays(-1)); submit('#sForm'); await wait();
  ok(!$('#sErr').hidden, 'next study before this one is rejected');
  setVal('#nDate', addDays(3)); setVal('#nTime', '19:30'); setVal('#nTopic', 'Prayer');
  submit('#sForm'); await wait(60);
  c = S().contacts[samId];
  ok(c.studies.length === 1 && c.nextStudy.date === addDays(3) && c.stage === 'Studying', 'study saved, next study set, stage moved to Studying');
  ok($('#sheetTitle').textContent === 'Study saved' && !$$('#sheetBody a').some(a => /google/i.test(a.href)) && $$('#sheetBody .osb').length === 2, 'study saved: copy for TimeTree with iPhone and Android steps, no Google');
  click('#ttCopy'); await wait();
  ok(/Bible study – Sam[\s\S]*7:30pm[\s\S]*Prayer/.test(A.copied.pop()), 'TimeTree copy text is complete');
  click('#sheet [data-act="closesheet"]'); await wait(400);

  current = 'Leave for now';
  click('[data-act="pause"]'); await wait();
  click('#pWhen button[data-d="7"]'); click('#pWhy button[data-v="Busy right now"]');
  click('#pGo'); await wait(60);
  c = S().contacts[samId];
  ok(c.status === 'paused' && c.pauseUntil === addDays(7), 'paused for a week');
  click('[data-act="tab"][data-v="today"]'); await wait();
  ok(!$$('.prow').some(r => r.textContent.includes('Sam Test')), 'paused contact is off Today');
  c.pauseUntil = addDays(-1); w.__shepherd.S.contacts[samId] = c; click('[data-act="tab"][data-v="today"]'); await wait();
  ok($$('.prow').some(r => r.textContent.includes('Sam Test') && r.textContent.includes('Overdue')), 'comes back to Today after the pause date');
  click($$('.prow-main').find(b => b.textContent.includes('Sam Test'))); await wait();
  click('[data-act="contacted"]'); await wait(60);
  ok(S().contacts[samId].status === 'active' && w.__shepherd.state(S().contacts[samId]) === 'ok', 'contacting after a pause makes them active again');

  current = 'No longer contact, undo, restore';
  click('[data-act="archive"]'); await wait();
  click('#aGo'); await wait();
  ok(!$('#aErr').hidden, 'reason required');
  click('#aWhy button[data-v="Asked us not to contact them"]'); await wait();
  ok(!$('#aAsk').hidden, 'shows the full-delete hint when they asked not to be contacted');
  click('#aGo'); await wait(60);
  ok(S().contacts[samId].status === 'archived', 'archived');
  ok(!$$('.prow').some(r => r.textContent.includes('Sam Test')), 'gone from People');
  click('#toastAct'); await wait(60);
  ok(S().contacts[samId].status === 'active', 'Undo restores');
  click($$('.prow-main').find(b => b.textContent.includes('Sam Test'))); await wait();
  click('[data-act="archive"]'); await wait(); click('#aWhy button[data-v="Moved away"]'); click('#aGo'); await wait(60);
  click('[data-act="archive-list"]'); await wait();
  ok($$('.prow').some(r => r.textContent.includes('Sam Test') && r.textContent.includes('Moved away')), 'listed under No longer contacting with reason');
  click($$('.prow-main').find(b => b.textContent.includes('Sam Test'))); await wait();
  click('[data-act="restore"]'); await wait(60);
  ok(S().contacts[samId].status === 'active' && contactDocs(store).find(x => x.id === samId).status === 'active', 'restore saved');

  current = 'Events';
  click('[data-act="tab"][data-v="events"]'); await wait();
  click('[data-act="newevent"]'); await wait();
  setVal('#eName', ''); submit('#eForm'); await wait();
  ok(!$('#eErr').hidden, 'event needs a name');
  setVal('#eName', 'Sunday service'); setVal('#eDate', addDays(1)); setVal('#eTime', '10:30'); setVal('#ePlace', 'Main hall');
  submit('#eForm'); await wait(60);
  let ev = eventDocs(store).find(e => e.name === 'Sunday service');
  ok(ev, 'event saved');
  ok($('#sheetTitle').textContent === 'Sunday service', 'event sheet opens');
  const inv = $('#inv-' + samId), came = $('#came-' + samId);
  inv.checked = true; inv.dispatchEvent(new w.Event('change', { bubbles: true })); await wait(40);
  ev = S().events[ev.id];
  ok(ev.invited.length === 1 && ev.invited[0] === samId, 'invite saved once (no double toggle)');
  const invBtn = $$('#sheetBody .checklist a.ch')[0];
  ok(invBtn && decodeURIComponent(invBtn.getAttribute('href')) === 'https://wa.me/447700900123?text=Hi Sam! Would you like to come to Sunday service tomorrow at 10:30am (Main hall)? It would be great to see you there.', 'WhatsApp invite is pre-written');
  const logsBefore = S().contacts[samId].log.length;
  click(invBtn); await wait(40);
  ok(S().contacts[samId].log.length === logsBefore, 'sending an invite does not count as a check-in');
  came.checked = true; came.dispatchEvent(new w.Event('change', { bubbles: true })); await wait(40);
  ok(S().events[ev.id].came.length === 1, 'came saved');
  inv.checked = false; inv.dispatchEvent(new w.Event('change', { bubbles: true })); await wait(40);
  ok(S().events[ev.id].invited.length === 0 && S().events[ev.id].came.length === 0 && !came.checked, 'uninviting also clears came');
  // reopen the sheet a second time and make sure listeners don't stack
  click('#sheet [data-act="closesheet"]'); await wait(400);
  click($$('.ev').find(b => b.textContent.includes('Sunday service'))); await wait();
  click('#sheet [data-act="closesheet"]'); await wait(400);
  click($$('.ev').find(b => b.textContent.includes('Sunday service'))); await wait();
  const inv2 = $('#inv-' + samId); inv2.checked = true; inv2.dispatchEvent(new w.Event('change', { bubbles: true })); await wait(40);
  ok(S().events[ev.id].invited.length === 1, 'after reopening, one tick = one invite');
  ok(S().contacts[samId].log.filter(l => /Invited to Sunday service/.test(l.text)).length === 2, 'invites recorded in their activity');
  click('[data-act="tab"][data-v="today"]'); await wait();
  ok(!$$('#main .ev').some(b => b.textContent.includes('Sunday service')), 'tomorrow\'s event stays off Today (Today is just today)');
  S().events.todayEv = { id: 'todayEv', name: 'Prayer meeting', date: ymd(Date.now()), time: '23:59', invited: [], came: [] };
  click('[data-act="tab"][data-v="people"]'); await wait(); click('[data-act="tab"][data-v="today"]'); await wait();
  ok(byText('.sec h2', 'Events today') && $$('#evToday .ev').some(b => b.textContent.includes('Prayer meeting')), 'an event today shows on Today');
  delete S().events.todayEv;

  current = 'Invite an Instagram-only contact';
  w.__shepherd.S.contacts.igonly = { id: 'igonly', name: 'Ivy Gram', instagram: 'ivy.g', status: 'active', createdAt: Date.now(), log: [] };
  click('[data-act="tab"][data-v="events"]'); await wait();
  click($$('.ev').find(b => b.textContent.includes('Sunday service'))); await wait();
  const ivyLi = $$('#sheetBody .checklist li').find(li => li.querySelector('#inv-igonly'));
  const ivyBtn = ivyLi && ivyLi.querySelector('a.ch');
  ok(ivyBtn && ivyBtn.getAttribute('href') === 'https://ig.me/m/ivy.g', 'invited through Instagram');
  click(ivyBtn); await wait(40);
  ok(A.copied.pop() === 'Hi Ivy! Would you like to come to Sunday service tomorrow at 10:30am (Main hall)? It would be great to see you there.', 'invite text copied, ready to paste into Instagram');
  delete w.__shepherd.S.contacts.igonly;
  click('#sheet [data-act="closesheet"]'); await wait(400);

  current = 'Calendar import (.ics)';
  const dt = (n, h) => addDays(n).replace(/-/g, '') + (h ? 'T' + h : '');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VTIMEZONE', 'TZID:Europe/London', 'BEGIN:STANDARD', 'DTSTART:19701025T020000', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:one@test', 'SUMMARY:Bible talk\\, evening', 'DTSTART;TZID=Europe/London:' + dt(3, '190000'), 'LOCATION:Room 2', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:two@test', 'SUMMARY:Church picnic', 'DTSTART;VALUE=DATE:' + dt(5), 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:three@test', 'SUMMARY:Midweek service', 'DTSTART;TZID=Europe/London:' + dt(-70, '193000'), 'RRULE:FREQ=WEEKLY', 'EXDATE;TZID=Europe/London:' + dt(-70 + 77, '193000'), 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:four@test', 'SUMMARY:Cancelled thing', 'DTSTART:' + dt(2, '120000') + 'Z', 'STATUS:CANCELLED', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:five@test', 'SUMMARY:Too far away', 'DTSTART:' + dt(200, '120000'), 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:six@test', 'SUMMARY:Long title that is folded across', ' two lines', 'DTSTART:' + dt(4, '090000'), 'BEGIN:VALARM', 'TRIGGER:-PT15M', 'DESCRIPTION:Reminder', 'END:VALARM', 'END:VEVENT',
    'END:VCALENDAR'].join('\r\n');
  const before = Object.keys(S().events).length;
  w.__shepherd.importICS(ics); await wait(60);
  const calEvs = Object.values(S().events).filter(e => e.source === 'calendar');
  const mids = calEvs.filter(e => e.name === 'Midweek service').map(e => e.date).sort();
  ok(calEvs.some(e => e.name === 'Bible talk, evening' && e.time === '19:00' && e.place === 'Room 2'), 'timed event imported with escaped comma, time and place');
  ok(calEvs.some(e => e.name === 'Church picnic' && e.time === '' && e.date === addDays(5)), 'all-day event imported');
  ok(!calEvs.some(e => e.name === 'Cancelled thing') && !calEvs.some(e => e.name === 'Too far away'), 'cancelled and far-future events skipped');
  ok(calEvs.some(e => e.name === 'Long title that is folded acrosstwo lines' || e.name === 'Long title that is folded across two lines'), 'folded lines joined, alarm ignored');
  ok(mids.length >= 13 && mids.length <= 15 && !mids.includes(addDays(7)), 'weekly repeat expanded for the window, skipped date honoured (' + mids.length + ')');
  ok(mids.every(m => m >= addDays(-14) && m <= addDays(90)), 'only last 2 weeks to next 3 months');
  const afterFirst = Object.keys(S().events).length;
  w.__shepherd.importICS(ics); await wait(60);
  ok(Object.keys(S().events).length === afterFirst, 'importing again adds no duplicates');
  ok(/already here/.test($('#toastMsg').textContent), 'tells you nothing new was found');
  ok(eventDocs(store).filter(e => e.source === 'calendar').length === afterFirst - before, 'calendar events saved to the store');
  click('[data-act="tab"][data-v="events"]'); await wait();
  ok($$('.ev.fromcal').length > 0 && $$('.ev.fromcal')[0].textContent.includes('From your calendar'), 'calendar events marked as from your calendar');
  click($$('.ev.fromcal').find(b => b.textContent.includes('Church picnic'))); await wait();
  click('#evDel'); click('#evDel'); await wait(450);
  ok(!Object.values(S().events).some(e => e.name === 'Church picnic'), 'calendar event deleted');
  w.__shepherd.importICS(ics); await wait(60);
  ok(!Object.values(S().events).some(e => e.name === 'Church picnic'), 'deleted calendar event stays deleted on re-import');
  click('[data-act="calimport"]'); await wait();
  ok($('#icsFile') && !/Google/.test($('#sheetBody').textContent) && $$('#sheetBody .osb').length === 2, 'calendar file sheet has iPhone and Android steps, no Google');
  click('#sheet [data-act="closesheet"]'); await wait(400);

  current = 'Disciples';
  click('[data-act="tab"][data-v="disciples"]'); await wait();
  ok($('.tab[data-v="disciples"]').getAttribute('aria-current') === 'page', 'Disciples tab opens');
  ok($('.tab[data-v="events"]').textContent.trim() === 'Calendar', 'Events tab is now called Calendar');
  ok(/Therefore encourage one another and build each other up, just as in fact you are doing/.test($('.verse').textContent) && /1 Thessalonians 5:11 \(NIV\)/.test($('.verse').textContent), 'shows 1 Thessalonians 5:11');
  submit('#dForm'); await wait();
  ok(!$('#dErr').hidden, 'name is required');
  setVal('#dName', 'Ama Mensah'); setVal('#dPhone', '07700 900777'); submit('#dForm'); await wait(60);
  setVal('#dName', 'Ben'); submit('#dForm'); await wait(60);
  const dDocs = () => [...store.docs.entries()].filter(([k]) => k.startsWith('data/users/u_test/profile/disciples/')).map(([, v]) => v);
  ok(dDocs().length === 2 && dDocs().some(d => d.name === 'Ben' && !d.phone), 'disciples saved with just a name (number optional)');
  ok(/0 of 2 this week/.test($('.meter').textContent) && byText('.sec h2', 'To check this week'), 'shows who to check this week');
  const amaRow = () => $$('.prow').find(r => r.textContent.includes('Ama Mensah'));
  ok(amaRow().querySelector('a.ch').getAttribute('href') === 'https://wa.me/447700900777', 'message button opens WhatsApp');
  ok(/Disciples to check on this week: Ama, Ben/.test(w.__shepherd.digest()), 'morning alert lists who to check on');
  click('[data-act="tab"][data-v="today"]'); await wait();
  ok($('#dSum') && $$('#dSum .dchip').map(b => b.textContent).join(',') === 'Ama,Ben' && /0 of 2 done/.test($('#dSum').textContent), 'Today has a small summary of disciples to check on');
  click('[data-act="tab"][data-v="disciples"]'); await wait();
  click(amaRow().querySelector('[data-act="dcheck"]')); await wait(60);
  ok(byText('.sec h2', 'Done this week') && /Checked in today/.test(amaRow().textContent) && /1 of 2 this week/.test($('.meter').textContent), 'Checked in moves them to Done this week');
  ok(!/Ama/.test(w.__shepherd.digest().split('\n').find(l => /Disciples/.test(l)) || ''), 'checked-in disciples drop off the alert');
  click('#toastAct'); await wait(60);
  ok(!/Checked in today/.test(amaRow().textContent), 'Undo works');
  click(amaRow().querySelector('a.ch')); await wait(60);
  ok(/Checked in today/.test(amaRow().textContent) && dDocs().find(d => d.name === 'Ama Mensah').log.some(l => l.text === 'Messaged on WhatsApp'), 'messaging counts as this week\'s check-in');
  click(amaRow().querySelector('.prow-main')); await wait();
  setVal('#deNotes', 'New job, pray for her'); submit('#deForm'); await wait(60);
  ok(S().disciples[Object.keys(S().disciples).find(k => S().disciples[k].name === 'Ama Mensah')].notes === 'New job, pray for her', 'notes saved');
  click($$('.prow').find(r => r.textContent.includes('Ben')).querySelector('.prow-main')); await wait();
  click('#deDel'); click('#deDel'); await wait(450);
  ok(dDocs().length === 1 && !$$('.prow').some(r => r.textContent.includes('Ben')), 'remove takes two taps and deletes');
  w.__shepherd.S.view = 'today';

  current = 'Replay the tour';
  click('[data-act="settings"]'); await wait();
  click('[data-act="tour"]'); await wait(40);
  ok(!$('#tour').hidden && $('#tourStep').textContent === '1 of 16', 'Show me around replays the tour');
  for (let i = 0; i < 6; i++) { click('#tourNext'); await wait(20); }
  ok($('#tourTitle').textContent === 'Message in one tap' && S().view === 'today' && $('#main .prow .ch'), 'Message step shows Today with a real message button to point at');
  click('#tourSkip'); await wait(40);
  ok($('#tour').hidden, 'Skip closes it');

  current = 'Notification settings';
  click('[data-act="settings"]'); await wait();
  ok(!/Groups/.test($('#main').textContent), 'no groups in settings');
  ok($$('#notifCard input[type="checkbox"]').length === 7, 'seven alert tickboxes, including Catch-up and Disciples');
  ok($('#pAlert').value === '08:00', 'reminder time starts at 8am');
  setVal('#pAlert', '07:15'); $('#pAlert').dispatchEvent(new w.Event('change', { bubbles: true })); await wait(60);
  ok(S().profile.alertTime === '07:15' && store.docs.get('data/users/u_test/profile').alertTime === '07:15', 'changing the reminder time is saved');
  ok(S().profile.alertTime === '07:15' && $('#pAlert').value === '07:15', 'settings show the new time');
  setVal('#pAlert', '08:00'); $('#pAlert').dispatchEvent(new w.Event('change', { bubbles: true })); await wait(60);
  click('#nPreset button[data-preset="Events only"]'); await wait(60);
  let N = S().profile.notify;
  ok(N.events && !N.chase && !N.replies && !N.studies && !N.weekly, 'Events only preset');
  ok(store.docs.get('data/users/u_test/profile').notify.events === true && store.docs.get('data/users/u_test/profile').notify.chase === false, 'choices saved to the store');
  ok($('#nPreset button[data-preset="Events only"]').getAttribute('aria-pressed') === 'true', 'preset shows as selected');
  ok(/^Events:/.test($('#nPreview').textContent) && !/Message/.test($('#nPreview').textContent), 'preview only mentions events');
  const cb = $('#n-chase'); cb.checked = true; cb.dispatchEvent(new w.Event('change', { bubbles: true })); await wait(60);
  ok(S().profile.notify.chase === true && !$$('#nPreset button').some(b => b.getAttribute('aria-pressed') === 'true'), 'custom tick saved, no preset highlighted');
  click('#nPreset button[data-preset="Off"]'); await wait(60);
  ok($('#nPreview').textContent === 'Alerts are off.', 'Off preset');
  click('#nPreset button[data-preset="All"]'); await wait(60);
  ok(Object.values(S().profile.notify).every(Boolean), 'All preset');
  click('[data-act="tab"][data-v="today"]'); await wait();
  ok(!$('#sumCard') && $('#addCard') && $('#prayCard'), 'Today stays a quick look (the morning summary is previewed in Settings)');
  click('[data-act="settings"]'); await wait();

  current = 'Profile settings';
  setVal('#pName', 'Pavi'); setVal('#pPhone', '07700 900999'); submit('#profForm'); await wait(60);
  ok(S().profile.name === 'Pavi' && store.docs.get('data/users/u_test/profile').phone === '07700 900999', 'name and number saved');

  current = 'QR code';
  click('[data-act="tab"][data-v="today"]'); await wait();
  ok(/Pavi/.test($('.h1').textContent), 'greeting uses your name');
  click('#fab'); await wait(); click('#sheet [data-act="qr"]'); await wait();
  ok(/wa\.me\/447700900999\?text=/.test($('#sheetBody').textContent) || $('#qrBox'), 'QR sheet built for your number');
  click('#sheet [data-act="closesheet"]'); await wait(400);

  current = 'PIN lock';
  click('[data-act="settings"]'); await wait();
  click('[data-act="setpin"]'); await wait();
  setVal('#pinNew', '12'); setVal('#pinNew2', '12'); submit('#pinForm'); await wait(40);
  ok(/4 to 8/.test($('#pinErr').textContent), 'short PIN rejected');
  setVal('#pinNew', '1234'); setVal('#pinNew2', '1235'); submit('#pinForm'); await wait(40);
  ok(/match/.test($('#pinErr').textContent), 'mismatch rejected');
  setVal('#pinNew2', '1234'); submit('#pinForm'); await wait(60);
  ok(S().profile.pinHash && S().profile.pinHash.length === 64, 'PIN saved as a hash');
  click('[data-act="locknow"]'); await wait();
  ok(!$('#lock').hidden, 'Lock now shows the lock screen');
  setVal('#lockPin', '9999'); submit('#lockForm'); await wait(40);
  ok(!$('#lock').hidden && /isn't right/.test($('#lockMsg').textContent), 'wrong PIN refused');
  setVal('#lockPin', '1234'); submit('#lockForm'); await wait(40);
  ok($('#lock').hidden, 'right PIN unlocks');

  current = 'Backup';
  click('[data-act="export"]'); await wait(40);
  ok(A.saves.length === 1 && /^shepherd-backup-\d{4}-\d{2}-\d{2}\.json$/.test(A.saves[0].filename), 'backup offered as a .json download');
  const bk = JSON.parse(A.saves[0].data);
  ok(bk.contacts.length === 2 && bk.profile.pinHash === '', 'backup has contacts and no PIN');
  bk.contacts.push({ id: 'restored1', name: 'From Backup', createdAt: Date.now(), updatedAt: Date.now(), status: 'active' });
  bk.contacts.push({ id: '../bad', name: 'Bad Id' });
  w.__shepherd.importBackup(JSON.stringify(bk)); await wait(60);
  ok(S().contacts.restored1 && !Object.values(S().contacts).some(x => x.name === 'Bad Id'), 'restore adds new contacts and skips unsafe ones');
  w.__shepherd.importBackup('not json'); await wait();
  ok(/isn't a Shepherd backup/.test($('#toastMsg').textContent), 'bad file rejected');

  current = 'Search and filters';
  click('[data-act="tab"][data-v="people"]'); await wait();
  ok($$('.filters').length === 1, 'only one filter row (groups removed)');
  setVal('#q', 'samsnap'); await wait();
  ok($$('#plist .prow').length === 1 && $('#plist').textContent.includes('Sam Test'), 'search finds by social handle');
  setVal('#q', 'zzz'); await wait();
  ok(/No one matches/.test($('#plist').textContent), 'no-match message');
  setVal('#q', ''); click('[data-act="filter"][data-f="ok"]'); await wait();
  ok($$('#plist .prow').every(r => r.classList.contains('st-ok')), 'On track filter');
  click('[data-act="filter"][data-f="all"]'); await wait();

  current = 'Week summary';
  click('[data-act="tab"][data-v="week"]'); await wait();
  ok(/You followed up with 1 of 3/.test($('.bigline').textContent), 'weekly line counts follow-ups (' + $('.bigline').textContent + ')');
  ok($$('.bar').length === 4 && $$('.bar .fill').every(f => /^\d+%$/.test(f.style.height)), 'four weekly bars drawn to scale');

  current = 'Examples (older accounts)';
  click('[data-act="tab"][data-v="today"]'); await wait();
  w.__shepherd.S.contacts = {};
  click('[data-act="tab"][data-v="today"]'); await wait();
  ok(!$('[data-act="examples"]') && !/example contacts/.test($('#main').textContent), 'no "try it with examples" button');
  const D = 864e5, now0 = Date.now(), td0 = new Date().toISOString().slice(0, 10);
  const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.getTime(); }; // calendar days, so a clock change can't shift the date
  const loc = new Date(); const tdLocal = loc.getFullYear() + '-' + String(loc.getMonth() + 1).padStart(2, '0') + '-' + String(loc.getDate()).padStart(2, '0');
  Object.assign(w.__shepherd.S.contacts, {
    ex1: { id: 'ex1', name: 'Daniel (example)', example: true, status: 'active', everyDays: 3, createdAt: now0 - 12 * D, lastContact: daysAgo(4), replyState: 'none', log: [] },
    ex2: { id: 'ex2', name: 'Grace (example)', example: true, status: 'active', everyDays: 2, createdAt: now0 - 12 * D, lastContact: daysAgo(2), replyState: 'me', log: [] },
    ex3: { id: 'ex3', name: 'Joel (example)', example: true, status: 'active', everyDays: 3, createdAt: now0 - 12 * D, lastContact: daysAgo(1), replyState: 'none', nextStudy: { date: tdLocal, time: '19:00', topic: 'First study' }, log: [] }
  });
  click('[data-act="tab"][data-v="today"]'); await wait();
  ok(Object.values(S().contacts).filter(x => x.example).length === 3, 'older example contacts still show');
  ok(/example contacts/.test($('#main').textContent), 'example banner shows');
  ok(/Studies today/.test($('#main').textContent) && /Reply to/.test($('#main').textContent), 'examples fill Today');
  const dg = w.__shepherd.digest();
  ok(/Reply to Grace/.test(dg) && /Studies today: Joel at 7pm/.test(dg) && /Message \d+ (person|people): Daniel \(1d overdue\)/.test(dg) && /Events: .*Sunday service tomorrow at 10:30am/.test(dg),'alert summary reads correctly: ' + dg.replace(/\n/g, ' | '));
  click('[data-act="settings"]'); await wait();
  click('[data-act="clearexamples"]'); await wait(60);
  ok(!Object.values(S().contacts).some(x => x.example), 'examples removed');

  current = 'Your number is kept';
  click('[data-act="settings"]'); await wait();
  click('[data-act="tour"]'); await wait(40); click('#tourNext'); await wait(30);
  click('#tourMore'); await wait(60);
  setVal('#pPhone', '07585 524965');
  click('#tourPillGo'); await wait(60);
  ok(S().profile.phone === '07585 524965' && store.docs.get('data/users/u_test/profile').phone === '07585 524965', 'number typed then Continue tour (no Save) is saved');
  click('#tourSkip'); await wait(40);
  click('[data-act="tab"][data-v="today"]'); await wait(); click('[data-act="settings"]'); await wait();
  ok($('#pPhone').value === '07585 524965', 'still there after the tour and leaving Settings');
  setVal('#pIntro', 'Hello from the test'); $('#pIntro').dispatchEvent(new w.Event('change', { bubbles: true })); await wait(60);
  ok(store.docs.get('data/users/u_test/profile').intro === 'Hello from the test', 'leaving a box saves it too');
  setVal('#pName', 'Typed Not Saved'); click('[data-act="tab"][data-v="people"]'); await wait(60);
  ok(S().profile.name === 'Typed Not Saved', 'going to another tab keeps what was typed');
  click('[data-act="settings"]'); await wait(); setVal('#pName', 'Pavi'); submit('#profForm'); await wait(60);

  current = 'Tour jobs carry on by themselves';
  click('[data-act="settings"]'); await wait();
  click('[data-act="tour"]'); await wait(40);
  for (let i = 0; i < 3; i++) { click('#tourNext'); await wait(30); }
  ok($('#tourTitle').textContent === 'Add someone' && $('#tourMore').textContent === 'Add my first person', 'Add someone step');
  click('#tourMore'); await wait(60);
  ok($('#sheetTitle').textContent === 'Add a contact' && $('#tour').hidden, 'opens Add a contact for you');
  setVal('#cName', 'Tour Tess'); submit('#cForm'); await wait(1300);
  ok(Object.values(S().contacts).some(x => x.name === 'Tour Tess') && !$('#tour').hidden && $('#tourTitle').textContent === 'Or show your QR code', 'after saving, the tour carries on');
  for (let i = 0; i < 6; i++) { click('#tourNext'); await wait(30); }
  click('#tourMore'); await wait(40);
  ok(!$('#tourPill').hidden, 'Continue tour bar while adding a disciple');
  setVal('#dName', 'Tour Dee'); submit('#dForm'); await wait(1300);
  ok(Object.values(S().disciples).some(x => x.name === 'Tour Dee') && $('#tourTitle').textContent === 'Pray for people', 'after adding a disciple, the tour carries on');
  click('#tourBack'); await wait(30); click('#tourMore'); await wait(40);
  click('#tourPillGo'); await wait(40);
  ok($('#tourTitle').textContent === 'Pray for people', 'Continue tour moves on even without finishing the job');
  click('#tourSkip'); await wait(40);
  ok($('#tour').hidden && $('#tourPill').hidden, 'Skip ends the tour');

  current = 'Safety';
  // restore real contacts into view from store
  A.dom.window.close();
  A = await open(store); await wait(80);
  ok(Object.values(A.S().contacts).some(x => x.name === 'Sam Test'), 'data still there after reopening the app');
  ok(Object.values(A.S().events).some(x => x.name === 'Sunday service'), 'events still there after reopening');
  ok(A.$('#lock').hidden === false, 'PIN asked for on reopen');
  await wait(400);
  ok(A.$('#tour').hidden, 'tour does not show again once done');
  A.setVal('#lockPin', '1234'); A.submit('#lockForm'); await wait(40);
  A.click('#fab'); await wait();
  A.setVal('#cName', '<img src=x onerror="window.__x=1">'); A.submit('#cForm'); await wait(60);
  A.click('[data-act="tab"][data-v="people"]'); await wait();
  ok(!A.$('#main img') && !A.w.__x && A.$('#main').textContent.includes('<img src=x'), 'names are shown as text, never run as code');

  current = 'Offline and saving';
  store.fail = 'unavailable';
  A.click('#fab'); await wait();
  A.setVal('#cName', 'Offline Olive'); A.submit('#cForm'); await wait(80);
  ok(Object.keys(A.w.__shepherd.pending()).length >= 1, 'change queued while offline');
  ok(/Offline/.test(A.$('#sync').textContent), 'status shows Offline · will sync');
  ok(!contactDocs(store).some(x => x.name === 'Offline Olive'), 'not in the store yet');
  ok(Object.values(JSON.parse(A.w.localStorage.getItem('shepherd:v1:u_test')).contacts).some(x => x.name === 'Offline Olive'), 'kept on the phone meanwhile');
  store.fail = null; A.w.dispatchEvent(new A.w.Event('online')); await wait(150);
  ok(contactDocs(store).some(x => x.name === 'Offline Olive') && Object.keys(A.w.__shepherd.pending()).length === 0, 'syncs when back online');
  ok(A.$('#sync').textContent.trim() === 'Saved', 'status back to Saved');

  current = 'Delete all data';
  const olive = Object.values(A.S().contacts).find(x => x.name === 'Offline Olive');
  A.w.__shepherd.S.view = 'contact'; A.w.__shepherd.S.contactId = olive.id; A.click('[data-act="tab"][data-v="people"]'); await wait();
  A.click(A.$$('.prow-main').find(b => b.textContent.includes('Offline Olive'))); await wait(150);
  A.click('[data-act="archive"]'); await wait(); A.click('#aWhy button[data-v="Asked us not to contact them"]'); A.click('#aGo'); await wait(60);
  A.click('[data-act="archive-list"]'); await wait();
  A.click(A.$$('.prow-main').find(b => b.textContent.includes('Offline Olive'))); await wait();
  A.click('[data-act="delete"]'); await wait();
  ok(A.$('#dGo').disabled, 'delete button locked until DELETE typed');
  A.setVal('#dConfirm', 'delete'); await wait();
  ok(!A.$('#dGo').disabled, 'unlocks after typing DELETE');
  A.click('#dGo'); await wait(80);
  ok(!contactDocs(store).some(x => x.name === 'Offline Olive') && !A.S().contacts[olive.id], 'contact deleted everywhere');
  ok(/Deleted a contact at their request/.test(JSON.stringify(store.docs.get('data/users/u_test/profile').log)), 'deletion noted in activity log without their name');

  current = 'Read-only access';
  store.fail = 'invalid_argument';
  A.click('#fab'); await wait(); A.setVal('#cName', 'Viewer Vic'); A.submit('#cForm'); await wait(80);
  A.click('[data-act="tab"][data-v="today"]'); await wait();
  ok(/Contributor/.test(A.$('#main').textContent) && /Saved on this device/.test(A.$('#sync').textContent), 'explains how to get save access');
  store.fail = null;

  current = 'No capabilities (preview mode)';
  const B = await open(null); await wait(60);
  ok(B.$('.empty') && /On this device/.test(B.$('#sync').textContent), 'works on the phone alone when saving online is unavailable');
  B.click('#fab'); await wait(); B.setVal('#cName', 'Local Lou'); B.submit('#cForm'); await wait(60);
  ok(Object.values(B.S().contacts).some(x => x.name === 'Local Lou'), 'can still add contacts');
  B.click('[data-act="settings"]'); await wait(); B.click('[data-act="notifguide"]'); await wait(60);
  ok(/Get the Shepherd app/.test(B.$('#sheetBody').textContent) && !/Claude/.test(B.$('#sheetBody').textContent), 'church members are pointed to the Shepherd app for notifications');

  current = 'Notification schedule';
  {
    const W = A.w.__shepherd, S0 = W.S;
    const saved = { c: S0.contacts, d: S0.disciples, e: S0.events, p: S0.profile };
    const day = 864e5, t0 = new Date(); t0.setHours(0, 0, 0, 0); const T = t0.getTime();
    const at = (k, h) => { const d = new Date(T); d.setDate(d.getDate() + k); d.setHours(h || 0, 0, 0, 0); return d.getTime(); };
    const ymdF = t => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    S0.contacts = {
      a: { id: 'a', name: 'Daniel Mensah', lastContact: at(-5, 12), everyDays: 3, createdAt: at(-10) },
      b: { id: 'b', name: 'Grace Owusu', replyState: 'me', meSince: at(-1, 12), lastContact: at(-1, 12), everyDays: 3, createdAt: at(-10) },
      c: { id: 'c', name: 'Sam Lee', replyState: 'them', waitingSince: at(-2, 12), lastContact: at(-2, 12), everyDays: 7, createdAt: at(-10) },
      d: { id: 'd', name: 'Pete Paused', status: 'paused', pauseUntil: ymdF(at(3)), pausedAt: at(-1), lastContact: at(-20), createdAt: at(-30) },
      e: { id: 'e', name: 'Gary Gone', status: 'archived', createdAt: at(-30) },
      f: { id: 'f', name: 'Joel Study', lastContact: at(0, 1), everyDays: 3, createdAt: at(-10), nextStudy: { date: ymdF(at(1)), time: '19:00', topic: 'Prayer' } }
    };
    S0.disciples = { x: { id: 'x', name: 'Ama Boateng', lastCheck: 0 } };
    S0.events = { v: { id: 'v', name: 'Sunday service', date: ymdF(at(2)), time: '10:30', place: 'Main hall' } };
    S0.profile = Object.assign({}, S0.profile, { alertTime: '08:00', notify: { chase: true, replies: true, catchup: true, disciples: true, studies: true, events: true, weekly: true } });
    let items = W.buildSchedule();
    const on = k => items.filter(x => ymdF(x.at) === ymdF(at(k)));
    const tm = on(1).map(x => x.title);
    ok(tm.includes('Reply to Grace') && tm.includes('Message Daniel') && tm.includes('Did Sam reply?'), 'tomorrow morning names Grace, Daniel and Sam');
    const dan = on(1).find(x => x.title === 'Message Daniel');
    ok(dan && /^3 days overdue/.test(dan.body) && dan.url === './?open=a' && new Date(dan.at).getHours() === 8, 'Daniel: 3 days overdue, at 8am, opens Daniel');
    ok(on(1).find(x => x.title === 'Reply to Grace').body === 'Grace messaged you 2 days ago. Tap to reply.', 'Grace: how long she has waited');
    ok(!items.some(x => /Gary/.test(x.title)), 'people you no longer contact never get notifications');
    ok(!on(1).some(x => /Pete/.test(x.title)) && on(3).some(x => x.title === 'Message Pete' && /Back from a pause/.test(x.body)), 'a paused person comes back on the day the pause ends');
    const st = items.find(x => x.title === 'Bible study with Joel at 7pm');
    ok(st && ymdF(st.at) === ymdF(at(1)) && new Date(st.at).getHours() === 18 && st.body === 'In one hour.' && !/Prayer/.test(st.title + st.body) && st.url === './?open=f', 'study reminder an hour before, without the study topic (names only on a lock screen)');
    ok(items.some(x => x.title === 'Tomorrow: Sunday service' && ymdF(x.at) === ymdF(at(1)) && /10:30am · Main hall/.test(x.body)) && items.some(x => x.title === 'Sunday service at 10:30am' && new Date(x.at).getHours() === 9), 'event: the day before, and an hour before');
    const disc = items.filter(x => x.title === 'Check in with Ama');
    ok(disc.length >= 2 && disc.every(x => [1, 4].includes(new Date(x.at).getDay())), 'disciples: Monday and Thursday until checked in');
    ok(items.every(x => x.at > Date.now()) && !items.some(x => /Mensah|Owusu|Boateng/.test(x.title + x.body)), 'nothing in the past, and first names only');
    ok(new Set(items.map(x => x.tag)).size === items.length, 'every notification is its own (no two share a tag)');
    ok(on(1).find(x => x.title === 'Message Daniel').badge === 2, 'app badge counts replies owed and people to message');
    S0.profile.notify = Object.assign({}, S0.profile.notify, { replies: false, studies: false });
    items = W.buildSchedule();
    ok(!items.some(x => /^Reply to|^Bible study/.test(x.title)) && items.some(x => x.title === 'Message Daniel'), 'tickboxes in Settings turn kinds of notification off');
    for (let i = 0; i < 12; i++) S0.contacts['z' + i] = { id: 'z' + i, name: 'Person' + i + ' X', lastContact: at(-9), everyDays: 3, createdAt: at(-20) };
    items = W.buildSchedule();
    const m1 = on(1).filter(x => new Date(x.at).getHours() === 8);
    const more = m1.find(x => /^And \d+ more today$/.test(x.title));
    ok(m1.filter(x => /^(Message|Did|Reply|Check)/.test(x.title)).length === 8 && more && /Message Person/.test(more.body), 'at most 8 named alerts each morning, then one "and N more" naming the rest');
    S0.contacts = saved.c; S0.disciples = saved.d; S0.events = saved.e; S0.profile = saved.p;
  }

  current = 'Journey';
  {
    const W = A.w.__shepherd, S0 = W.S;
    S0.readonly = false; // the read-only check above left this phone read-only
    A.click('[data-act="tab"][data-v="people"]'); await wait();
    A.click('[data-act="pmode"][data-m="journey"]'); await wait();
    const cols = A.$$('.jcol');
    ok(cols.length === 6 && cols.map(c => c.querySelector('h2').textContent).join('|') === 'First contact|Interested|Studying|Regular at church|Baptised|Disciple', 'six stages, Regular at church between Studying and Baptised');
    const sumTotal = A.$$('.jsum-i b').reduce((n, b) => n + Number(b.textContent), 0);
    ok(sumTotal === Object.values(S0.contacts).filter(c => c.name && W.state(c) !== 'archived').length, 'stage counts add up to everyone not archived');
    const card = A.$$('.jcol')[0].querySelector('.jcard');
    const cid = card.querySelector('[data-act="open"]').dataset.id;
    A.click(card.querySelector('[data-act="stage"]:not([aria-label])')); await wait();
    ok(S0.contacts[cid].stage === 'Interested' && /moved to Interested/.test(A.$('#toastMsg').textContent), 'one tap moves someone to the next stage');
    await wait(120); ok(store.docs.get('data/users/u_test/profile/contacts/' + cid).stage === 'Interested', 'the move is saved');
    const back = A.$$('.jcol')[1].querySelector('[data-act="stage"][aria-label^="Move back"]');
    A.click(back); await wait();
    ok(S0.contacts[cid].stage === 'First contact', 'and back again');
    S0.contacts[cid].stage = 'Baptised'; A.click('[data-act="pmode"][data-m="journey"]'); await wait();
    const bc = A.$$('.jcol')[4].querySelector('[data-act="stage"]:not([aria-label])'); A.click(bc); await wait();
    ok(S0.contacts[cid].stage === 'Disciple' && !Object.values(S0.disciples).some(d => d.name === S0.contacts[cid].name && d.createdAt > Date.now() - 5000), 'moving to Disciple does not add them to the Disciples tab');
    A.click('[data-act="open"][data-id="' + cid + '"]'); await wait();
    ok(A.$$('.jstep').length === 6 && A.$('.jstep.now').textContent === 'Disciple', 'contact page shows where they are on the journey');
    A.click(A.$$('.jstep')[2]); await wait();
    ok(S0.contacts[cid].stage === 'Studying' && /Stage changed to Studying/.test(JSON.stringify(S0.contacts[cid].log)), 'tapping a stage sets it and logs it');
    A.click('[data-act="tab"][data-v="people"]'); await wait(); A.click('[data-act="pmode"][data-m="list"]'); await wait();
    ok(A.$('#q'), 'List view is back');
  }

  current = 'Prayer list';
  {
    const W = A.w.__shepherd, S0 = W.S;
    A.click('[data-act="tab"][data-v="today"]'); await wait();
    ok(A.$('#prayCard'), 'Today has a Pray today card');
    A.click('#prayCard [data-act="praylist"]'); await wait();
    ok(A.$('#sheetTitle').textContent === 'Prayer list', 'prayer list opens');
    A.submit('#prForm'); await wait();
    ok(!A.$('#prErr').hidden, 'needs a name');
    for (const [n, notes] of [['Grace Owusu', 'Exams this week'], ['Uncle Kofi', ''], ['Ama', 'Healing'], ['Joel', 'New job']]) { A.setVal('#prName', n); A.setVal('#prNotes', notes); A.submit('#prForm'); await wait(40); }
    const pr = Object.values(S0.prayers);
    ok(pr.length === 4 && pr.some(x => x.name === 'Uncle Kofi' && x.notes === ''), 'names with optional notes are added');
    await wait(150); ok([...store.docs.keys()].filter(k => k.startsWith('data/users/u_test/profile/prayers/')).length === 4, 'saved to your own space');
    A.click('#sheet [data-act="closesheet"]'); await wait(400);
    A.click('[data-act="tab"][data-v="today"]'); await wait();
    ok(A.$$('#prayCard li').length === 3, 'three people to pray for today');
    A.click('[data-act="settings"]'); await wait();
    const cnt = A.$('#pPrCount'); cnt.value = '2'; cnt.dispatchEvent(new A.w.Event('change', { bubbles: true })); await wait();
    A.click('[data-act="tab"][data-v="today"]'); await wait();
    ok(A.$$('#prayCard li').length === 2, 'can choose two a day');
    // taking turns over the days
    const W2 = A.w.__shepherd;
    A.click('[data-act="settings"]'); await wait();
    const on = A.$('#pPrOn'); on.checked = true; on.dispatchEvent(new A.w.Event('change', { bubbles: true })); await wait();
    const t = A.$('#pPrTime'); t.value = '21:15'; t.dispatchEvent(new A.w.Event('change', { bubbles: true })); await wait();
    ok(S0.profile.prayerOn === true && S0.profile.prayerTime === '21:15', 'prayer reminders switched on, at a chosen time');
    const items = W2.buildSchedule().filter(x => x.tag.startsWith('pr-'));
    ok(items.length >= 13 && items.every(x => new Date(x.at).getHours() === 21 && new Date(x.at).getMinutes() === 15), 'a prayer reminder every day at that time');
    ok(/^Pray for \S+ and \S+$/.test(items[1].title) && items[1].body.length > 0, 'it names who to pray for: ' + items[1].title);
    const seen = new Set(items.slice(0, 4).flatMap(x => x.title.replace('Pray for ', '').split(' and ')));
    ok(seen.size === 4, 'everyone gets prayed for, taking turns');
    {
      const opts = A.$$('#pPrCount option').map(o => o.value).join(',');
      ok(opts === Array.from({ length: 15 }, (_, i) => i + 1).join(','), 'you can choose anywhere from 1 to 15 people a day');
      for (let i = 0; i < 10; i++) { const id = 'pbulk' + i; S0.prayers[id] = { id, name: 'Bulk ' + i + ' Person', notes: '', createdAt: Date.now() + i }; }
      const c2 = A.$('#pPrCount'); c2.value = '12'; c2.dispatchEvent(new A.w.Event('change', { bubbles: true })); await wait();
      ok(S0.profile.prayerCount === 12, 'the choice is saved');
      const big = W2.buildSchedule().filter(x => x.tag.startsWith('pr-'));
      ok(/^Pray for \S+, \S+ and 10 more$/.test(big[0].title), 'a long list keeps the notification title short: ' + big[0].title);
      A.click('[data-act="tab"][data-v="today"]'); await wait();
      ok(A.$$('#prayCard li').length === 12, 'Today shows all 12');
      const c1 = (A.click('[data-act="settings"]'), await wait(), A.$('#pPrCount')); c1.value = '1'; c1.dispatchEvent(new A.w.Event('change', { bubbles: true })); await wait();
      A.click('[data-act="tab"][data-v="today"]'); await wait();
      ok(A.$$('#prayCard li').length === 1, 'or just one a day');
      for (let i = 0; i < 10; i++) delete S0.prayers['pbulk' + i];
      const c3 = (A.click('[data-act="settings"]'), await wait(), A.$('#pPrCount')); c3.value = '2'; c3.dispatchEvent(new A.w.Event('change', { bubbles: true })); await wait();
    }
    on.checked = false; on.dispatchEvent(new A.w.Event('change', { bubbles: true })); await wait();
    ok(!W2.buildSchedule().some(x => x.tag.startsWith('pr-')), 'switching them off stops them');
    // add from a contact
    const someone = Object.values(S0.contacts).find(c => c.name && W.state(c) !== 'archived');
    A.click('[data-act="tab"][data-v="people"]'); await wait(); A.click('[data-act="open"][data-id="' + someone.id + '"]'); await wait();
    A.click('[data-act="addpray"]'); await wait();
    ok(Object.values(S0.prayers).some(x => x.contactId === someone.id), 'a contact can be added to the prayer list');
    A.click('[data-act="addpray"]'); await wait();
    ok(Object.values(S0.prayers).filter(x => x.contactId === someone.id).length === 1 && /already/.test(A.$('#toastMsg').textContent), 'not added twice');
    // edit and remove
    A.click('[data-act="tab"][data-v="today"]'); await wait(); A.click('#prayCard [data-act="praylist"]'); await wait();
    const kofi = Object.values(S0.prayers).find(x => x.name === 'Uncle Kofi');
    A.click('[data-act="editprayer"][data-id="' + kofi.id + '"]'); await wait();
    A.setVal('#peNotes', 'Back pain'); A.submit('#pe'); await wait(40);
    ok(S0.prayers[kofi.id].notes === 'Back pain', 'notes can be edited');
    A.click('[data-act="editprayer"][data-id="' + kofi.id + '"]'); await wait(); A.click('#peDel'); await wait(40);
    ok(!S0.prayers[kofi.id], 'removed from the prayer list');
    A.click('#sheet [data-act="closesheet"]'); await wait(400);
  }

  current = 'Phone contacts';
  {
    const W = A.w.__shepherd;
    const vcf = 'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Mensah;Daniel;;;\r\nFN:Daniel Mensah\r\nTEL;TYPE=CELL:07700 900111\r\nTEL;TYPE=HOME:020 7946 0000\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:2.1\r\nN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Nowak;Zofia;;;\r\nFN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Zofia =C5=81=\r\nukasz\r\nTEL;CELL:+48 600 100 200\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nN:Owusu;Grace;;;\r\nTEL:+447700900222\r\nitem1.TEL:07700 900333\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:4.0\r\nFN:Chidi O\r\n kafor\r\nTEL;VALUE=uri:tel:+234-803-000-0000\r\nEND:VCARD\r\n';
    const got = W.parseVCF(vcf);
    ok(got.length === 4, 'reads four contacts from a contacts file');
    ok(got[0].n === 'Daniel Mensah' && got[0].p.length === 2, 'names and every number');
    ok(got[1].n === 'Zofia Łukasz' && got[1].p[0] === '+48 600 100 200', 'older Android files with accents (quoted-printable) read correctly');
    ok(got[2].n === 'Grace Owusu' && got[2].p.length === 2, 'falls back to the N field when there is no FN, and grouped numbers');
    ok(got[3].n === 'Chidi Okafor' && got[3].p[0] === '+234-803-000-0000', 'folded lines and tel: links');
    ok(W.mergePhoneBook(got) === 4 && W.mergePhoneBook(got) === 0, 'importing twice adds nothing twice');
    ok(!contactDocs(store).some(x => /Zofia/.test(x.name)) && ![...store.docs.values()].some(d => /Zofia/.test(JSON.stringify(d))), 'imported phone contacts are never uploaded');
    A.click('#fab'); await wait();
    A.setVal('#cName', 'zof'); A.$('#cName').dispatchEvent(new A.w.Event('input', { bubbles: true })); await wait();
    ok(!A.$('#cSug').hidden && /Zofia Łukasz/.test(A.$('#cSug').textContent), 'typing shows matching phone contacts');
    A.setVal('#cName', 'gr'); A.$('#cName').dispatchEvent(new A.w.Event('input', { bubbles: true })); await wait();
    const opts = A.$$('#cSug button');
    ok(opts.length === 2 && /07700 900333/.test(opts[1].textContent), 'each of their numbers is offered');
    A.click(opts[1]); await wait();
    ok(A.$('#cName').value === 'Grace Owusu' && A.$('#cPhone').value === '07700 900333' && A.$('#cSug').hidden, 'picking one fills in the name and number');
    A.setVal('#cName', 'xyz'); A.$('#cName').dispatchEvent(new A.w.Event('input', { bubbles: true })); await wait();
    ok(A.$('#cSug').hidden, 'no matches, no list');
    A.click('#sheet [data-act="closesheet"]'); await wait(400);
    A.click('[data-act="settings"]'); await wait();
    ok(/4 contacts on this phone/.test(A.$('#pbCard').textContent) && A.$('#pbFile'), 'Settings shows how many are on this phone, with an import button');
    A.click('[data-act="pbhow"]'); await wait();
    ok(A.$$('#sheetBody .osb').length === 2 && /Export/.test(A.$('#sheetBody').textContent), 'how to get a contacts file, on iPhone and Android');
    A.click('#sheet [data-act="closesheet"]'); await wait(400);
    A.click('[data-act="pbclear"]'); await wait();
    ok(!/contacts on this phone/.test(A.$('#pbCard').textContent), 'can remove them from this phone');
    const card = W.vcard({ name: 'Sam Lee', phone: '07700 900123', instagram: 'sam.t' });
    ok(/FN:Sam Lee/.test(card) && /TEL;TYPE=CELL:\+447700900123/.test(card) && /instagram\.com\/sam\.t/.test(card) && W.parseVCF(card)[0].n === 'Sam Lee', 'save-to-phone makes a proper contact card');
  }

  current = 'QR code and your data';
  {
    const W = A.w.__shepherd;
    ok(W.S.profile.intro === 'Hi, nice to meet you, I got your contact from Shepherd! Hoping to hear from you soon.' || W.S.profile.intro !== "Hi! It was great meeting you today. Here's my number so we can keep in touch about studying the Bible.", 'the old default message becomes the new short one');
    A.click('[data-act="settings"]'); await wait();
    A.click('[data-act="yourdata"]'); await wait();
    const yd = A.$('#sheetBody').textContent;
    ok(/Data linked to you/.test(yd) && /Kept only on this phone/.test(yd) && /Never collected/.test(yd) && /location/.test(yd), 'Your data explains what is saved, where, and what is never collected');
    ok(A.$('#sheetTitle').textContent === 'Privacy and safe use' && A.$$('#sheetBody .pv h3').map(h => h.textContent).join('|') === "Who is responsible|Your responsibility|Acceptable use|What Shepherd keeps, and why|How it's protected|Keep your phone safe|How long it's kept, and your choices", 'the privacy notice has every section the data protection team asked for');
    ok(/run by Pavi/.test(yd) && /data controller/.test(yd), 'names Pavi as responsible for it');
    ok(/email 8pavii@gmail\.com/.test(yd) && !/through your church/.test(yd), 'gives the email to write to about privacy');
    ok(/isn't a church database or a marketing tool/.test(yd) && /You are responsible for the people you contact/.test(yd), 'puts personal responsibility first, not church marketing');
    ok(/passcode/.test(yd) && /App lock/.test(yd) && /up to date/.test(yd), 'tells people to lock their phone, use the PIN and keep Shepherd updated');
    ok(/encrypted/.test(yd) && /scrambled/.test(yd) && /never sends messages for you/.test(yd), 'explains how the information is protected');
    A.click('#sheet [data-act="closesheet"]'); await wait(400);
  }

  current = 'Languages';
  {
    const st = makeStore();
    const t0 = Date.now() - 3 * 864e5;
    st.docs.set('data/users/u_test/profile', { name: 'Pavi Mensah', phone: '07700 900123', tourDone: true, lang: 'es', notify: { chase: true, replies: true, catchup: true, disciples: true, studies: true, events: true, weekly: true } });
    st.docs.set('data/users/u_test/profile/contacts/k1', { id: 'k1', name: 'Kofi Boateng', phone: '07700 900555', status: 'active', stage: 'Studying', everyDays: 3, lastContact: t0, replyState: '', createdAt: t0, updatedAt: t0, studies: [], log: [] });
    st.docs.set('data/users/u_test/profile/contacts/k2', { id: 'k2', name: 'Efua Asante', phone: '07700 900556', status: 'active', stage: 'First contact', everyDays: 3, replyState: 'me', meSince: t0, createdAt: t0, updatedAt: t0, studies: [], log: [] });
    st.docs.set('data/users/u_test/profile/events/v1', { id: 'v1', name: 'Sunday service', date: ymd(Date.now() + 864e5), time: '10:30', place: 'Main hall', invited: [], came: [] });
    const E = await open(st, { localStorage: { 'shepherd:lang': 'es' } }); await wait(200);
    const tabs = E.$$('.tab').map(t => t.textContent.trim());
    ok(/^Hoy\d*\|Personas\|Discípulos\|Calendario\|Semana/.test(tabs.join('|')), 'the tabs are in Spanish: ' + tabs.join(', '));
    ok(E.d.documentElement.lang === 'es', 'the page says it is in Spanish');
    ok(/Buen(os|as) (días|tardes|noches), Pavi/.test(E.$('.h1').textContent), 'greeting in Spanish, name untouched');
    ok(/^(lunes|martes|miércoles|jueves|viernes|sábado|domingo)/.test(E.$('.eyebrow').textContent), 'today\'s date written the Spanish way: ' + E.$('.eyebrow').textContent);
    ok(/Responder a Efua/.test(E.$('#main').textContent) || /Responder a/.test(E.$('#main').textContent), 'lists use Spanish headings');
    ok(!/[A-Za-z]+ (to message|reply owed|Overdue by)/.test(E.$('#main').textContent), 'no English left in the Today counts');
    const sched = E.w.__shepherd.buildSchedule();
    ok(sched.some(x => x.title === 'Responder a Efua') && sched.some(x => x.title === 'Mañana: Culto del domingo' || x.title === 'Culto del domingo a las 10:30'), 'notifications are in Spanish too: ' + [...new Set(sched.map(x => x.title))].slice(0, 6).join(' | '));
    ok(sched.every(x => !/^(Reply to|Message|Did|Tomorrow:)/.test(x.title)), 'no English notification titles');
    E.click('[data-act="tab"][data-v="disciples"]'); await wait();
    ok(/Therefore encourage one another/.test(E.$('.verse').textContent) && /NIV/.test(E.$('.verse cite').textContent), 'the Bible verse stays in English (NIV)');
    E.click('[data-act="tab"][data-v="people"]'); await wait();
    E.click('[data-act="open"][data-id="k1"]'); await wait();
    ok(E.$('.h1').textContent.includes('Kofi Boateng') && E.$$('.jstep').map(x => x.textContent).join('|') === 'Primer contacto|Interesado|Estudiando|Asiste a la iglesia|Bautizado|Discípulo', 'journey stages in Spanish');
    E.click('[data-act="tab"][data-v="events"]'); await wait();
    E.click('[data-act="openevent"][data-id="v1"]'); await wait();
    const inv = E.w.__shepherd.inviteText ? E.w.__shepherd.inviteText(E.S().events.v1, E.S().contacts.k1) : '';
    ok(/^¡Hola, Kofi! ¿Te gustaría venir a Sunday service mañana a las 10:30/.test(inv), 'invites are written in Spanish: ' + inv);
    E.click('#sheet [data-act="closesheet"]'); await wait(400);
    E.click('[data-act="settings"]'); await wait();
    const sel = E.$('#pLang');
    ok(sel && sel.options.length === 15 && sel.value === 'es' && [...sel.options].map(o => o.textContent).includes('English') && [...sel.options].map(o => o.value).join(',') === 'en,es,fr,pt,nl,pl,pcm,yo,ig,zh-Hans,zh-Hant,ja,de,ru,lt', 'Settings has the language list, each in its own language');
    ok(![...sel.options].some(o => o.value === 'ur'), 'no Urdu');
    ok(/NIV/.test(E.$('#langCard').textContent) && /inglés/.test(E.$('#langCard').textContent), 'says Bible verses stay in English');
    ok(E.$('#pIntro').value === '¡Hola, encantado de conocerte! Conseguí tu contacto con Shepherd. Espero saber de ti pronto.', 'the QR message is shown in Spanish');
      }

  current = 'Launch fixes';
  {
    const st = makeStore();
    st.docs.set('data/users/u_test/profile', { name: 'Fix Tester', agreed: { v: 1, at: 1 }, tourDone: true, phone: '07700900123' });
    const X = await open(st); await wait(300);
    const XS = () => X.w.__shepherd.S, W = X.w.__shepherd;
    const appSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'app.html'), 'utf8');
    const addPerson = async (name, phone, tick) => { X.click('[data-act="tab"][data-v="people"]'); await wait(); X.click('#fab'); await wait(); X.setVal('#cName', name); if (phone) X.setVal('#cPhone', phone); X.consent.auto = tick !== false; X.submit('#cForm'); X.consent.auto = true; await wait(60); };

    await (async () => {
      // 9: consent is required when adding by hand, and older contacts without it are flagged
      await addPerson('No Tick', '', false);
      ok(!Object.values(XS().contacts).some(c => c.name === 'No Tick') && /Tick that they're happy/.test(X.$('#cErr').textContent), '9: can\'t add someone without ticking that they agreed');
      X.click('#sheet [data-act="closesheet"]'); await wait(400);
      XS().contacts.old1 = { id: 'old1', name: 'Old Olu', status: 'active', everyDays: 3, createdAt: Date.now() - 9e8, replyState: 'none', log: [], consent: false };
      X.click('[data-act="tab"][data-v="people"]'); await wait(); X.click('[data-act="open"][data-id="old1"]'); await wait();
      ok(X.$('#consentNote') && /Consent not recorded/.test(X.$('#consentNote').textContent), '9: a contact saved without consent shows "Consent not recorded"');
    })().catch(e => ok(false, '9: consent is required when adding by hand, and older contac — crashed: ' + e.message));
    await (async () => {
      // 18: tapping Save twice quickly adds them once
      X.click('[data-act="tab"][data-v="people"]'); await wait(); X.click('#fab'); await wait();
      X.setVal('#cName', 'Twice Tapped'); X.consent.auto = true; X.submit('#cForm'); X.submit('#cForm'); await wait(80);
      ok(Object.values(XS().contacts).filter(c => c.name === 'Twice Tapped').length === 1, '18: a double tap on Save adds the person once');
    })().catch(e => ok(false, '18: tapping Save twice quickly adds them once — crashed: ' + e.message));
    await (async () => {
      // 19: sensible lengths
      X.click('#fab'); await wait();
      ok(X.$('#cName').maxLength === 80 && X.$('#cNotes').maxLength === 4000 && X.$('#cPhone').maxLength === 30, '19: name, notes and number have length limits');
      X.click('#sheet [data-act="closesheet"]'); await wait(400);
    })().catch(e => ok(false, '19: sensible lengths — crashed: ' + e.message));
    await (async () => {
      // 1 + 23: deleting someone takes them off the prayer list too, and an old backup can't bring them back
      await addPerson('Rita Remove', '07700900555');
      const rita = Object.values(XS().contacts).find(c => c.name === 'Rita Remove');
      const backup = W.backupText();
      X.click('[data-act="tab"][data-v="people"]'); await wait(); X.click('[data-act="open"][data-id="' + rita.id + '"]'); await wait();
      X.click('[data-act="addpray"]'); await wait(60);
      XS().prayers.same = { id: 'same', name: 'rita remove', notes: 'Knee surgery', createdAt: 2 };
      ok(Object.values(XS().prayers).filter(x => /rita/i.test(x.name)).length === 2, 'set-up: Rita is on the prayer list twice');
      X.click('[data-act="archive"]'); await wait(); X.click('#sheet .pick button'); await wait();
      X.$('#sheet form') && X.submit('#sheet form'); await wait(80);
      XS().contacts[rita.id].status = 'archived';
      X.click('[data-act="tab"][data-v="people"]'); await wait(); X.click('[data-act="archive-list"]'); await wait(); X.click('[data-act="open"][data-id="' + rita.id + '"]'); await wait();
      X.click('[data-act="delete"]'); await wait(); X.setVal('#dConfirm', 'DELETE'); X.click('#dGo'); await wait(120);
      ok(!XS().contacts[rita.id] && !Object.values(XS().prayers).some(x => /rita/i.test(x.name)), '1: "Delete all their data" removes them from the prayer list too');
      ok([...st.docs.entries()].every(([k, v]) => !JSON.stringify(v).includes('Rita Remove') || k === 'data/users/u_test/profile'), '1: nothing about Rita is left saved, apart from the deleted-ids list');
      W.importBackup(backup); await wait(80);
      ok(!XS().contacts[rita.id] && /stayed deleted/.test(X.$('#toast').textContent), '23: restoring an older backup doesn\'t bring back someone deleted at their request');
      ok(!/email it to yourself/.test(X.d.documentElement.innerHTML.replace(/<script[\s\S]*?<\/script>/g, '')) && !/email it to yourself/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'app.html'), 'utf8')), '23: the backup message no longer suggests emailing it');
    })().catch(e => ok(false, '1 + 23: deleting someone takes them off the prayer list too, — crashed: ' + e.message));
    await (async () => {
      // 2: notifications show names only
      const t0 = Date.now(), tdy = addDays(1);
      XS().contacts.kofi = { id: 'kofi', name: 'Kofi Boateng', status: 'active', everyDays: 3, createdAt: t0 - 9e8, lastContact: t0 - 5 * 864e5, replyState: 'none', log: [], consent: true, nextStudy: { date: tdy, time: '19:00', topic: 'Struggling with addiction' } };
      XS().prayers.g = { id: 'g', name: 'Grace Owusu', notes: 'Chemo results on Friday', createdAt: 1 };
      XS().profile.prayerOn = true;
      const sch = W.buildSchedule().map(x => x.title + ' | ' + x.body).join('\n');
      ok(/Pray for/.test(sch) && /Bible study with Kofi/.test(sch) && !/Chemo|addiction/.test(sch), '2: notifications name people but never show prayer notes or study topics');
      XS().profile.prayerOn = false; delete XS().contacts.kofi; delete XS().prayers.g;
    })().catch(e => ok(false, '2: notifications show names only — crashed: ' + e.message));
    await (async () => {
      // 8: phone numbers and home country
      const gb = W.COUNTRIES[0], ng = W.COUNTRIES.find(c => c[0] === 'NG'), gh = W.COUNTRIES.find(c => c[0] === 'GH'), us = W.COUNTRIES.find(c => c[0] === 'US');
      const cases = [['07700 900123', gb, '447700900123'], ['+44 07700 900123', gb, '447700900123'], ['0044 7700 900123', gb, '447700900123'], ['08031234567', ng, '2348031234567'], ['+234 0803 123 4567', gb, '2348031234567'], ['0244123456', gh, '233244123456'], ['(555) 123-4567', us, '15551234567'], ['+1 555 123 4567', gb, '15551234567'], ['0770090012', gb, ''], ['123', gb, '']];
      const bad = cases.filter(([p, c, want]) => W.waNum(p, c) !== want).map(([p, c, want]) => p + ' (' + c[0] + ') gave ' + W.waNum(p, c) + ' not ' + want);
      ok(!bad.length, '8: WhatsApp numbers come out right for UK, Nigerian, Ghanaian and US numbers' + (bad.length ? ': ' + bad.join('; ') : ''));
      ok(/start with 07/.test(W.phoneProblem('08031234567')) && W.phoneProblem('07700 900123') === '' && W.phoneProblem('+234 803 123 4567') === '', '8: a Nigerian local number with a UK home country is caught, with advice');
      X.click('[data-act="settings"]'); await wait();
      const opts = [...X.$('#pCountry').options].map(o => o.value);
      ok(X.$('#pCountry').value === 'GB' && opts[1] === 'NG' && opts[2] === 'GH', '8: Settings has a home country, United Kingdom by default, Nigeria and Ghana next');
      X.$('#pCountry').value = 'NG'; X.submit('#profForm'); await wait(60);
      ok(XS().profile.country === 'NG' && W.phoneProblem('08031234567') === '' && W.waNum('08031234567') === '2348031234567', '8: changing the home country to Nigeria makes local Nigerian numbers work');
      XS().profile.country = 'GB';
    })().catch(e => ok(false, '8: phone numbers and home country — crashed: ' + e.message));
    await (async () => {
      // 13: Today stays short with a backlog
      for (let i = 0; i < 12; i++) XS().contacts['bk' + i] = { id: 'bk' + i, name: 'Backlog ' + i, status: 'active', everyDays: 3, createdAt: Date.now() - 9e8, lastContact: Date.now() - (6 + i) * 864e5, replyState: 'none', log: [], consent: true };
      X.click('[data-act="tab"][data-v="today"]'); await wait();
      const msgSec = () => X.$$('#main .sec').find(sx => /Message today/.test(sx.textContent));
      ok(msgSec() && msgSec().querySelectorAll('.prow').length === 5 && X.$('[data-act="showall"]') && /more/.test(X.$('[data-act="showall"]').textContent), '13: Today shows 5 people to message, with "Show more"');
      X.click('[data-act="showall"]'); await wait();
      ok(msgSec().querySelectorAll('.prow').length >= 12, '13: "Show more" lists everyone');
      for (let i = 0; i < 12; i++) delete XS().contacts['bk' + i];
    })().catch(e => ok(false, '13: Today stays short with a backlog — crashed: ' + e.message));
    await (async () => {
      // 26: no "Add contact" button on Calendar
      X.click('[data-act="tab"][data-v="events"]'); await wait();
      ok(X.$('#fab').hidden, '26: the Add contact button is hidden on Calendar');
    })().catch(e => ok(false, '26: no "Add contact" button on Calendar — crashed: ' + e.message));
    await (async () => {
      // 17: headings never skip a level, Week has a main heading, coloured text is dark enough
      X.click('[data-act="tab"][data-v="week"]'); await wait();
      ok(X.$('#main h1'), '17: Week has a main heading');
      const appSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'app.html'), 'utf8');
      ok(!/<h3>/.test(appSrc), '17: card headings are level 2 (no skipped heading levels)');
      const L = h => { const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
      const ratio = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
      const v = n => (appSrc.match(new RegExp('--' + n + ':(#[0-9A-Fa-f]{6})')) || [])[1];
      const pairs = [['gold', 'bg'], ['gold', 'gold-soft'], ['warn', 'warn-soft'], ['warn', 'surface'], ['bad', 'bad-soft'], ['ok', 'ok-soft'], ['idle', 'idle-soft']].map(([f, b]) => [f + ' on ' + b, ratio(v(f), v(b))]);
      ok(pairs.every(p => p[1] >= 4.5), '17: coloured text meets 4.5:1 contrast: ' + pairs.map(p => p[0] + ' ' + p[1].toFixed(2)).join(', '));
    })().catch(e => ok(false, '17: headings never skip a level, Week has a main heading, co — crashed: ' + e.message));
    await (async () => {
      // 11: PIN waits after 5 wrong tries, and has a "Forgot" way out
      XS().profile.pinHash = await X.w.eval('(async () => 0)()') || ''; // set below through the app
      X.click('[data-act="settings"]'); await wait(); X.click('[data-act="setpin"]'); await wait();
      X.setVal('#pinNew', '2468'); X.setVal('#pinNew2', '2468'); X.submit('#pinForm'); await wait(120);
      X.click('[data-act="settings"]'); await wait(); X.click('[data-act="locknow"]'); await wait();
      for (let i = 0; i < 5; i++) { X.setVal('#lockPin', '000' + i); X.submit('#lockForm'); await wait(40); }
      X.setVal('#lockPin', '2468'); X.submit('#lockForm'); await wait(60);
      ok(!X.$('#lock').hidden && /Too many wrong PINs/.test(X.$('#lockMsg').textContent), '11: after 5 wrong PINs even the right one has to wait');
      ok(X.$('#lockForgot') && /Forgot/.test(X.$('#lockForgot').textContent), '11: the lock screen has "Forgot your PIN?"');
      X.click('#lockForgot'); await wait();
      ok(!X.$('#lockForgotBox').hidden && X.$('#lockForgotBox').textContent.length > 20, '11: "Forgot your PIN?" explains what to do');
      X.w.localStorage.setItem('shepherd:pinwait:u_test', '{}'); X.setVal('#lockPin', '2468'); X.submit('#lockForm'); await wait(60);
      ok(X.$('#lock').hidden, '11: after the wait, the right PIN unlocks');
      XS().profile.pinHash = '';
    })().catch(e => ok(false, '11: PIN waits after 5 wrong tries, and has a "Forgot" way ou — crashed: ' + e.message));
    await (async () => {
      // 12: if the phone is full, the person is told
      const real = X.w.Storage.prototype.setItem; X.w.Storage.prototype.setItem = function () { throw new Error('QuotaExceededError'); };
      W.saveLocal(); await wait(30);
      X.w.Storage.prototype.setItem = real;
      ok(/out of space/.test(X.$('#toast').textContent), '12: running out of phone storage shows a warning instead of failing silently');
    })().catch(e => ok(false, '12: if the phone is full, the person is told — crashed: ' + e.message));
    await (async () => {
      // 15: the website loads nothing from Google or other sites
      const idx = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8'), pv = require('fs').readFileSync(require('path').join(__dirname, '..', 'privacy.html'), 'utf8');
      ok(!/googleapis|gstatic|cdnjs/.test(idx + pv) && /vendor\/fonts\.css/.test(idx) && /vendor\/qrcode\.min\.js/.test(idx) && require('fs').existsSync(require('path').join(__dirname, '..', 'vendor', 'qrcode.min.js')), '15: fonts and the QR library are served by Shepherd itself');
    })().catch(e => ok(false, '15: the website loads nothing from Google or other sites — crashed: ' + e.message));
    await (async () => {
      // 27: tidy-ups
      ok(!/function chName/.test(appSrc) && !/lang: 'en-GB'/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'sw.js'), 'utf8')), '27: unused code removed; notifications carry their own language');
    })().catch(e => ok(false, '27: tidy-ups — crashed: ' + e.message));
    await (async () => {
      // privacy notice tells the truth about the new behaviour
      const pvt = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'privacy.js'), 'utf8');
      ok(/calendar link/.test(pvt) && /what kind of browser/.test(pvt) && /including your prayer list/.test(pvt) && /never notes or prayer points/.test(pvt) && /last 7 days/.test(pvt), 'privacy notice covers the calendar link, sign-in records, deletion, notifications and 7-day restore');
    })().catch(e => ok(false, 'privacy notice tells the truth about the new behaviour — crashed: ' + e.message));
    if (X.errors.length) ok(false, 'launch fixes: no script errors: ' + X.errors.slice(0, 3).join(' / '));
  }

  current = 'Script errors';
  const allErr = A.errors.concat(B.errors);
  ok(allErr.length === 0, 'no script errors' + (allErr.length ? ': ' + allErr.slice(0, 3).join(' / ') : ''));

  const pass = results.filter(r => r.ok).length, fail = results.length - pass;
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (process.env.I18N_COLLECT) fs.writeFileSync(process.env.I18N_COLLECT + ".app.json", JSON.stringify([...I18N_SINK], null, 1));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('CRASH', e && e.stack || e); process.exit(2); });
