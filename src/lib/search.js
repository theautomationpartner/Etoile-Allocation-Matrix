import { containerCode, orderParts, retailerShort } from "./matrix.js";

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

// Header search + Enter (requirements "Conexiones transversales" §3.1): the record whose side panel opens — the first
// match in this order of priority: SKU (code containing the text) → purchase order (number or Reference) → container
// (name or code) → wholesale order (number, retailer or its short label). Within a type an exact match wins, then
// one that starts with the text, then one that contains it. US records only, as everywhere in the app.

const rank = (q, values) => {
  let best = 0;
  for (const v of values) {
    const t = String(v || "").toLowerCase();
    if (!t) continue;
    best = Math.max(best, t === q ? 3 : t.startsWith(q) ? 2 : t.includes(q) ? 1 : 0);
  }
  return best;
};
const pick = (q, items, valuesOf) => {
  let hit = null;
  let best = 0;
  for (const it of items) {
    const r = rank(q, valuesOf(it));
    if (r > best) { best = r; hit = it; }
    if (best === 3) break;
  }
  return hit;
};

// → { type: "sku" | "po" | "ship" | "so", id, label, more } or null. `more`: other records that also match.
export function findRecord(text, data, model) {
  const q = String(text || "").trim().toLowerCase();
  if (!q || !data) return null;
  const skus = Object.keys(data.warehouse || {}).sort();
  const pos = (data.pos || []).filter((p) => p.region === "US");
  const active = new Set((model?.containers || []).map((c) => String(c.id)));
  const containers = (data.containers || []).filter((c) => c.location === "US")
    .sort((a, b) => Number(active.has(String(b.id))) - Number(active.has(String(a.id)))); // in transit first
  const orders = [...(data.orders || []), ...(data.fulfilledOrders || [])].filter((o) => o.region === "US");
  const order = (o) => [orderParts(o.name).number, orderParts(o.name).so, o.retailer, retailerShort(o.retailer)];
  const steps = [
    { type: "sku", list: skus, values: (s) => [s], id: (s) => s, label: (s) => s },
    { type: "po", list: pos, values: (p) => [p.name, p.reference], id: (p) => String(p.id), label: (p) => p.name },
    { type: "ship", list: containers, values: (c) => [c.name, containerCode(c.name)], id: (c) => String(c.id), label: (c) => containerCode(c.name) },
    { type: "so", list: orders, values: order, id: (o) => String(o.id), label: (o) => orderParts(o.name).number },
  ];
  let found = null;
  let total = 0;
  for (const st of steps) {
    const matches = st.list.filter((it) => rank(q, st.values(it)) > 0).length;
    total += matches;
    if (!found && matches) {
      const it = pick(q, st.list, st.values);
      found = { type: st.type, id: st.id(it), label: st.label(it) };
    }
  }
  return found ? { ...found, more: total - 1 } : null;
}
