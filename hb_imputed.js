// Line aggregation with revenue imputation, across every tracked stocking
// program (not just Highbank).
// Inputs come from build_from_csv.js — no HBC workbook needed.
//
// Imputation rule: invoice has bundled billing (≥1 line with cost > 0 AND lineTotal = 0)
//   → restate every line on that invoice using whole-job ratio:
//      imputed_rev    = TotalCost × (whole_job_rev / whole_job_cost)
//      imputed_profit = imputed_rev − TotalCost
// This is invoice/job-level math — identical regardless of which program a
// line belongs to, so it needed no changes beyond carrying `program` through.

const fs = require('fs');

const jobs = JSON.parse(fs.readFileSync('C:\\Users\\burme\\hb-temp\\consolidated_normal.json', 'utf8'));
const bundled = JSON.parse(fs.readFileSync('C:\\Users\\burme\\hb-temp\\bundled.json', 'utf8'));
const lines = JSON.parse(fs.readFileSync('C:\\Users\\burme\\hb-temp\\hb_lines_normal.json', 'utf8'));

// consolidated_normal.json now has one entry per (program, invoice) — job
// totals (jobRevenue/jobCost/etc) are identical across every program sharing
// an invoice, so first-seen-wins is correct here; we only need them once per
// invoice.
const jobByInv = new Map();
for (const j of jobs) {
  if (!jobByInv.has(j.invoice)) jobByInv.set(j.invoice, j);
}

const cats = ['Carpet', 'Hard Surface', 'Tile', 'Carpet Tile', 'Rolled Goods'];
const fmt$ = (n) => '$' + Math.round(n).toLocaleString();

let total = 0, imputed = 0, invsWithBundling = 0, invsSeen = new Set();
let sumCost = 0, sumActualRev = 0, sumActualProfit = 0;
let sumEffRev = 0, sumEffProfit = 0;
const byProgram = new Map(); // program -> { lines, cost, actualRev, actualProfit, effRev, effProfit }

const out = [];
lines.forEach(L => {
  total++;
  const inv = L.inv;
  const cost = +L.cost || 0;
  const unloadedCost = +L.unloadedCost || 0;
  const lineTotal = +L.lineTotal || 0;
  const profit = +L.profit || 0;

  sumCost += cost;
  sumActualRev += lineTotal;
  sumActualProfit += profit;

  const hasBundling = !!bundled[inv];
  const job = jobByInv.get(inv);
  if (!invsSeen.has(inv)) { invsSeen.add(inv); if (hasBundling) invsWithBundling++; }

  // Revenue is estimated once (loaded basis, the approved methodology) and
  // does NOT change with the cost-basis toggle — only cost does, and profit
  // falls out of revenue minus whichever cost is selected. Recomputing a
  // second "unloaded-margin" revenue estimate was wrong: there's one true
  // revenue estimate per line, not one per cost basis.
  let effRev = lineTotal, effProfit = profit, isImputed = false;
  if (hasBundling && job && job.jobRevenue > 0 && job.jobCost > 0) {
    const ratio = job.jobRevenue / job.jobCost;
    effRev = cost * ratio;
    effProfit = effRev - cost;
    imputed++;
    isImputed = true;
  }
  const unloadedEffRev = effRev;
  const unloadedEffProfit = effRev - unloadedCost;
  sumEffRev += effRev;
  sumEffProfit += effProfit;

  let bp = byProgram.get(L.program);
  if (!bp) { bp = { lines: 0, cost: 0, actualRev: 0, actualProfit: 0, effRev: 0, effProfit: 0 }; byProgram.set(L.program, bp); }
  bp.lines++; bp.cost += cost; bp.actualRev += lineTotal; bp.actualProfit += profit;
  bp.effRev += effRev; bp.effProfit += effProfit;

  out.push({
    program: L.program,
    inv, ym: L.ym, cat: L.cat, bd: L.bd, sup: L.sup, style: L.style, color: L.color, qs: L.qs,
    salesperson: L.salesperson,
    qty: L.qty, cost, unloadedCost, lineTotal, profit, effRev, effProfit,
    unloadedEffRev, unloadedEffProfit, isImputed,
  });
});

console.log(`Program-tracked NORMAL lines: ${total.toLocaleString()}`);
console.log(`Invoices with bundling: ${invsWithBundling.toLocaleString()} of ${invsSeen.size.toLocaleString()} program-touched invoices (${(invsWithBundling/invsSeen.size*100).toFixed(1)}%)`);
console.log(`Lines on bundled invoices (imputed): ${imputed.toLocaleString()} (${(imputed/total*100).toFixed(1)}%)`);
console.log(`Lines on clean invoices (actual)   : ${(total - imputed).toLocaleString()}`);
console.log('');
console.log(`Sum Cost                             : ${fmt$(sumCost)}`);
console.log(`Sum actual LineTotal                 : ${fmt$(sumActualRev)}`);
console.log(`Sum actual Profit                    : ${fmt$(sumActualProfit)}`);
console.log(`Sum effective revenue (imputed)      : ${fmt$(sumEffRev)}`);
console.log(`Sum effective profit                 : ${fmt$(sumEffProfit)}`);
console.log(`Imputation impact on revenue         : ${fmt$(sumEffRev - sumActualRev)}`);
console.log(`Imputation impact on profit          : ${fmt$(sumEffProfit - sumActualProfit)}`);
console.log(`Margin (actual basis, all dates)     : ${(sumActualProfit / sumActualRev * 100).toFixed(1)}%`);
console.log(`Margin (imputed basis, all dates)    : ${(sumEffProfit / sumEffRev * 100).toFixed(1)}%`);

console.log('\n=== BY PROGRAM (imputed basis, all dates) ===');
for (const [program, bp] of [...byProgram.entries()].sort((a, b) => b[1].effRev - a[1].effRev)) {
  const m = bp.effRev > 0 ? (bp.effProfit / bp.effRev * 100).toFixed(1) : '–';
  console.log(`  ${program.padEnd(20)} lines=${String(bp.lines).padStart(6)}  Rev=${fmt$(bp.effRev).padStart(13)}  COGS=${fmt$(bp.cost).padStart(11)}  Profit=${fmt$(bp.effProfit).padStart(11)}  Margin=${m}%`);
}

const periods = {
  '2024 FY':   (ym) => ym && ym.y === 2024,
  '2025 FY':   (ym) => ym && ym.y === 2025,
  '2026 YTD':  (ym) => ym && ym.y === 2026 && ym.m <= 5,
  '2025 YTD':  (ym) => ym && ym.y === 2025 && ym.m <= 5,
};

console.log('\n=== ALL PROGRAMS COMBINED — LINE TOTALS (delivered, NORMAL) ===');
for (const [bn, fn] of Object.entries(periods)) {
  console.log(`\n--- ${bn} ---`);
  const agg = {};
  cats.forEach(c => agg[c] = { rev: 0, cost: 0, profit: 0, qty: 0, lines: 0, jobs: new Set() });
  out.forEach(L => {
    if (!fn(L.ym)) return;
    const a = agg[L.cat];
    a.rev += L.effRev; a.cost += L.cost; a.profit += L.effProfit; a.qty += L.qty; a.lines++; a.jobs.add(L.inv);
  });
  let tR=0, tC=0, tP=0, tL=0;
  for (const c of cats) {
    const a = agg[c];
    const m = a.rev > 0 ? (a.profit / a.rev * 100).toFixed(1) : '–';
    console.log(`  ${c.padEnd(13)} lines=${String(a.lines).padStart(5)} jobs=${a.jobs.size.toString().padStart(5)}  Rev=${fmt$(a.rev).padStart(13)}  COGS=${fmt$(a.cost).padStart(11)}  Profit=${fmt$(a.profit).padStart(11)}  Margin=${m}%`);
    tR+=a.rev; tC+=a.cost; tP+=a.profit; tL+=a.lines;
  }
  const tM = tR > 0 ? (tP / tR * 100).toFixed(1) : '–';
  console.log(`  ${'TOTAL'.padEnd(13)} lines=${String(tL).padStart(5)}              Rev=${fmt$(tR).padStart(13)}  COGS=${fmt$(tC).padStart(11)}  Profit=${fmt$(tP).padStart(11)}  Margin=${tM}%`);
}

fs.writeFileSync('C:\\Users\\burme\\hb-temp\\hb_imputed.json', JSON.stringify({
  summary: { totalLines: total, imputed, invsWithBundling, sumCost, sumActualRev, sumActualProfit, sumEffRev, sumEffProfit },
  lines: out,
}));
console.log('\nWrote hb_imputed.json');
