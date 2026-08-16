# Highbank Reporting Dashboard

Live dashboard for the Highbank private-label flooring program (Carpet / Hard Surface / Tile).
Static site, no build step — reads directly from Supabase.

- **Data:** `hb_lines` table in the `AFS_Adjustments` Supabase project (shared with the
  not-yet-deployed Adjustment Approval app — no schema overlap).
- **Access:** password-gated via a single shared Supabase Auth login
  (`highbank-viewer@afsgroup.local`). Row Level Security restricts `select` on
  `hb_lines`/`hb_refresh_log` to that login only.
- **Methodology:** Highbank-line basis, delivered-sales date, NORMAL service type only,
  bundled-invoice revenue imputed to whole-job margin. See the `highbank-reporting`
  Claude Code skill for the full pipeline this data comes from.

## Refreshing the data

Data is refreshed manually (same rhythm as the Highbank PDF deck) — there is no
scheduled job, and there's no in-app upload (the imputation math needs a full
CSV scan of every line on a job, not just the Highbank ones, so it has to run
where the CSVs are — see the "in-app upload" discussion in project history).

Run from `C:\Users\burme\hb-temp\`, where `build_from_csv.js` and `hb_imputed.js`
(copies of the `highbank-reporting` skill's pipeline scripts) already live
alongside `upload_to_supabase.js` and `refresh.js`:

```powershell
node refresh.js
```

One command, one-time setup: put `SUPABASE_SERVICE_ROLE_KEY=<key>` in a
`.env.local` file in that same folder (never commit it — already gitignored).
`refresh.js` runs the CSV scan, the imputation step, and the Supabase upload
in sequence, stopping on the first failure. Year folders under Full Year Data
(2024, 2025, 2026, …) are auto-detected, so a new year showing up doesn't need
a code change.

Equivalent manual steps, if you ever need to run just one stage:

```powershell
node --max-old-space-size=8192 build_from_csv.js
node --max-old-space-size=4096 hb_imputed.js
node upload_to_supabase.js
```

`upload_to_supabase.js` truncates and re-populates `hb_lines` and writes a row to
`hb_refresh_log` so the dashboard shows a "last refreshed" timestamp.

## Schema setup (one-time, already applied)

The table definitions, RLS policies, and the shared viewer login were created via
`highbank_dashboard_schema.sql` (kept local, not in this repo, since it contains the
gate password in plain text — see `C:\Users\burme\hb-temp\`).
