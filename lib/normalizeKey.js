// Same normalization used by the stocking-sales-history skill (ported from
// its Python normalize_key()) — strips RFMS label prefixes and parenthetical
// stock-availability notes so a style+color can be matched between the sales
// CSVs and the stocking_items list regardless of those cosmetic differences.
function normalizeKey(style, color) {
  // RFMS sometimes appends a dye-lot code to the sold color (e.g. "BARLEY
  // OAK-H" for the same physical color as stocking_items' plain "BARLEY
  // OAK") — confirmed 2026-08-21 that no real stocking_items color ends in
  // this pattern, so it's safe to strip before matching rather than let
  // lot-coded sales silently fail to tag to a program.
  // RFMS also sometimes appends a trailing "<em/en dash> <1-4 char tag>"
  // (e.g. "GRAY-DARK — ST") to a color that's already been through the
  // (STOCK ...) paren-strip below — the same "— ST" quirk already fixed for
  // the inventory-matching pipeline (see [[project_stocking_app_inventory_matching]]
  // in memory), applied here too since it breaks this pipeline's matching
  // the same way.
  const cleanedColor = color
    ? String(color).replace(/-[A-Za-z]{1,2}$/, '').replace(/\s*[—–]\s*[A-Za-z0-9]{1,4}$/, '')
    : color;
  let s = color ? `${style} - ${cleanedColor}` : String(style || '');
  s = s.replace(/^\*[^*]+\*\s*/, ''); // strip *LABEL* prefixes
  s = s.replace(/\s*\([^)]*\)/g, ''); // strip (STOCK COLORS), (STOCK 1/2/3), (M STOCK), etc.
  s = s.replace(/\s+/g, ' '); // collapse whitespace
  return s.toLowerCase().trim();
}

module.exports = { normalizeKey };
