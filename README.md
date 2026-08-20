# Mission Month — Registration Site

Volunteer registration form + admin dashboard for September Saturday outreach events.

**Live site: https://mission-month.vercel.app** (admin area: same site → "Admin" tab, passcode-protected)

- **Frontend**: static site (`index.html`, `styles.css`, `app.js`), deployed on Vercel
  (project `mission-month`). Note: only the clean URL above is public — the
  team-scoped `*-cofounder-6147s-projects.vercel.app` URLs sit behind Vercel's login.
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

## Registration rules

- Per Saturday, a person picks a 1st and 2nd preference (or skips the date).
- They are **placed in exactly one option**: 1st preference if it has room, otherwise 2nd.
  If both are full at submission time, the submission is rejected with a friendly message.
- Duplicate protection: same email + same date is blocked; same name/mobile/NRIC combinations
  are flagged as possible duplicates for admin review.
- Admins can move, release, place, cancel, and edit dates/options/capacities live.

## How the dashboard counts things

One person signing up for four Saturdays is **one person and four places**, and the
dashboard says so — "People signed up" counts people, "Saturday places taken" counts places.

A **1st choice you didn't get is a queue**. A **2nd choice is interest, never a queue** —
so an option's "Waiting" number only ever counts people who actually wanted it first.
Each Saturday shows one of these states, and the ones that need explaining carry a note:

| State | Means | Note underneath |
|---|---|---|
| `1ST CHOICE` | got what they asked for | — |
| `WAITING FOR 1ST` | in their 2nd choice, still hoping for their 1st | *1st choice was full when they signed up* — or — *Team balancing: an admin moved them here on 9 Aug* |
| `BACKUP INTEREST` | someone else's 2nd choice for this option; they're happy where they are | — |
| `NOT PLACED` | an admin released their slot and hasn't re-placed them | — |
| `OPTION REMOVED` | they were serving in an option that has since been removed | *"Home Cleaning" was removed — they have no place yet* |
| `CHOICE REMOVED` | serving somewhere real, but their 1st choice was removed | *confirm where they are, or move them* |

The green banner at the top lists everyone whose 1st choice **has room again**, with a
one-click "Place in 1st choice". It deliberately skips anyone an admin moved on purpose:
moving someone for team balancing also frees the slot they left, so without that rule the
banner would ask you to undo your own decision on every refresh. Those people still show
`WAITING FOR 1ST` with the balancing note, and can still be moved back by hand at any time.

Volunteers see friendlier wording on their confirmation: **CONFIRMED** plus **Backup choice**
when they got their 1st, and a **Waitlist #n** number only when they genuinely missed it.

## Editing copy

Everything visible on the form is editable from **Admin → Settings** without touching code:
form title, description, each date's label, each option's name and capacity, and the
line shown under each date heading.

The **description** and the **per-date lines** support `**bold**` — wrap words in double
stars. The description additionally understands:

| You type | You get |
|---|---|
| a blank line between blocks | a new paragraph, with a full gap |
| a single line break | the next line, kept tight against the one above |
| lines starting with `- ` | a tight bullet list |

Any HTML typed into these fields is escaped, so the above is the only formatting
available (and the only markup that can reach the page).

## Changing the options after people have signed up

Both of these used to lose people quietly. Neither does now.

**Removing an option — delete now, reassign later.** Clicking ✕ in Settings removes
it straight away, because the urgent thing is that nobody else signs up for
something that isn't happening. Nobody attached to it is dropped.

Options are *retired* rather than deleted, so the record stays and old
registrations, history entries and the CSV still show a name instead of a raw id.
Anyone whose **2nd choice** it was needs no decision — that backup simply no
longer exists, and they keep the place they already have. Everyone else (sitting
in it, or holding it as their 1st choice) is flagged on the **Dashboard**:

> **2 people need a new place — "Home Cleaning" was removed**
> Nobody was dropped and nobody new can sign up for it. Reassign them whenever
> you're ready — one at a time is fine.

Reassignment happens there, in the same panel as the capacity one: each person
with their phone and email so you can call them first, and a dropdown of the other
options that Saturday showing places left. Overfilling is blocked before anything
is sent, and you can do two people today and the rest tomorrow.

Their **preference** is rewritten, not just their placement. Whatever they move
into becomes their new 1st choice — otherwise they would sit in "waiting for their
1st choice" forever, queueing for something that no longer exists. Their history
records what really happened: *"Reassigned after 'Home Cleaning' was removed: now
in Food Distribution."*

**Lowering a capacity below the people already in it.** Nobody is thrown out —
being un-invited after being told you're confirmed is not something the software
should do on its own. You get a warning before the change saves, and afterwards
the Dashboard carries a red banner: *"1 person is over the limit."* The people
over the line are the **latest sign-ups**, and the same panel lets you move each
of them, or leave one unplaced deliberately so you can call them first. Anyone
left unplaced shows as `NOT PLACED` until you sort them out.

## Export / Google Sheets

- **Admin → Settings → Download CSV** downloads everything as a spreadsheet file. Alongside
  the answers it carries `Serving In`, `Placement`, `Waiting For` and a `Note` saying whether
  someone missed their 1st choice because it was full or because an admin moved them.
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
