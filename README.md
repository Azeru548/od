# Security Dues

A small, offline-first PWA for keeping a neighbourhood security-fee ledger. Track households, record monthly payments, see who owes what, and print or share receipts.

No build step and no npm dependencies. The ledger lives in a single Firebase Firestore document, while the browser keeps a copy in `localStorage` so the app still works offline.

## What it does

- **Households** — name, house/plot number, phone, monthly fee (default or per household), billing start month, notes.
- **Payments** — record one or several months at once, with the date paid, method, reference and note. Partial payments are handled; the amount is split sensibly across the months selected.
- **Overview** — collected vs expected this month, a paid/partial/unpaid breakdown, outstanding for the month and total arrears across all months.
- **Payment record** — a 12-month grid per household. Tap an unpaid month to record, a paid month to see its receipts.
- **Payments ledger** — every receipt, searchable and filterable by month covered.
- **Reports** — 12-month expected/collected/outstanding table, collection chart, biggest outstanding balances, CSV exports and full JSON backup.
- **Receipts** — printable, shareable (WhatsApp etc. via the system share sheet), with sequential receipt numbers.
- **Statement** — print a full statement of account for one household.
- **Archive** — mark a household as moved out without losing history.
- **Offline + installable** — service worker caches the app shell; install it from the browser menu.
- **Light / dark theme**, mobile-first layout.

## Run it locally

```bash
npm start
# open http://localhost:4173
```

Requires **Node.js 18 or newer**, and nothing to install. Records are synced to the Firestore project configured in `FIREBASE` at the top of `app.js`.

Or any static server, e.g. `npx serve .` — the app needs no server-side code, because the browser talks to Firestore directly. Opening `index.html` directly from disk mostly works, but the service worker (and therefore installability/offline) needs `http://localhost` or HTTPS.

## Firestore setup

The app reads and writes one document: `ledgers/main`. Its `data` field holds the whole ledger as JSON and its `updatedAt` field decides which copy is newer on load.

The web config in `app.js` is public by design — it identifies the project, it is not a credential. **Access is controlled entirely by the Firestore security rules.** The project currently denies anonymous access, so sync reports *“Firestore rules denied access”* until you publish a rule.

In the Firebase console → **Firestore Database → Rules**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /ledgers/{doc} {
      allow read, write: if true;
    }
  }
}
```

That rule makes the ledger readable and writable by anyone who has the config, which is fine for a personal backup but not for a shared community ledger. To require a signed-in user, enable an auth provider under **Authentication** and change the condition to `if request.auth != null`; every device then needs to sign in before syncing.

Existing SQLite records are not migrated automatically: use **Settings → Download** on the old copy, then **Restore from backup** on the new one.

## Deploy on Render

Because the data lives in Firestore, the app is a plain static site and needs no disk or database on the host.

**Option A — Blueprint (recommended)**

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, connect the repository.
3. Render reads `render.yaml` and creates the web service.
4. When prompted, set **`APP_PASSWORD`** to a password you choose. Leave `APP_USER` as `admin` or change it.
5. Deploy, then open the URL and complete setup.

**Option B — Manual web service**

1. **New → Web Service**, connect the repo, branch `main`.
2. Runtime **Node**; build command `npm install`; start command `node serve.js`.
3. Add environment variables:
   - `APP_PASSWORD=your-password` (recommended)
   - `APP_USER=admin` (optional)
4. Set the health check path to `/api/health`. Deploy.

**Important**

- **`APP_PASSWORD` only gates the app shell.** The records themselves sit in Firestore, so they are protected by the security rules above — not by the password.
- The ledger is shared, not per-device: every device that opens the site sees the same Firestore document.
- `render.yaml` still requests a 1 GB disk at `/var/data`. Nothing writes there any more, so you can drop the `disk:` block and the `DATA_DIR` variable.

## Local / static deployment

Uploading the static files to Netlify, Vercel, Cloudflare Pages or GitHub Pages works unchanged — the browser talks to Firestore directly, so no server is required.

When you change any cached file, bump `VERSION` in `sw.js` so installed copies pick up the update.

## Data & backup

- Every save is written to `localStorage` first and then synced to the Firestore document `ledgers/main`. The browser copy keeps the app usable offline; the document with the newer `updatedAt` wins on the next page load.
- Records are sent to Google Firebase. The ledger is a single document in the `ragaops-548` project.
- Clearing browser data does not delete the document. Use **Settings → Download** for a portable JSON backup, restorable on the same or another device.
- CSV exports open in Excel, Google Sheets and Numbers.
- In **Settings → Data**, the "Database" row shows whether the latest change reached Firestore: *Saved to Firestore*, *Saving…*, *Firestore unreachable — cached in browser*, or *Firestore rules denied access*.

## Project layout

```
index.html            app shell
styles.css            all styling
app.js                state, views, payments, receipts, exports, sync
manifest.webmanifest  PWA manifest
sw.js                 offline service worker
icons/                app icons (SVG + generated PNGs)
tools/make-icons.ps1  regenerates the PNG icons on Windows
serve.js              static file server (optional — Firestore needs no backend)
```
