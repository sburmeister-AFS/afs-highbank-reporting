// Single-pass pipeline: streams year CSVs only (no HBC workbook).
// Produces every artifact the deck needs, for every tracked stocking program.
//
// Filters: ServiceType = NORMAL only.
// Program resolution, first match wins:
//   1. Priv_Collection contains "HIGHBANK"      -> Highbank
//   2. Priv_Collection === "AFS COLLECTION"      -> AFS Collection
//   3. Style+Color match against today's stocking_items list (elevated/curated
//      flags, or sidemark=BRANDED + comment) -> Elevated & Curated / Branded /
//      Wholesale / W&P. See lib/stockingProgramLookup.js for the exact rules
//      and the historical-accuracy caveat this implies for these 4 programs.
//   else -> not a tracked program, line is skipped from program-level output
//      (still counted in whole-job/market-wide totals below, same as always).
//
// Outputs:
//   consolidated_normal.json — per (program, invoice): whole-job totals + per-cat program cost/qty/profit + delivered date
//   hb_meta_normal.json      — per (program, invoice): dominantCat, bigDiv, supplier/style mix per category
//   bundled.json             — invoice -> bundled line count (cost > 0 AND lineTotal = 0), program-agnostic
//   hb_lines_normal.json     — array of NORMAL lines across every tracked program (consumed by hb_imputed.js)
//   pc_totals.json           — market-wide (every supplier) Carpet/HS/Tile totals, program-agnostic

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const { buildProgramLookup } = require('./lib/stockingProgramLookup');
const { normalizeKey } = require('./lib/normalizeKey');

const YEARS_BASE = 'C:\\Users\\burme\\OneDrive - AFS Group\\Purchasing Manager\\Reports\\Sales Reports\\Full Year Data';
const OUT_DIR = 'C:\\Users\\burme\\hb-temp';

// PC 13 (rubber — a different material), 25/29 (thresholds/T-mold/stair
// tread — installation accessories, not flooring product), and anything
// else outside this set are excluded from category reporting entirely
// (confirmed 2026-08-16) — they still count toward the whole-job
// revenue/cost used for bundled-invoice imputation (that accumulation
// happens before this categorization, for every line regardless of PC).
const catFor = (pc) => {
  const p = +pc;
  if (p === 1) return 'Carpet';
  if (p === 6 || p === 10) return 'Hard Surface';
  if (p === 22) return 'Tile';
  return null;
};
const ymOf = (n) => {
  if (n == null || n === '') return null;
  const s = String(n);
  if (s.length !== 8) return null;
  return { y: +s.slice(0, 4), m: +s.slice(4, 6) };
};
const normalize = (s) => {
  let n = String(s || '').trim();
  // Leading bracketed notations, e.g. "*INVENTORY ONLY* ADVENTURE" -> "ADVENTURE".
  n = n.replace(/^\*[^*]*\*\s*/, '');
  // Trailing notations. Looped: some raw values stack more than one (e.g.
  // "CHANNEL 8\"X60\" 20MIL *NEW* (STOCK COLORS)") — a single pass only
  // strips the outermost one and leaves the rest exposed.
  let prev;
  do {
    prev = n;
    n = n.replace(/\s*\*NEW\*?\s*$/i, '');
    n = n.replace(/\s+UNILIN\s*$/i, '');
    n = n.replace(/\s*\(QUICKSHIP\)\s*$/i, '');
    n = n.replace(/\s*\(QS\)\s*$/i, '');
    n = n.replace(/\s*\(STOCK COLORS\)\s*$/i, '');
    n = n.replace(/\s*\(M STOCK\)\s*$/i, '');
    n = n.trim();
  } while (n !== prev);
  return n;
};

// JobType → Big Division mapping (Big Division is a workbook-derived field; we
// reproduce it from JobType here so we can stay on CSV-only data).
// RETAIL INSTALL / RETAIL MAT ONLY / SHOP AT HOME all roll up to RETAIL.
// All other JobTypes pass through unchanged.
const jobTypeToBigDiv = (jt) => {
  const t = String(jt || '').trim().toUpperCase();
  if (!t) return '(none)';
  if (t === 'RETAIL INSTALL' || t === 'RETAIL MAT ONLY' || t === 'SHOP AT HOME') return 'RETAIL';
  return t;
};

// Resolves which tracked stocking program (if any) a sales line belongs to.
// Precedence: Priv_Collection-tagged programs (historically accurate, no
// lookup needed) beat the stocking-list JOIN (today's-snapshot based, the
// only option for programs with no per-line sales tag).
const programForRow = (row, programLookup) => {
  const privCollection = String(row['Priv_Collection'] || '').toUpperCase().trim();
  if (privCollection.includes('HIGHBANK')) return 'Highbank';
  if (privCollection === 'AFS COLLECTION') return 'AFS Collection';
  const key = normalizeKey(row['StyleItem'], row['ColorDesc']);
  return programLookup.get(key) || null;
};

// All invoices (limited to NORMAL lines) — we only retain program-touched ones at the end
const jobAgg = new Map(); // inv -> { revenue, cost, profit, qty, lines, bundledLines }
const invMeta = new Map(); // "${program}|${inv}" -> meta
const programLines = [];

// Market-wide totals for PC 1/6/10/22 (Carpet/Hard Surface/Tile) — every
// supplier, not just tracked programs — by year/month/category/channel.
// Answers "what % of all Carpet/HS/Tile COGS in this channel is [program]" as
// opposed to "what % of [program]'s own COGS is in this channel" (those are
// different denominators — program lines alone can only answer the second one).
const pcTotalAgg = new Map(); // "y-m-cat-bd" -> { cost, revenue, qty }

// Deduplication: some CSV exports (notably may26all.csv, june26all.csv) contain the
// same (Invoice_Num, LineNum) row exported multiple times. Track seen keys and
// silently drop repeats.
const seenKeys = new Set();
let dupSkipped = 0;

// Per-program line counts, printed at the end — the only sanity check
// available for a manual run. A count that jumps unexpectedly (especially
// "no tracked program") is the signal something in the lookup broke.
const programLineCounts = new Map();
let noProgramStockCount = 0; // NORMAL lines with Priv_Collection = STOCK (or similar) that matched no tracked program

// Auto-detect year folders (rather than a hardcoded list) so a new year
// showing up under Full Year Data — e.g. 2027 — is picked up without a
// code change.
const years = fs.readdirSync(YEARS_BASE)
  .filter(name => /^\d{4}$/.test(name) && fs.statSync(path.join(YEARS_BASE, name)).isDirectory())
  .sort();
const csvFiles = [];
for (const y of years) {
  const dir = path.join(YEARS_BASE, y);
  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.csv'));
  files.forEach(f => csvFiles.push({ year: y, file: path.join(dir, f), name: f }));
}

const processFile = (cfg, programLookup) => new Promise((resolve, reject) => {
  let total = 0, normal = 0, tracked = 0;
  const parser = parse({ columns: true, relax_quotes: true, relax_column_count: true, skip_empty_lines: true });
  fs.createReadStream(cfg.file)
    .pipe(parser)
    .on('data', (row) => {
      total++;
      if (String(row['ServiceType'] || '').trim() !== 'NORMAL') return;
      normal++;
      const inv = row['Invoice_Num'];
      if (!inv) return;

      // Dedup: skip if we've already ingested this (invoice, lineNum) pair
      const lineNum = row['LineNum'];
      const key = inv + '|' + lineNum;
      if (seenKeys.has(key)) { dupSkipped++; return; }
      seenKeys.add(key);

      const cost = +row['TotalCost'] || 0;
      // Unloaded cost: UnitCost excludes OCFrt/OCLoad/OCOverhead, which
      // TotalCost includes — confirmed exactly via TotalCost = (UnitCost +
      // OCFrt + OCLoad + OCOverhead) * Qty on 12,304/12,304 HB lines.
      const unitCost = +row['UnitCost'] || 0;
      const qty = +row['Qty'] || 0;
      const unloadedCost = unitCost * qty;
      const lt = +row['LineTotal'] || 0;
      const profit = +row['Profit'] || 0;
      const ddRaw = row['DelDate'];
      const dd = ddRaw ? +ddRaw : null;
      const isBundled = cost > 0 && lt === 0;

      // Job aggregate (every NORMAL line, regardless of program) — unchanged,
      // program-agnostic, feeds bundled-invoice imputation for every program.
      let j = jobAgg.get(inv);
      if (!j) { j = { revenue: 0, cost: 0, unloadedCost: 0, profit: 0, qty: 0, lines: 0, bundledLines: 0 }; jobAgg.set(inv, j); }
      j.revenue += lt;
      j.cost += cost;
      j.unloadedCost += unloadedCost;
      j.profit += profit;
      j.qty += qty;
      j.lines++;
      if (isBundled) j.bundledLines++;

      // Market-wide PC 1/6/10/22 totals — every supplier, computed for every
      // NORMAL line regardless of program. Unchanged.
      const marketCat = catFor(+row['PC']);
      if (marketCat && dd) {
        const ym = ymOf(dd);
        if (ym) {
          const marketBd = jobTypeToBigDiv(row['JobType']);
          const key = `${ym.y}-${ym.m}-${marketCat}-${marketBd}`;
          let mt = pcTotalAgg.get(key);
          if (!mt) { mt = { year: ym.y, month: ym.m, category: marketCat, channel: marketBd, cost: 0, revenue: 0, qty: 0 }; pcTotalAgg.set(key, mt); }
          mt.cost += cost;
          mt.revenue += lt;
          mt.qty += qty;
        }
      }

      // Program-specific accumulation
      const program = programForRow(row, programLookup);
      if (!program) {
        const priv = String(row['Priv_Collection'] || '').toUpperCase().trim();
        if (priv === 'STOCK' || priv === '') noProgramStockCount++;
        return;
      }
      tracked++;
      programLineCounts.set(program, (programLineCounts.get(program) || 0) + 1);

      const pc = +row['PC'];
      const cat = catFor(pc);
      if (!cat) return; // PC outside 1/6/10/22 — excluded from category reporting

      const bd = jobTypeToBigDiv(row['JobType']);
      const sup = row['Supplier'] || '(none)';
      const styleRaw = row['Stripped Style'] || row['StyleItem'] || '(unknown)';
      const isQuickShip = /\(\s*QUICK\s*SHIP\s*\)|\(\s*QS\s*\)/i.test(styleRaw);
      const style = normalize(styleRaw);
      const color = normalize(row['ColorDesc'] || '(none)');
      const salesperson = (row['Salesperson'] || '(none)').trim();

      programLines.push({ program, inv, ym: ymOf(dd), cat, bd, sup, style, color, qs: isQuickShip, salesperson, qty, cost, unloadedCost, lineTotal: lt, profit });

      const invKey = `${program}|${inv}`;
      let m = invMeta.get(invKey);
      if (!m) {
        m = {
          program, invoice: inv,
          catCost: { Carpet: 0, 'Hard Surface': 0, Tile: 0 },
          catQty:  { Carpet: 0, 'Hard Surface': 0, Tile: 0 },
          catProfit: { Carpet: 0, 'Hard Surface': 0, Tile: 0 },
          bigDivCost: {},
          supCost: { Carpet: {}, 'Hard Surface': {}, Tile: {} },
          styleByCat: { Carpet: new Map(), 'Hard Surface': new Map(), Tile: new Map() },
          deliveredDate: null,
          store: row['Store'],
        };
        invMeta.set(invKey, m);
      }
      m.catCost[cat] += cost;
      m.catQty[cat] += qty;
      m.catProfit[cat] += profit;
      m.bigDivCost[bd] = (m.bigDivCost[bd] || 0) + cost;
      m.supCost[cat][sup] = (m.supCost[cat][sup] || 0) + cost;
      const sm = m.styleByCat[cat];
      let e = sm.get(style);
      if (!e) { e = { qty: 0, cost: 0, profit: 0 }; sm.set(style, e); }
      e.qty += qty; e.cost += cost; e.profit += profit;
      if (dd != null && (m.deliveredDate == null || dd > m.deliveredDate)) m.deliveredDate = dd;
    })
    .on('end', () => {
      console.log(`  ${cfg.year}/${cfg.name}: ${total.toLocaleString()} rows -> ${normal.toLocaleString()} NORMAL -> ${tracked.toLocaleString()} program-tracked`);
      resolve();
    })
    .on('error', reject);
});

(async () => {
  console.log('Fetching current stocking_items list to build the program lookup...');
  const programLookup = await buildProgramLookup(); // throws (and aborts the run) if this comes back empty
  console.log(`Program lookup built: ${programLookup.size.toLocaleString()} style+color keys mapped.`);

  console.log(`Streaming ${csvFiles.length} CSV files (NORMAL only)...`);
  for (const cfg of csvFiles) await processFile(cfg, programLookup);
  console.log(`\nDuplicate rows skipped   : ${dupSkipped.toLocaleString()}`);
  console.log(`All invoices seen        : ${jobAgg.size.toLocaleString()}`);
  console.log('\nProgram-tracked NORMAL lines by program:');
  for (const [program, count] of [...programLineCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${program.padEnd(20)} ${count.toLocaleString()}`);
  }
  console.log(`  ${'(no tracked program, STOCK)'.padEnd(20)} ${noProgramStockCount.toLocaleString()}`);
  console.log(`Program-touched (invoice, program) pairs: ${invMeta.size.toLocaleString()}`);

  // Compute dominant Big Division and dominant Category per (program, invoice)
  for (const [, m] of invMeta) {
    let bd = '(none)', max = -Infinity;
    for (const [k, v] of Object.entries(m.bigDivCost)) if (v > max) { max = v; bd = k; }
    m.bigDiv = bd;
    let dc = 'Carpet'; max = -Infinity;
    for (const c of ['Carpet', 'Hard Surface', 'Tile']) if (m.catCost[c] > max) { max = m.catCost[c]; dc = c; }
    m.dominantCat = dc;
  }

  // consolidated_normal.json — one entry per (program, invoice)
  const consolidated = [];
  let withBundling = 0;
  for (const [, meta] of invMeta) {
    const j = jobAgg.get(meta.invoice);
    if (j.bundledLines > 0) withBundling++;
    consolidated.push({
      program: meta.program,
      invoice: meta.invoice,
      orderDate: null,
      store: meta.store,
      dominantCat: meta.dominantCat,
      bigDiv: meta.bigDiv,
      hbCostByCat: meta.catCost,
      hbQtyByCat: meta.catQty,
      hbProfitByCat: meta.catProfit,
      hbCostThisInv: Object.values(meta.catCost).reduce((s, v) => s + v, 0),
      jobRevenue: j.revenue,
      jobCost: j.cost,
      jobUnloadedCost: j.unloadedCost,
      jobProfit: j.profit,
      jobQty: j.qty,
      jobLines: j.lines,
      bundledLines: j.bundledLines,
      deliveredDate: meta.deliveredDate,
    });
  }
  fs.writeFileSync(`${OUT_DIR}\\consolidated_normal.json`, JSON.stringify(consolidated));
  console.log(`Wrote consolidated_normal.json (${consolidated.length} program-touched invoice rows, ${withBundling} with bundling)`);

  // hb_meta_normal.json — keyed by "${program}|${invoice}"
  const metaOut = {};
  for (const [invKey, m] of invMeta) {
    metaOut[invKey] = {
      program: m.program,
      invoice: m.invoice,
      dominantCat: m.dominantCat,
      bigDiv: m.bigDiv,
      catCost: m.catCost,
      catQty: m.catQty,
      catProfit: m.catProfit,
      supCost: m.supCost,
      styleByCat: {
        Carpet: Object.fromEntries(m.styleByCat.Carpet),
        'Hard Surface': Object.fromEntries(m.styleByCat['Hard Surface']),
        Tile: Object.fromEntries(m.styleByCat.Tile),
      },
      deliveredDate: m.deliveredDate,
    };
  }
  fs.writeFileSync(`${OUT_DIR}\\hb_meta_normal.json`, JSON.stringify(metaOut));
  console.log('Wrote hb_meta_normal.json');

  // bundled.json — invoice -> bundled line count (program-agnostic, whole-job fact)
  const bundled = {};
  for (const [inv, j] of jobAgg) {
    if (j.bundledLines > 0) bundled[inv] = j.bundledLines;
  }
  fs.writeFileSync(`${OUT_DIR}\\bundled.json`, JSON.stringify(bundled));
  console.log(`Wrote bundled.json (${Object.keys(bundled).length} invoices with bundling)`);

  // hb_lines_normal.json — every tracked program's lines, for hb_imputed.js
  fs.writeFileSync(`${OUT_DIR}\\hb_lines_normal.json`, JSON.stringify(programLines));
  console.log(`Wrote hb_lines_normal.json (${programLines.length.toLocaleString()} program-tracked NORMAL lines)`);

  // pc_totals.json — market-wide (every supplier) Carpet/Hard Surface/Tile
  // totals by year/month/channel, program-agnostic, unchanged.
  const pcTotals = [...pcTotalAgg.values()];
  fs.writeFileSync(`${OUT_DIR}\\pc_totals.json`, JSON.stringify(pcTotals));
  console.log(`Wrote pc_totals.json (${pcTotals.length.toLocaleString()} year/month/category/channel buckets)`);

  console.log('\nDone. All artifacts derived from year CSVs only — no HBC workbook required.');
})().catch((err) => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
