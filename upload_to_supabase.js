// Pushes the stocking-programs pipeline's line-level output — every tracked
// program (Highbank, AFS Collection, Elevated & Curated, Branded, Wholesale,
// W&P), not just Highbank — to the Stocking Report Dashboard's hb_lines/
// hb_jobs tables (Supabase project gjqcypgbpekddqzjekvh, shared with the
// not-yet-deployed adjustment-app).
//
// Run after the normal pipeline (build_from_csv.js -> hb_imputed.js) has
// produced hb_imputed.json + consolidated_normal.json in this folder.
//
// Requires env var SUPABASE_SERVICE_ROLE_KEY (never commit this key).
// Usage (PowerShell):
//   $env:SUPABASE_SERVICE_ROLE_KEY = "..."
//   node upload_to_supabase.js

const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://gjqcypgbpekddqzjekvh.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_SERVICE_ROLE_KEY env var.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Strips trailing inventory-availability notations like "(STOCK)" /
// "(NON STOCK COLORS)" / "(M STOCK) <garbled encoding artifact>" that RFMS
// appends to style/color names — these aren't part of the product identity,
// just availability metadata. Everything from the first "(" onward is
// dropped (some notations have extra text, sometimes mis-encoded, trailing
// the closing paren, so trimming only a well-formed "(...)" isn't enough).
const stripTrailingNotation = (s) => {
  const raw = String(s || '').trim();
  const n = raw.replace(/\s*\(.*$/, '').trim();
  return n || raw;
};

// Same cleanup as stripTrailingNotation, but for colors: a "(NON STOCKING)" /
// "(NON STOCK)" notation isn't dropped silently — it's a real signal (this
// color must be special-ordered), so it's kept as a trailing "*" instead of
// being erased. Plain availability notations like "(STOCK 1/2/3/5)" (which
// store numbers carry it) still get dropped — only the non-stock flag survives.
const cleanColor = (s) => {
  const raw = String(s || '').trim();
  const isNonStock = /\(\s*NON[\s-]?STOCK/i.test(raw);
  const n = raw.replace(/\s*\(.*$/, '').trim() || raw;
  return isNonStock ? '*' + n : n;
};

// RFMS exports the same store inconsistently zero-padded across periods
// ("1" in some months, "001" in others) — normalize to 3 digits so they
// don't fragment into duplicate "stores" in any store-level breakdown.
const normalizeStore = (s) => {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? String(n).padStart(3, '0') : (s || null);
};

const toDate = (yyyymmdd) => {
  if (yyyymmdd == null) return null;
  const s = String(yyyymmdd);
  if (s.length !== 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
};

(async () => {
  const imputed = JSON.parse(fs.readFileSync('C:\\Users\\burme\\hb-temp\\hb_imputed.json', 'utf8'));
  const jobs = JSON.parse(fs.readFileSync('C:\\Users\\burme\\hb-temp\\consolidated_normal.json', 'utf8'));

  const jobByInv = new Map();
  for (const j of jobs) jobByInv.set(j.invoice, j);

  const rows = imputed.lines.map((L) => {
    const job = jobByInv.get(L.inv);
    return {
      program: L.program,
      invoice: L.inv,
      del_year: L.ym ? L.ym.y : null,
      del_month: L.ym ? L.ym.m : null,
      del_date: toDate(job ? job.deliveredDate : null),
      category: L.cat,
      channel: L.bd,
      store: job ? normalizeStore(job.store) : null,
      style: L.qs ? '*' + stripTrailingNotation(L.style) : stripTrailingNotation(L.style),
      color: cleanColor(L.color),
      supplier: L.sup,
      salesperson: L.salesperson,
      qty: L.qty,
      cost: L.cost,
      revenue: L.effRev,
      profit: L.effProfit,
      unloaded_cost: L.unloadedCost,
      unloaded_revenue: L.unloadedEffRev,
      unloaded_profit: L.unloadedEffProfit,
      is_imputed: L.isImputed,
    };
  }).filter((r) => r.del_year != null && r.del_month != null);

  console.log(`Prepared ${rows.length.toLocaleString()} rows (of ${imputed.lines.length.toLocaleString()} lines; dropped ${imputed.lines.length - rows.length} with no period).`);

  console.log('Clearing existing hb_lines rows...');
  const { error: delErr } = await supabase.from('hb_lines').delete().neq('id', 0);
  if (delErr) { console.error('Delete failed:', delErr); process.exit(1); }

  const BATCH = 1000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supabase.from('hb_lines').insert(batch);
    if (error) { console.error(`Insert failed at row ${i}:`, error); process.exit(1); }
    process.stdout.write(`\r  inserted ${Math.min(i + BATCH, rows.length).toLocaleString()} / ${rows.length.toLocaleString()}`);
  }
  console.log('');

  // hb_jobs: whole-invoice totals for every program-touched NORMAL invoice —
  // the "total revenue of all sales on an invoice with [program] on it" view,
  // as opposed to hb_lines' program-line-only figures.
  //
  // One row per (invoice, program): consolidated_normal.json now has an entry
  // per program touching an invoice, each with that program's own
  // dominant_category (computed from just that program's lines) but IDENTICAL
  // job_revenue/job_cost/etc (the whole-job totals don't depend on which
  // program you're viewing). This lets the dashboard's per-program "flip to
  // whole-job view" KPI just filter WHERE program = X exactly like hb_lines —
  // the tradeoff is a shared invoice appears more than once in this table, so
  // any cross-program rollup MUST dedupe on invoice before summing, or it
  // double-counts every invoice touched by more than one program.
  const jobRows = jobs.map((j) => {
    const dd = j.deliveredDate ? String(j.deliveredDate) : null;
    return {
      program: j.program,
      invoice: j.invoice,
      del_year: dd ? +dd.slice(0, 4) : null,
      del_month: dd ? +dd.slice(4, 6) : null,
      del_date: toDate(j.deliveredDate),
      dominant_category: j.dominantCat,
      channel: j.bigDiv,
      store: normalizeStore(j.store),
      job_revenue: j.jobRevenue,
      job_cost: j.jobCost,
      job_unloaded_cost: j.jobUnloadedCost,
      job_profit: j.jobProfit,
      job_qty: j.jobQty,
      bundled_line_count: j.bundledLines,
    };
  }).filter((r) => r.del_year != null && r.del_month != null);

  console.log(`Prepared ${jobRows.length.toLocaleString()} job rows (of ${jobs.length.toLocaleString()} invoices).`);
  console.log('Clearing existing hb_jobs rows...');
  const { error: delJobsErr } = await supabase.from('hb_jobs').delete().neq('id', 0);
  if (delJobsErr) { console.error('Delete failed:', delJobsErr); process.exit(1); }

  for (let i = 0; i < jobRows.length; i += BATCH) {
    const batch = jobRows.slice(i, i + BATCH);
    const { error } = await supabase.from('hb_jobs').insert(batch);
    if (error) { console.error(`Insert failed at row ${i}:`, error); process.exit(1); }
    process.stdout.write(`\r  inserted ${Math.min(i + BATCH, jobRows.length).toLocaleString()} / ${jobRows.length.toLocaleString()}`);
  }
  console.log('');

  // pc_totals: market-wide (every supplier) Carpet/Hard Surface/Tile totals
  // by year/month/category/channel — the denominator for "Highbank's share
  // of the whole category," not just share of Highbank's own totals.
  const pcTotals = JSON.parse(fs.readFileSync('C:\\Users\\burme\\hb-temp\\pc_totals.json', 'utf8'));
  const pcTotalRows = pcTotals.map((t) => ({
    del_year: t.year,
    del_month: t.month,
    category: t.category,
    channel: t.channel,
    total_cost: t.cost,
    total_revenue: t.revenue,
    total_qty: t.qty,
  }));

  console.log(`Prepared ${pcTotalRows.length.toLocaleString()} pc_totals rows.`);
  console.log('Clearing existing pc_totals rows...');
  const { error: delPcErr } = await supabase.from('pc_totals').delete().neq('id', 0);
  if (delPcErr) { console.error('Delete failed:', delPcErr); process.exit(1); }

  for (let i = 0; i < pcTotalRows.length; i += BATCH) {
    const batch = pcTotalRows.slice(i, i + BATCH);
    const { error } = await supabase.from('pc_totals').insert(batch);
    if (error) { console.error(`Insert failed at row ${i}:`, error); process.exit(1); }
    process.stdout.write(`\r  inserted ${Math.min(i + BATCH, pcTotalRows.length).toLocaleString()} / ${pcTotalRows.length.toLocaleString()}`);
  }
  console.log('');

  const { error: logErr } = await supabase.from('hb_refresh_log').insert({ line_count: rows.length });
  if (logErr) { console.error('Refresh log insert failed:', logErr); process.exit(1); }

  console.log(`Done. Uploaded ${rows.length.toLocaleString()} lines, ${jobRows.length.toLocaleString()} jobs, and ${pcTotalRows.length.toLocaleString()} market-total buckets.`);
})();
