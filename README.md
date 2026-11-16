# Security Dues

A small, offline-first PWA for keeping a neighbourhood security-fee ledger. Track households, record monthly payments, see who owes what, and print or share receipts.

No build step and no npm dependencies. A tiny local server (`serve.js`) keeps the ledger in a SQLite database on your machine, while the browser caches a copy so the app still works offline.

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

Requires **Node.js 22.5 or newer** — the server uses the built-in `node:sqlite` module, so there is nothing to install. Records are written to `data/security-dues.db` (created automatically).

Or any static server, e.g. `npx serve .`. Opening `index.html` directly from disk mostly works, but the service worker (and therefore installability/offline) needs `http://localhost` or HTTPS, and the database sync needs the Node server.

## Deploy

The front end is a plain static site, but the database API (`/api/state`) is provided by `serve.js`. If you upload only the static files to Netlify, Vercel, Cloudflare Pages or GitHub Pages, the app falls back to browser-only storage. To keep the SQLite database, run `serve.js` on your machine (or a small Node host with a persistent disk).

When you change any cached file, bump `VERSION` in `sw.js` so installed copies pick up the update.

## Data & backup

- Every save is written to `localStorage` first and then synced to `data/security-dues.db` through `/api/state`. The browser copy keeps the app usable if the server is offline; the newer copy wins on the next sync.
- Nothing is sent to the internet. The database is a single SQLite file on this machine.
- Clearing browser data does not delete the database, but deleting `data/security-dues.db` does. Use **Settings → Download** for a portable JSON backup, restorable on the same or another device.
- CSV exports open in Excel, Google Sheets and Numbers.
- In **Settings → Data**, the "Local database" row shows whether the latest change reached the database.

## Project layout

```
index.html            app shell
styles.css            all styling
app.js                state, views, payments, receipts, exports, sync
manifest.webmanifest  PWA manifest
sw.js                 offline service worker
icons/                app icons (SVG + generated PNGs)
tools/make-icons.ps1  regenerates the PNG icons on Windows
serve.js              static server + SQLite database API
data/                 database files (created at runtime, git-ignored)
```
