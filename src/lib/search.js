// Topbar search: a row matches when every word appears in its order name, SKU, product name,
// or the reference of any source it is allocated to (container code, PO number).
export function rowMatchesSearch(row, query, warehouse = {}) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = [row.order?.name, row.sku, warehouse[row.sku]?.name, ...(row.entries || []).map((e) => e.ref)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return words.every((w) => haystack.includes(w));
}
