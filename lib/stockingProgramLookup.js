// Builds a normalizedStyleColorKey -> program name map from the live
// stocking_items list (afs-stocking-positions Supabase project). Highbank and
// AFS Collection don't need this lookup — those are tagged directly on the
// sales CSV's Priv_Collection column. Elevated & Curated / Branded /
// Wholesale / W&P have no equivalent per-line sales tag, so the only way to
// know which program a historical sale belongs to is to match its Style+Color
// against TODAY's stocking list. That's a real, permanent limitation (a sale
// made before an item's current tag was set may be classified differently
// than it would have been at the time) — surfaced as a dashboard footnote,
// not something this code can fix.

const https = require('https');
const { normalizeKey } = require('./normalizeKey');

const SUPABASE_URL = 'https://cxastgqutfcopgxoujek.supabase.co';
// Anon key already used for this exact table by the stocking-sales-history
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

async function buildProgramLookup() {
  const headers = { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` };
  const PAGE = 1000;
  let rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${SUPABASE_URL}/rest/v1/stocking_items?select=style,color,sidemark,comment,elevated,curated&limit=${PAGE}&offset=${offset}`;
    const page = await httpGetJson(url, headers);
    if (!Array.isArray(page) || page.length === 0) break;
    rows = rows.concat(page);
    if (page.length < PAGE) break;
  }

  if (rows.length === 0) {
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
  const map = new Map();
  for (const item of rows) {
    const program = programForItem(item);
    if (!program) continue;
    const key = normalizeKey(item.style, item.color);
    if (!key) continue;
    if (!map.has(key) || program === 'Elevated & Curated') {
      map.set(key, program);
    }
  }

  return map;
}

module.exports = { buildProgramLookup, programForItem };
