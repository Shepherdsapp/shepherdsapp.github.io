/* Shepherd's privacy notice and acceptable use statement. Used in the app (Settings › Privacy and safe use, and the
   one-time "Before you start" agreement) and on its own page, privacy.html, so anyone can read it before signing up.
   Written in English; the language files translate it on screen. */
(function () {
  var USE_VERSION = 1; // raise this when the acceptable use statement changes, so everyone agrees to the new one
  var UPDATED = '2026-10-29';
  function cfg() { var c = (window.SHEPHERD_CONFIG && window.SHEPHERD_CONFIG.privacy) || {}; return { controller: c.controller || 'Pavi', contact: c.contact || '8pavii@gmail.com' }; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); }
  function when() {
    var d = new Date(UPDATED + 'T12:00:00');
    try { var loc = window.I18N && I18N.lang !== 'en' ? I18N.locale() : 'en-GB'; if (Intl.DateTimeFormat.supportedLocalesOf([loc]).length) return new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'long', year: 'numeric' }).format(d); } catch (e) {}
    return '29 October 2026';
  }
  function sec(title, body) { return '<section class="card pv"><h3>' + title + '</h3>' + body + '</section>'; }
  function ul(items) { return '<ul class="steps">' + items.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul>'; }
  function rules() {
    return ul([
      'You are responsible for the people you choose to contact through Shepherd.',
      'Only add and contact people whose details you got fairly, for example they gave you their number or scanned your QR code.',
      'If someone asks you to stop messaging them, stop. Mark them <b>No longer contact</b>, and delete their details if they ask.',
      'Don\'t share anyone\'s contact details without a good reason and their agreement.',
      'Never use Shepherd for spam, bulk messages, harassment or anything unlawful.',
      'You remain responsible for following data protection and privacy law when you use Shepherd.'
    ]);
  }
  function contactLine(c) {
    return c.contact
      ? '<p class="note">For any privacy question, or to ask what is held about you, or for it to be corrected or removed, email <b>' + esc(c.contact) + '</b>.</p>'
      : '<p class="note">For any privacy question, or to ask what is held about you, or for it to be corrected or removed, ask <b>' + esc(c.controller) + '</b> through your church.</p>';
  }
  // the whole notice
  function html() {
    var c = cfg();
    return '<p style="margin:0">Shepherd is a personal tool. It helps you remember to follow up with people you know, using your own WhatsApp. It isn\'t a church database or a marketing tool, and nobody else can see your list.</p>' +
      '<p class="note pvdate">Last updated <b>' + esc(when()) + '</b></p>' +
      sec('Who is responsible',
        '<p class="note">Shepherd is run by <b>' + esc(c.controller) + '</b>, who is responsible for how it handles information (the data controller).</p>' + contactLine(c)) +
      sec('Your responsibility',
        '<p class="note">You decide who to add and what to write about them. You are responsible for the people you contact through Shepherd and for the information you keep about them.</p>' +
        '<p class="note">Only write what you would be comfortable for that person to read. Don\'t record health or other sensitive details unless they are happy for you to keep them.</p>') +
      sec('Acceptable use', '<p class="note">Everyone who uses Shepherd agrees to this:</p>' + rules()) +
      sec('What Shepherd keeps, and why',
        '<p class="note"><b>Data linked to you</b>, saved to your own private account so your list is on every phone you sign in on and isn\'t lost:</p>' +
        ul(['Your name, email, WhatsApp number, home country and settings (such as language, time zone and notification times).', 'The people you add: their names, phone numbers, social handles, notes, prayer points and Bible studies, and whether they agreed to be added.', 'Your events, disciples and prayer list.', 'For each phone you\'re signed in on: when it signed in and was last used, and what kind of browser it is, so it stays signed in.', 'The notifications planned for the next two weeks. Once sent, only the time is kept, for 3 days.']) +
        '<p class="note"><b>Kept only on this phone</b>:</p>' +
        ul(['Contacts you import from your phone, used to suggest names as you type. They are never uploaded.', 'A copy of your list, so Shepherd works without signal.']) +
        '<p class="note"><b>Never collected</b>:</p>' +
        ul(['Your location.', 'Your WhatsApp, text or iMessage conversations.', 'Your whole address book (only the contacts you choose).', 'Anything for adverts or tracking.']) +
        '<p class="note"><b>When someone scans your QR code</b>: they choose to type their name (and number if they want) and tick that they\'re happy to be added. It goes only into your list, and they then message you on WhatsApp themselves.</p>' +
        '<p class="note"><b>If you connect your phone calendar</b>: a private calendar link shows your Bible studies (with first names and topics) and your events. Anyone you give that link to can see them, and your phone\'s calendar service (such as Apple or Google) keeps a copy. You can replace the link in Shepherd at any time.</p>') +
      sec('How it\'s protected',
        ul(['Your list is saved to your own private account. Nobody else using Shepherd can see it.',
          'Everything travels over an encrypted connection and is stored with Cloudflare, which encrypts it on its servers.',
          'Your password is scrambled on your phone before it is sent and scrambled again on the server, so nobody can read it.',
          'Phone notifications are encrypted on the way to your phone and only show first names, never notes or prayer points.',
          'Shepherd\'s fonts and code come from Shepherd itself, so no advertising or tracking company sees you use it.',
          'Shepherd never sends messages for you. Every WhatsApp message is one you send yourself.',
          'Earlier versions are kept for up to a year so nothing is lost by mistake. Deleting someone\'s data removes every copy Shepherd keeps.',
          'For emergencies, the whole database can be restored to any point in the last 7 days, so a deletion is fully gone after 7 days.',
          'The server is looked after by <b>' + esc(c.controller) + '</b>, who doesn\'t look at anyone\'s list and only reaches stored data to keep Shepherd running or to act on a request to remove someone.'])) +
      sec('Keep your phone safe',
        ul(['Lock your phone with a passcode, Face ID or fingerprint.',
          'Turn on Shepherd\'s own PIN in <b>Settings › App lock</b>.',
          'Keep your phone and Shepherd up to date. When Shepherd says a new version is ready, tap <b>Update</b>.',
          'Don\'t share your password, and sign out on phones that aren\'t yours.',
          'Lost your phone? Sign in on another phone and change your password. That signs the lost phone out.'])) +
      sec('How long it\'s kept, and your choices',
        ul(['Information stays until you delete it. People you stop contacting are kept under No longer contacting until you delete them.',
          'Someone asks you to delete their details? Open them, tap <b>No longer contact</b>, then <b>Delete all their data</b>. That removes them from Shepherd, including your prayer list. Copies you made yourself, such as an exported backup or your phone\'s contacts, are yours to delete.',
          'Export a backup at any time from Settings. <b>Delete my account</b> removes everything for good.',
          'Anyone can ask what Shepherd holds about them, and ask for it to be corrected or removed.']) + contactLine(c));
  }
  // the short version everyone agrees to once
  function agreeHtml() {
    return '<p style="margin:0">Shepherd is your personal tool for following up with people you know. Before you start, please agree to use it responsibly:</p>' + rules();
  }
  window.ShepherdPrivacy = { html: html, agreeHtml: agreeHtml, USE_VERSION: USE_VERSION };
})();
