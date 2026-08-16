// Pushes the highbank-reporting pipeline's line-level output to the
// Highbank Reporting Dashboard's hb_lines table (Supabase project
// gjqcypgbpekddqzjekvh, shared with the not-yet-deployed adjustment-app).
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
// "(NON STOCK COLORS)" / "(STOCK COLOR)" that RFMS appends to style names —
// these aren't part of the product identity, just availability metadata.
// Repeats in case more than one trails the name.
const stripTrailingNotation = (s) => {
  let n = String(s || '').trim();
  let prev;
  do { prev = n; n = n.replace(/\s*\([^()]*\)\s*$/, '').trim(); } while (n !== prev);
  return n || String(s || '').trim();
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
      invoice: L.inv,
      del_year: L.ym ? L.ym.y : null,
      del_month: L.ym ? L.ym.m : null,
      del_date: toDate(job ? job.deliveredDate : null),
      category: L.cat,
      channel: L.bd,
      store: job ? job.store : null,
      style: stripTrailingNotation(L.style),
      supplier: L.sup,
      qty: L.qty,
      cost: L.cost,
      revenue: L.effRev,
      profit: L.effProfit,
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

  const { error: logErr } = await supabase.from('hb_refresh_log').insert({ line_count: rows.length });
  if (logErr) { console.error('Refresh log insert failed:', logErr); process.exit(1); }

  console.log(`Done. Uploaded ${rows.length.toLocaleString()} lines.`);
})();
