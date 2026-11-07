# Security Dues

A small, offline-first PWA for keeping a neighbourhood security-fee ledger. Track households, record monthly payments, see who owes what, and print or share receipts.

No build step, no dependencies, no server. All records stay in the browser on the device.

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

Or any static server, e.g. `npx serve .`. Opening `index.html` directly from disk mostly works, but the service worker (and therefore installability/offline) needs `http://localhost` or HTTPS.

## Deploy

It is a plain static site. Drop the folder on Netlify, Vercel, Cloudflare Pages, GitHub Pages, or any web host. No environment variables, no backend.

When you change any cached file, bump `VERSION` in `sw.js` so installed copies pick up the update.

## Data & backup

- Records live in `localStorage` under the key `security-dues.v1`.
- Nothing is uploaded. Clearing browser data/site data will erase the records, so use **Settings → Download** regularly.
- A JSON backup can be restored on the same or another device via **Settings → Restore from backup**.
- CSV exports open in Excel, Google Sheets and Numbers.

## Project layout

```
index.html            app shell
styles.css            all styling
app.js                state, views, payments, receipts, exports
manifest.webmanifest  PWA manifest
sw.js                 offline service worker
icons/                app icons (SVG + generated PNGs)
tools/make-icons.ps1  regenerates the PNG icons on Windows
serve.js              tiny local dev server
```
