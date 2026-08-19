// Same normalization used by the stocking-sales-history skill (ported from
// its Python normalize_key()) — strips RFMS label prefixes and parenthetical
// stock-availability notes so a style+color can be matched between the sales
// CSVs and the stocking_items list regardless of those cosmetic differences.
function normalizeKey(style, color) {
  let s = color ? `${style} - ${color}` : String(style || '');
  s = s.replace(/^\*[^*]+\*\s*/, ''); // strip *LABEL* prefixes
  s = s.replace(/\s*\([^)]*\)/g, ''); // strip (STOCK COLORS), (STOCK 1/2/3), (M STOCK), etc.
  s = s.replace(/\s+/g, ' '); // collapse whitespace
  return s.toLowerCase().trim();
}

module.exports = { normalizeKey };
