# Mookies Kiosk

The kiosk end-of-shift report at **kiosk.mookiesoatmealcookies.com**: a small Cloudflare Worker, separate from the shop website.

- **Staff** open the page on the kiosk phone at closing and send the report. It lands in the accounting Sheet (Mookies_Operations_and_Finance) as a **Pending** row in KIOSK REPORTS, plus one row per flavor in KIOSK STOCK.
- **Maan** approves by setting Status to **Approved** in KIOSK REPORTS. Within 5 minutes the Worker posts it to LEDGER (Source "Kiosk form"). Setting Status back to Pending or Rejected removes those rows; editing an approved report re-posts it. Column AO shows what was posted.

The column layout is the same as the old Apps Script, so every report in the Sheet keeps working.

## Setup (once)

1. Share the accounting Sheet with `mookies-orders@mookies-orders.iam.gserviceaccount.com` as **Editor** (the website's service account).
2. GitHub repo secrets: `CLOUDFLARE_API_TOKEN` (a token with "Edit Cloudflare Workers"), `CLOUDFLARE_ACCOUNT_ID`, and `GOOGLE_PRIVATE_KEY` (the `private_key` from the service account's JSON key).
3. Push to `main`: the workflow checks, deploys and sets the key.
4. Once it works, delete the old Apps Script trigger (Extensions → Apps Script → Triggers → `onEditPost`) so only one thing posts to LEDGER.

## Work on it

    npm ci
    npm test          # runs against an in-memory sheet (tests/fake-sheet.ts)
    npm run typecheck

Stop the LEDGER posting without touching the form: set `SYNC_MODE` to anything but `on` (wrangler.jsonc or the Cloudflare dashboard).

`src/sheets/` is copied from the website repo (Sheets client and service-account sign-in).
