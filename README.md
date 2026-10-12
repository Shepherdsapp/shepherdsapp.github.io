# Shepherd

A church follow-up app for disciples sharing their faith (Matthew 28:19). It reminds you who to message, who you owe a
reply, who has gone quiet, your Bible studies, your disciples (1 Thessalonians 5:11) and your events. It sends **phone
notifications that name people**, like "Reply to Grace", "Message Daniel" or "Did Sam reply?". Each one opens that person.

It's a website you install on your phone like an app. No App Store, no Google Play and no Claude. Everyone signs in with
their own email and password, and each person's list is theirs alone.

| File | What it is |
|---|---|
| `index.html` | The app. Built from `src/` by `node build.mjs`. **Upload this.** |
| `sw.js` | Lets the app open with no signal, and shows Shepherd's notifications. **Upload it again every time `index.html` changes.** |
| `config.js` | Your server's address. **Edit it once** (step 2.3). |
| `manifest.json`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png`, `badge-96.png` | The Home Screen icon and install details. Upload once. |
| `worker/worker.js` | The server: a Cloudflare Worker for accounts, saving, notifications and the calendar link. **Paste this into Cloudflare.** |
| `hosted/shepherd.html` | The same app built to live inside Claude (no notifications or calendar link there). |
| `src/` | Source: `app.html` (the app) and `web.js` (sign-in, saving to your server, notifications, installing). |
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
2. **Add file → Upload files**. Drag in `index.html`, `sw.js`, `config.js`, `manifest.json`, `icon-192.png`, `icon-512.png`,
   `apple-touch-icon.png` and `badge-96.png` → **Commit changes**.
3. Click `config.js` → the pencil (Edit) → replace `https://shepherd.YOUR-NAME.workers.dev` with your **Worker address**
   from 1.7 → **Commit changes**.
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

The tour starts by itself the first time and walks through all of this, with iPhone and Android steps side by side.

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

In the app: **Calendar → How to link your calendar and TimeTree**.

1. **Link TimeTree to your phone calendar.**
   - iPhone: Settings › TimeTree › Calendars › Full Access.
   - Android: Settings › Apps › TimeTree › Permissions › Calendar › Allow.
   - Then in TimeTree: Home Calendar › switch icon › Select Display Filters › Allow Access.
2. **Connect Shepherd to your phone calendar.**
   - iPhone: tap **Connect to iPhone calendar** → **Subscribe**. Studies and events then appear in the Calendar app as
     "Shepherd" and update by themselves.
   - Android: tap **Add to phone calendar** on a study or event. To have them added by themselves, use the ICSx⁵ app
     with **Copy calendar link**.

Because TimeTree shows your phone calendar, everything from Shepherd shows in TimeTree too. TimeTree has no way to send
its own events out to other apps, so events you create in TimeTree don't come into Shepherd. Add services and events on
the Calendar tab so you can invite people and tick who came.

## Forgotten passwords

Open `https://<your worker address>/admin`, type your `ADMIN_KEY` and the person's email. You get a 6-digit code that
works for one hour. Give it to them. In Shepherd they tap **Forgot password?** and enter it. You never see anyone's
contacts. With Resend set up (1.6), the code is emailed to them instead. A reset signs that person out on their other
phones; they sign back in with the new password and nothing is lost.

## Your data

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
`VERSION` in `sw.js` (e.g. `shepherd-v2`) and upload both, so phones fetch the new version. When `worker/worker.js`
changes, paste it into the Worker again and **Deploy**.

## Tests

`npm install`, then:

| Command | What it checks |
|---|---|
| `node test/worker.test.mjs` | 71 checks of the server: accounts, saving (newer copies always win), history, deleting, notifications (encrypted and signed exactly as Apple and Google require, then decrypted the way a phone does), the calendar link, password resets, privacy between accounts |
| `node test/app.test.cjs` | 224 checks of the app: every screen, the tour, guides, and the notification schedule (names, times, pauses, caps) |
| `node test/e2e.mjs` | 53 checks of the built website in Chromium at iPhone and Android sizes (320 to 430px wide), talking to the real server code: sign up, two phones in sync, notifications from schedule to delivery, tapping one, the calendar link, password reset, sign out, offline |
