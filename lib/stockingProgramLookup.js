// Builds the program-membership lookups from the afs-stocking-positions
// Supabase project. Highbank and AFS Collection don't need any of this —
// those are tagged directly on the sales CSV's Priv_Collection column.
// Elevated & Curated / Branded / Wholesale / W&P have no equivalent per-line
// sales tag, so a sale's program membership comes from two sources, checked
// in order:
//   1. The live stocking_items tag (elevated/curated flags, or
//      sidemark=BRANDED + comment). Reflects TODAY's stocking list — a sale
//      made before an item's current tag was set may be classified
//      differently than it would have been at the time. Surfaced as a
//      dashboard footnote, not something this code can fix.
//   2. program_overrides — a manually-confirmed backstop for items whose tag
//      later disappeared/changed, or that were never tagged at all. Only
//      checked when (1) finds nothing, and only applies to sales on/after
//      each override's own effective_start_date — it never reaches back
//      before that date for that item. Entries are added by hand (Scott
//      confirms specific Style+Color+program+start-date combinations); this
//      code never guesses new ones.

const https = require('https');
const { normalizeKey } = require('./normalizeKey');

const SUPABASE_URL = 'https://cxastgqutfcopgxoujek.supabase.co';
// Anon key already used for this exact project by the stocking-sales-history
// skill — RLS confirmed unrestricted read access (no service-role key needed).
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN4YXN0Z3F1dGZjb3BneG91amVrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4MDczNjQsImV4cCI6MjA5NTM4MzM2NH0.NAIEk9tnMcjbWVp5_teuirq-Krl3F0TOxzr539_oOkc';

function httpGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} fetching ${url}: ${data.slice(0, 500)}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Failed to parse JSON from ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

async function fetchAllRows(path, select) {
  const headers = { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` };
  const PAGE = 1000;
  let rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${SUPABASE_URL}/rest/v1/${path}?select=${select}&limit=${PAGE}&offset=${offset}`;
    const page = await httpGetJson(url, headers);
    if (!Array.isArray(page) || page.length === 0) break;
    rows = rows.concat(page);
    if (page.length < PAGE) break;
  }
  return rows;
}

// Precedence confirmed with Scott 2026-08-19: 67 Lewis items are tagged BOTH
// elevated=true AND sidemark=BRANDED/comment=W&P — those count as Elevated &
// Curated, not W&P. So the elevated/curated check always wins regardless of
// what sidemark/comment say.
function programForItem(item) {
  const comment = String(item.comment || '').toUpperCase().trim();
  const sidemark = String(item.sidemark || '').toUpperCase().trim();
  if (item.elevated === true || item.curated === true || comment.includes('E&C')) {
    return 'Elevated & Curated';
  }
  if (sidemark === 'BRANDED') {
    if (comment === 'RETAIL') return 'Branded';
    if (comment === 'WHOLESALE') return 'Wholesale';
    if (comment === 'W&P') return 'W&P';
  }
  // LC ("Last Chance"), PM (Property Management), SUNDRIES, BUILDER, and
  // untagged rows are not tracked programs — excluded per Scott's call.
  return null;
}

// 'YYYY-MM-DD' (what Supabase returns for a `date` column) -> integer
// YYYYMMDD, so it compares directly against the CSV's DelDate field with no
// per-line date parsing in the hot loop.
function dateToYyyymmdd(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).replace(/-/g, '');
  return s.length === 8 ? +s : null;
}

async function buildProgramLookup() {
  const stockingRows = await fetchAllRows('stocking_items', 'style,color,sidemark,comment,elevated,curated');

  if (stockingRows.length === 0) {
    throw new Error(
      'stocking_items fetch returned 0 rows — refusing to build an empty program ' +
      'lookup (this would silently drop every Branded/Wholesale/W&P/Elevated & ' +
      'Curated line from the refresh while still reporting success).'
    );
  }

  // Same-key conflicts (a style+color appearing on more than one stocking_items
  // row with different tags) are resolved here, once, at map-build time —
  // never per CSV line. Elevated & Curated always wins per programForItem's
  // own precedence; for two colliding non-E&C programs, first-seen wins
  // (rare in practice, checked against real data 2026-08-19).
  const tagLookup = new Map();
  for (const item of stockingRows) {
    const program = programForItem(item);
    if (!program) continue;
    const key = normalizeKey(item.style, item.color);
    if (!key) continue;
    if (!tagLookup.has(key) || program === 'Elevated & Curated') {
      tagLookup.set(key, program);
    }
  }

  // program_overrides: manually-confirmed fallback, only consulted when
  // tagLookup has nothing for a given key. Missing/empty table is fine here —
  // unlike stocking_items, there's no expectation this table is ever
  // non-empty, so an empty result isn't a failure signal.
  const overrideRows = await fetchAllRows('program_overrides', 'program,style,color,effective_start_date');
  const overrideLookup = new Map();
  for (const item of overrideRows) {
    const key = normalizeKey(item.style, item.color);
    if (!key || !item.program) continue;
    const startYyyymmdd = dateToYyyymmdd(item.effective_start_date);
    if (startYyyymmdd == null) continue;
    // First-seen-wins on a duplicate key, same as tagLookup — an item should
    // only need one override entry.
    if (!overrideLookup.has(key)) {
      overrideLookup.set(key, { program: item.program, startYyyymmdd });
    }
  }

  return { tagLookup, overrideLookup };
}

module.exports = { buildProgramLookup, programForItem };
