// Step 4 — shipments inside a wholesale order (PDF §16). Pure functions, same logic as the mockup:
// a shipment takes units already allocated AND confirmed (never drafts) and says how many of each SKU
// leave together. It never changes the allocation.
//
// Shipment: { id, mondayId, name, target (YYYY-MM-DD or ""), skus: [sku…], qty: { sku: n }, subIds: { sku: subitemId }, dirty }
import { SOURCE } from "./engine.js";

export const shipUnits = (sh) => Object.values(sh.qty || {}).reduce((a, b) => a + (b || 0), 0);
export const inShipments = (ships, sku, exceptId) => ships.reduce((a, s) => a + (s.id === exceptId ? 0 : s.qty[sku] || 0), 0);
// Units of a SKU allocated to the order but not in any shipment yet (the "Copy remaining" figure).
export const leftToShip = (ships, sku, allocated) => Math.max(0, allocated - inShipments(ships, sku));
// §16.2 Remaining to ship: once this shipment and the ones before it have left.
export function remainingAfter(ships, sh, sku, allocated) {
  let n = 0;
  for (const s of ships) {
    n += s.qty[sku] || 0;
    if (s.id === sh.id) break;
  }
  return Math.max(0, allocated - n);
}
// §16.2 max for "To ship in this shipment" = Allocated − Σ of that SKU in the other shipments.
export const maxFor = (ships, sh, sku, allocated) => Math.max(0, allocated - inShipments(ships, sku, sh.id));

// The matrix column a confirmed entry belongs to (same ids as the matrix columns).
export const colIdOf = (e) => (e.stage === SOURCE.WAREHOUSE ? "warehouse" : String(e.sourceId));
const RANK = { [SOURCE.WAREHOUSE]: 0, [SOURCE.IN_TRANSIT]: 1, [SOURCE.PO]: 2 };

// §16.2 — where each shipment's units of a SKU come from: { shipmentId: { colId: qty } }.
// The line's allocated sources are used in order — warehouse, then containers by ETA, then POs by ETA —
// and shipment by shipment (1, 2, 3…), so the same units are never in two shipments.
// srcDate(colId) → arrival date of that source ("today" for the warehouse).
export function shipSplit(ships, entries, sku, srcDate, override) {
  const pool = new Map(), rank = new Map();
  for (const e of entries || []) {
    const k = colIdOf(e);
    pool.set(k, (pool.get(k) || 0) + e.qty);
    rank.set(k, RANK[e.stage] ?? 3);
  }
  const refs = [...pool.keys()].sort((a, b) => rank.get(a) - rank.get(b) || String(srcDate(a)).localeCompare(String(srcDate(b))));
  const left = Object.fromEntries(refs.map((r) => [r, pool.get(r)]));
  const out = {};
  for (const s of ships) {
    let q = override && override.id === s.id ? override.q : s.qty[sku] || 0;
    const x = {};
    for (const r of refs) {
      if (q <= 0) break;
      const t = Math.min(q, left[r]);
      if (t > 0) {
        x[r] = t;
        left[r] -= t;
        q -= t;
      }
    }
    out[s.id] = x;
  }
  return out;
}

// Units of this shipment that come from a source landing after its ship date.
export const lateUnits = (sh, split, srcDate) =>
  sh.target ? Object.entries(split || {}).reduce((a, [r, q]) => a + (srcDate(r) > sh.target ? q : 0), 0) : 0;

// "Shipment <n+1>" after the highest number already used.
export function nextShip(ships, orderId) {
  const n = ships.reduce((m, s) => Math.max(m, +((s.name.match(/\d+/) || [0])[0])), 0) + 1;
  return { id: `${orderId}-new-${n}-${Date.now() % 100000}`, mondayId: null, name: `Shipment ${n}`, target: "", skus: [], qty: {}, subIds: {}, dirty: true };
}

// §16.4 — when an allocation shrinks below what the shipments hold, units come out of the shipments,
// last shipment first. Returns { ships, cut } without mutating the input.
export function trimShips(ships, sku, allocated) {
  let over = inShipments(ships, sku) - allocated;
  if (over <= 0) return { ships, cut: 0 };
  const cut = over;
  const next = ships.map((s) => ({ ...s, qty: { ...s.qty } }));
  for (const s of [...next].reverse()) {
    if (over <= 0) break;
    const q = s.qty[sku] || 0, take = Math.min(q, over);
    if (take) {
      s.qty[sku] = q - take;
      s.dirty = true;
      over -= take;
    }
  }
  return { ships: next, cut };
}
