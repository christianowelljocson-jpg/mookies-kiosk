# Mookies Kiosk

The kiosk end-of-shift report at **kiosk.mookiesoatmealcookies.com**: a small Cloudflare Worker, separate from the shop website.

- **Staff** open the page on the kiosk phone at closing and send the report.
- It goes straight into Maan's accounting Sheet, tab **Income & Expense**, on the row she typed ahead for that kiosk and day ("SM JAZZ KIOSK DAILY SALES - …"):
  - **Staff**: who worked (two names joined with " & ").
  - **Flavor columns**: cookies sold per flavor. **WATER**: bottles sold.
  - **Income**: the amounts added up, always in the form's order: `=cash+GCash+card+bank+Grab/Panda+online`.
  - The row turns **yellow**. Maan checks it and clears the colour.
- No row for that day, or the row already filled? A new row is added in date order.
- The full report (start, delivered, free, left per flavor, boxes, discounts, notes) goes to the **Kiosk form log** tab. The form's Start counts come from the last Left logged there.

Columns are found by their row-2 headers. A new flavor is a new column between "12" and "WATER", and the form picks it up by itself.

## Setup (once)

1. Share the Sheet with `mookies-orders@mookies-orders.iam.gserviceaccount.com` as **Editor** (the website's service account). Its id is `SHEET_ID` in wrangler.jsonc.
2. GitHub repo secrets: `CLOUDFLARE_API_TOKEN` (a token with "Edit Cloudflare Workers"), `CLOUDFLARE_ACCOUNT_ID`, and `GOOGLE_PRIVATE_KEY` (the service account's JSON key file, whole, or just its `private_key`).
3. Push to `main`: the workflow checks, deploys and sets the key.

## Work on it

    npm ci
    npm test          # runs against an in-memory sheet (tests/fake-sheet.ts)
    npm run typecheck

Kiosks, the staff list, flavor names and box prices are at the top of `src/ie.ts`.

`src/sheets/` is copied from the website repo (Sheets client and service-account sign-in).
