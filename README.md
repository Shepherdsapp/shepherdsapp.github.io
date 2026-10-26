# Shepherd

A church follow-up app for disciples sharing their faith (Matthew 28:19). It reminds you who to message, who you owe a
reply, who has gone quiet, your Bible studies, your disciples (1 Thessalonians 5:11) and your events. It sends **phone
notifications that name people**, like "Reply to Grace", "Message Daniel" or "Did Sam reply?". Each one opens that person.

It's a website you install on your phone like an app. No App Store, no Google Play and no Claude. Everyone signs in with
their own email and password, and each person's list is theirs alone.

| File | What it is |
|---|---|
| `index.html` | The app. Built from `src/` by `node build.mjs`. **Upload this.** |
| `privacy.html` | The privacy notice and acceptable use statement as its own page (linked from the sign-up screen). Built with `index.html`. **Upload this too.** |
| `sw.js` | Lets the app open with no signal, and shows Shepherd's notifications. **Upload it again every time `index.html` changes.** |
| `config.js` | Your server's address, and who to contact about privacy. **Edit it once** (step 2.3). |
| `manifest.json`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png`, `badge-96.png` | The Home Screen icon and install details. Upload once. |
| `lang/` | The 14 other languages. `lang/<code>.json` is what phones download; `lang/src/<code>.txt` is the translation you edit; `lang/_keys.txt` is every English line. **Upload the whole folder.** |
| `worker/worker.js` | The server: a Cloudflare Worker for accounts, saving, notifications, the calendar link and the QR hello page. **Paste this into Cloudflare.** |
| `hosted/shepherd.html` | The same app built to live inside Claude (no notifications or calendar link there). |
| `src/` | Source: `app.html` (the app), `web.js` (sign-in, saving to your server, notifications, installing), `i18n.js` (languages) and `privacy.js` (the privacy notice and acceptable use statement). |
| `test/` | The tests (see the end of this page). |

No password, key or private address is written anywhere in this folder.

---

## 1. The server (Cloudflare, free)

1. dash.cloudflare.com → **Workers & Pages → Create → Create Worker**. Name it **shepherd** → **Deploy**.
2. **Edit code** → delete everything → paste all of `worker/worker.js` → **Deploy**.
3. **Storage & Databases → D1 → Create database**. Name it **shepherd** → **Create**.
4. Back on the **shepherd** Worker → **Settings → Bindings → Add → D1 database**. Variable name **`DB`**, database
   **shepherd** → **Deploy**.
5. Worker → **Settings → Trigger events** (sometimes called **Triggers**) → **Add → Cron trigger** → **Every 5 minutes**
   (or type `*/5 * * * *`) → **Add**. This is what sends the notifications on time.
6. Worker → **Settings → Variables and Secrets → Add**:

   | Name | Type | Value |
   |---|---|---|
   | `ADMIN_KEY` | Secret | a long passcode you make up (20+ characters). Lets you give someone a password reset code |

   Optional: `RESEND_API_KEY` (Secret) and `MAIL_FROM` (Text, e.g. `Shepherd <hello@yourchurch.org>`) so people can reset
   their own password by email. This needs your own web domain added to resend.com. Without them, use the admin page
   (see "Forgotten passwords").
7. Open `https://shepherd.<your-name>.workers.dev/health`. You should see `"db":true`. The address at the top of the
   Worker's page is your **Worker address**.

The tables and the notification keys are created by the Worker itself the first time it runs. There's nothing else to set up.

## 2. The app (GitHub Pages, free)

1. github.com → **New repository**. Name it **shepherd**, set it to **Public** → **Create repository**.
2. **Add file → Upload files**. Drag in `index.html`, `privacy.html`, `sw.js`, `config.js`, `manifest.json`, `icon-192.png`, `icon-512.png`,
   `apple-touch-icon.png`, `badge-96.png` and the `lang` folder → **Commit changes**.
3. Click `config.js` → the pencil (Edit) → replace `https://shepherd.YOUR-NAME.workers.dev` with your **Worker address**
   from 1.7. On the `privacy:` line, put the email people should write to about their data, e.g.
   `privacy: { controller: 'Pavi', contact: 'you@example.com' }` → **Commit changes**. Until a contact is set, the
   privacy notice tells people to ask you through the church.
4. **Settings → Pages → Deploy from a branch → main / (root) → Save**.
5. A minute or two later it's live at **https://sitbackco.github.io/shepherd/**.

The server only accepts requests from `https://sitbackco.github.io`. If the app ever lives somewhere else, add a Text
variable `ALLOWED_ORIGINS` to the Worker with that address, and update `APP_URL` too.

## 3. On each phone

**iPhone** (iOS 16.4 or later)
1. Open **https://sitbackco.github.io/shepherd/** in **Safari** → **Share** → **Add to Home Screen** → **Add**.
2. Open Shepherd from that icon from then on. Notifications only work from the Home Screen icon.
3. **Create account** (or **Sign in**). You only sign in once on each phone.
4. Settings → **Turn on notifications** → **Allow** → **Send a test**.

**Android**
1. Open the address in **Chrome** → **⋮** → **Install app** (or **Add to Home screen**) → **Install**.
2. Open Shepherd from its icon → **Create account** or **Sign in**.
3. Settings → **Turn on notifications** → **Allow** → **Send a test**.

Creating an account means ticking **I agree to use Shepherd responsibly** (the acceptable use statement). The date and
version of that agreement are saved with the account. Anyone who signed up before it existed is asked once, on a
"Before you start" screen, before they carry on.

The tour starts by itself the first time. Its 16 cards walk through every part of the app (adding someone, the QR code,
Today, messaging, replies, each person's page, List and Journey, disciples, the prayer list, the calendar, the week,
Settings), with iPhone and Android steps side by side, and you can set things up as you go. Replay it from Settings.

**Today** is a quick look at the day: a **Met someone?** card to add a person or show your QR code, who to reply to, who
to message, the disciples still to check on this week, today's events only, and who to pray for.

When a new version is uploaded, phones show **A new version of Shepherd is ready → Update** the next time Shepherd is
opened.

### Moving your list from the Claude version

In the Claude version: **Settings → Export a backup**. In the new app: **Settings → Restore a backup** and choose that
file. Nothing is added twice, and newer copies win.

## What the notifications say

Worked out on the phone from your list, then sent by the server at the right time, even when the app is closed:

| When | Example |
|---|---|
| Every morning at your time (Settings) | **Reply to Grace**: Grace messaged you 2 days ago. **Message Daniel**: 3 days overdue. **Did Sam reply?** **Message Pete**: back from a pause today |
| Monday and Thursday mornings | **Check in with Ama** (disciples you haven't checked in with this week) |
| An hour before | **Bible study with Joel at 7pm**, **Sunday service at 10:30am** |
| The morning before | **Tomorrow: Sunday service** |
| Sunday morning | **Your week**: you followed up with 9 of 11 people |

- At most 8 named notifications each morning, then one "And 4 more today" naming the rest.
- First names only, never numbers or notes.
- Tapping a notification opens that person. The app icon shows how many people are waiting on you.
- Settings → **What Shepherd tells you about** turns each kind on or off.
- Anything you change in the app works the next two weeks out again, so a reply you log stops its reminders.

## The calendar

In the app: **Calendar → How to link your phone calendar**.

1. **Connect Shepherd to your phone calendar.**
   - iPhone: tap **Connect to iPhone calendar** → **Subscribe**. Studies and events then appear in the Calendar app as
     "Shepherd" and keep themselves up to date.
   - Android: tap **Add to phone calendar** on a study or event. To have them added by themselves, use the ICSx⁵ app
     with **Copy calendar link**.
2. **Keep your personal TimeTree events in your phone calendar too.** TimeTree doesn't share its events with other
   apps, so it can't copy them over by itself. Add the ones that matter to your phone's Calendar app (tap **+**).

Add services and events on Shepherd's Calendar tab so you can invite people and tick who came.

## Journey, prayer list, phone contacts and the QR code

- **People → Journey** shows everyone by stage: First contact → Interested → Studying → Regular at church → Baptised →
  Disciple. Tap **Move to …** to move someone on, or tap a stage on their page. Moving someone to Disciple doesn't add them
  to the Disciples tab.
- **Prayer list** (Today → Pray today, or Settings): add a name and optional notes. Each day Shepherd shows 2 or 3 of them,
  taking turns. Turn on **Remind me to pray each day** in Settings and pick a time for a notification that names them.
- **Phone contacts** (Settings): import a contacts file (any phone) or, on Android, pick contacts. When you add someone,
  matching names and numbers come up as you type. They stay on that phone and are never uploaded. **Save to phone** on a
  person's page makes a contact card for the phone's Contacts app.
- **QR code**: someone scans it, types their name (and number if they like) on a small Shepherd page, and is added to
  your list as First contact. WhatsApp then opens with your message ready for them to send, and you get a notification.
  The standard message is *Hi, nice to meet you, I got your contact from Shepherd! Hoping to hear from you soon.* in your
  language; change it in Settings.
- **Settings → What's saved and who can see it** lists exactly what is kept, where, and what is never collected.

## Languages

Settings → **Language**: English, Español, Français, Português, Nederlands, Polski, Naijá, Yorùbá, Igbo, 中文（简体）,
中文（繁體・香港／台灣）, 日本語, Deutsch, Русский, Lietuvių. A new phone starts in the phone's own language if it's one of
these, and picks up the language you chose on your other phones once you sign in. Notifications, invites, the QR page and
the calendar feed follow the language too. **Bible verses always stay in English (NIV).**

The translations were written for Shepherd and haven't yet been checked by native speakers. To correct one, edit
`lang/src/<code>.txt` (each line is `number<TAB>text`; the English is the same number in `lang/keys.json`), then run
`node lang/check.mjs` and `node build.mjs`. Words that change with a number are written `§one=…|few=…|many=…|other=…`.
To add a new English line, add it to `lang/_keys.txt`; `node lang/check.mjs` lists what each language is missing.

## Forgotten passwords

Open `https://<your worker address>/admin`, type your `ADMIN_KEY` and the person's email. You get a 6-digit code that
works for one hour. Give it to them. In Shepherd they tap **Forgot password?** and enter it. You never see anyone's
contacts. With Resend set up (1.6), the code is emailed to them instead. A reset signs that person out on their other
phones; they sign back in with the new password and nothing is lost.

## Your data

The full privacy notice is in the app (Settings → **Privacy and safe use**) and at
**https://sitbackco.github.io/shepherd/privacy.html**. It covers who is responsible, each user's own responsibility, the
six-point acceptable use statement, what is kept and why, how it's protected, keeping your phone safe (passcode,
Shepherd's PIN, staying up to date) and how long things are kept. Edit the wording in `src/privacy.js`, add any new
lines to `lang/_keys.txt` and every `lang/src/<code>.*.txt`, then run `node lang/check.mjs` and `node build.mjs`.

- Saved on the phone at once, and on your Shepherd server a second later. It works with no signal and catches up when
  back online.
- The server keeps earlier versions of every contact for a year. Cloudflare can also roll the whole database back
  (D1 → shepherd → **Time Travel**).
- **Delete all their data** (when someone asks) removes that person and every earlier copy of them.
- Settings → **Export a backup** saves everything as a file. **Delete my account** removes everything for good.
- Passwords are scrambled on the phone before they're sent, and scrambled again on the server. Nobody can read them.

## Free limits

Cloudflare's free plan gives 100,000 requests a day and 5 GB of database. An open app checks for changes every 20
seconds, about 180 requests an hour, so that covers several hundred hours of use a day: plenty for a church.

## Changing the app

Edit `src/app.html` or `src/web.js`, run `node build.mjs`, then run the tests. When `index.html` changes, raise
`VERSION` in `sw.js` (e.g. `shepherd-v5`) and upload both, so phones fetch the new version. When `worker/worker.js`
changes, paste it into the Worker again and **Deploy**.

## Tests

`npm install`, then:

| Command | What it checks |
|---|---|
| `node test/worker.test.mjs` | 87 checks of the server: the QR hello page (adds the person, opens WhatsApp in your language, slows down spam), accounts, saving (newer copies always win), history, deleting, notifications (encrypted and signed exactly as Apple and Google require, then decrypted the way a phone does), the calendar link, password resets, privacy between accounts |
| `node test/app.test.cjs` | 304 checks of the app: every screen, the 16-card tour, the acceptable use agreement, the privacy page, guides, the journey, the prayer list and its reminders, reading contacts files from iPhone and Android, the notification schedule (names, times, pauses, caps), and the app in Spanish (Bible verses stay English) |
| `node test/e2e.mjs` | 76 checks of the built website in Chromium at iPhone and Android sizes (320 to 430px wide), talking to the real server code: sign up (no account without agreeing), privacy.html on its own and in Spanish, two phones in sync, notifications from schedule to delivery, tapping one, the calendar link, password reset, sign out, offline, every tour card fully on screen at four phone sizes, and switching language (a second phone follows, works offline) |
| `node lang/check.mjs` | every language has every line, with the same `{0}` gaps and bold words |
