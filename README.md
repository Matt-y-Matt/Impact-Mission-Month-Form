# Saturday Serve — Registration Site

Volunteer registration form + admin dashboard for September Saturday outreach events.

- **Frontend**: static site (`index.html`, `styles.css`, `app.js`), deployed on Vercel.
- **Database**: Supabase Postgres (project `saturday-serve`, ref `xjxktvnspmgvgixvqiji`, region `ap-southeast-1`).
- **API**: all access goes through SQL functions (RPCs) — the tables themselves are not
  reachable with the public API key (row-level security is enabled with no policies).

## How data is protected

| Endpoint | Who can call it | What it exposes |
|---|---|---|
| `get_public_state()` | anyone | form title/description + per-option availability counts only (no personal data) |
| `submit_registration(...)` | anyone | inserts a registration; validation, duplicate checks and capacity allocation run server-side inside a transaction (advisory-locked, so two people can't take the last slot) |
| `admin_check(code)` / `admin_get_state(code)` / `admin_action(code, ...)` | requires the admin passcode | registrant details + all admin operations |
| `export_csv(token)` / edge function `export-csv?code=...` | requires the export token | full CSV of registrations |

The admin passcode and export token live in the `private.admin_config` table, which is not
exposed to the API at all. Change the passcode from **Admin → Settings** on the site, or via SQL.

## Registration rules (same as the original design)

- Per Saturday, a person picks a 1st and 2nd preference (or skips the date).
- They are **confirmed for exactly one option**: 1st preference if it has room, otherwise 2nd.
  If both are full at submission time, the submission is rejected with a friendly message.
- The non-confirmed preference is kept as a **waitlist** entry, ordered by submission time
  (admins can reorder it).
- Duplicate protection: same email + same date is blocked; same name/mobile/NRIC combinations
  are flagged as possible duplicates for admin review.
- Admins can move, release, promote, cancel, and edit dates/options/capacities live.

## Export / Google Sheets

- **Admin → Settings → Download CSV** downloads everything as a spreadsheet file.
- **Google Sheets**: paste the `=IMPORTDATA("…/functions/v1/export-csv?code=…")` formula
  (shown in Admin → Settings) into cell A1 of a sheet — it pulls live data and refreshes
  roughly every hour.

## Repo layout

```
index.html, styles.css, app.js      the site
supabase/migrations/                database schema (already applied to the live project)
supabase/functions/export-csv/      CSV edge function (already deployed)
```

Deploying frontend changes: any static host works; the current production deploy is on
Vercel (project `saturday-serve`). The Supabase URL + public (anon) API key are embedded in
`app.js` — that key is designed to be public; all sensitive access is gated by the passcode
as described above.
