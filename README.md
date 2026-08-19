# Stocking Report Dashboard

Live dashboard rolling up every tracked AFS stocking program — Highbank Collection,
AFS Collection, Elevated & Curated, Branded, Wholesale (product program, distinct
from the Wholesale sales channel), and W&P — with drill-down into any one of them
using the same Overall/Carpet/Hard Surface/Tile/Leaderboard views. Static site, no
build step — reads directly from Supabase.

- **Data:** `hb_lines`/`hb_jobs` tables in the `Reporting` Supabase project
  (`gjqcypgbpekddqzjekvh`, shared with the not-yet-deployed Adjustment Approval
  app — no schema overlap). Both tables carry a `program` column; `hb_jobs` has
  one row per (invoice, program) — an invoice touched by more than one program
  appears more than once with identical whole-job totals, so any cross-program
  rollup of `hb_jobs` must dedupe on invoice first (the dashboard's "All
  Programs" view intentionally doesn't use `hb_jobs` at all — see the comment
  above `renderAllPrograms()` in index.html).
- **Access:** password-gated via a single shared Supabase Auth login
  (`highbank-viewer@afsgroup.local`). Row Level Security restricts `select` on
  `hb_lines`/`hb_jobs`/`hb_refresh_log` to that login only.
- **Methodology:** program-line basis, delivered-sales date, NORMAL service type
  only, bundled-invoice revenue imputed to whole-job margin (the same
  imputation math applies to every program — it's invoice-level, not
  program-specific).
- **Program identification:** Highbank Collection and AFS Collection are tagged
  directly on each sales line (`Priv_Collection`), so their program membership
  is historically accurate. Elevated & Curated / Branded / Wholesale / W&P have
  no per-line sales tag — they're matched by looking up the sold Style+Color
  against *today's* `stocking_items` list (the `afs-stocking-positions`
  Supabase project). That means a sale made before an item's current tag was
  set may be classified differently than it would have been at the time — a
  permanent limitation, surfaced as a footnote on those 4 programs' views in
  the dashboard. See `lib/stockingProgramLookup.js` for the exact tagging
  rules and precedence.

## Refreshing the data

Data is refreshed manually (same rhythm as the Highbank PDF deck) — there is no
scheduled job, and there's no in-app upload (the imputation math needs a full
CSV scan of every line on a job, not just the tracked-program ones, so it has
to run where the CSVs are — see the "in-app upload" discussion in project
history).

Run from `C:\Users\burme\hb-temp\`, where `build_from_csv.js`, `hb_imputed.js`,
`upload_to_supabase.js`, `refresh.js`, and the `lib\` folder (`normalizeKey.js`,
`stockingProgramLookup.js`) all need to live **together in the same folder**
(`build_from_csv.js` requires `./lib/...` relative to its own location). This
repo is the source of truth for all five — copy the whole set from here into
`hb-temp` whenever any of them change, rather than editing copies in `hb-temp`
directly:

```powershell
node refresh.js
```

`build_from_csv.js` fetches the current stocking list before scanning any CSVs
and aborts immediately (non-zero exit) if that fetch fails or comes back
empty — a silent failure there would make every Branded/Wholesale/W&P/Elevated
& Curated line quietly lose its program tag while the run still "succeeds." It
also prints a per-program line-count summary at the end of the run; a count
that jumps unexpectedly (especially "no tracked program, STOCK") is the signal
something broke.

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

The `program` column on `hb_lines`/`hb_jobs` (added 2026-08-19, migration
`add_program_column_to_hb_lines_and_hb_jobs`) defaults existing rows to
`'Highbank'` — correct at the time, since both tables had only ever held
Highbank data before the multi-program pipeline existed.
