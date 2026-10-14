// Step 4 — shipments inside a wholesale order (PDF §16). Pure functions, same logic as the mockup:
// a shipment takes units already allocated AND confirmed (never drafts) and says how many of each SKU
// leave together. It never changes the allocation.
//
// Shipment: { id, mondayId, name, target (YYYY-MM-DD or ""), skus: [sku…], qty: { sku: n }, subIds: { sku: subitemId }, dirty,
//   base: { sku: US Qty Fulfilled of the line when that shipment line was created }, shipped: { sku: units already left } }
//
// Fulfilled (client, 2026-10-14): a shipment is resolved when Cin7's US Qty Fulfilled of its lines goes up. The units that
// already left (shipped) stay in the shipment and are never trimmed or edited; every figure below (Remaining to ship,
// the max of a shipment, Copy remaining, the trim) counts only the units still to leave, which the line's allocation
// (≤ its Outstanding) covers.
import { SOURCE } from "./engine.js";

export const shipUnits = (sh) => Object.values(sh.qty || {}).reduce((a, b) => a + (b || 0), 0);
export const sentOf = (sh, sku) => Math.min(sh.shipped?.[sku] || 0, sh.qty[sku] || 0);
export const sentUnits = (sh) => Object.keys(sh.qty || {}).reduce((a, k) => a + sentOf(sh, k), 0);
// Units of a SKU in a shipment that have not left yet.
export const pendingOf = (sh, sku) => Math.max(0, (sh.qty[sku] || 0) - sentOf(sh, sku));
export const inShipments = (ships, sku, exceptId) => ships.reduce((a, s) => a + (s.id === exceptId ? 0 : pendingOf(s, sku)), 0);

// Draft (nothing left yet) · Partially fulfilled · Fulfilled (every unit left).
export const SHIP_STATUS = { DRAFT: "Draft", PARTIAL: "Partially fulfilled", FULFILLED: "Fulfilled" };
export function shipStatus(sh) {
  const sent = sentUnits(sh), units = shipUnits(sh);
  return !sent ? SHIP_STATUS.DRAFT : sent >= units ? SHIP_STATUS.FULFILLED : SHIP_STATUS.PARTIAL;
}

// Which units of an order's shipments already left: per SKU, what Cin7 fulfilled since the earliest shipment line was
// created (fulfilled − base) goes to the shipments in creation order; a shipment line only takes what was fulfilled
// after it was created (a new, unsaved line has base = fulfilled now, so it takes nothing).
// fulfilledOf(sku) → US Qty Fulfilled now. Returns new shipment objects with `shipped`.
export function attributeShipped(ships, fulfilledOf) {
  const shipped = new Map(ships.map((s) => [s.id, {}]));
  for (const sku of new Set(ships.flatMap((s) => s.skus || []))) {
    const f = fulfilledOf(sku);
    if (!Number.isFinite(f)) continue;
    const bases = ships.filter((s) => (s.qty[sku] || 0) > 0 && Number.isFinite(s.base?.[sku])).map((s) => s.base[sku]);
    if (!bases.length) continue;
    let left = Math.max(0, f - Math.min(...bases));
    for (const s of ships) {
      const q = s.qty[sku] || 0;
      if (!q || left <= 0 || !Number.isFinite(s.base?.[sku])) continue;
      const take = Math.min(q, Math.max(0, f - s.base[sku]), left);
      if (take > 0) { shipped.get(s.id)[sku] = take; left -= take; }
    }
  }
  return ships.map((s) => ({ ...s, shipped: shipped.get(s.id) }));
}
// Units of a SKU allocated to the order but not in any shipment yet (the "Copy remaining" figure).
export const leftToShip = (ships, sku, allocated) => Math.max(0, allocated - inShipments(ships, sku));
// §16.2 Remaining to ship: once this shipment and the ones before it have left.
export function remainingAfter(ships, sh, sku, allocated) {
  let n = 0;
  for (const s of ships) {
    n += pendingOf(s, sku);
    if (s.id === sh.id) break;
  }
  return Math.max(0, allocated - n);
}
// §16.2 max for "To ship in this shipment" = what already left + Allocated − Σ still to leave in the other shipments.
export const maxFor = (ships, sh, sku, allocated) => sentOf(sh, sku) + Math.max(0, allocated - inShipments(ships, sku, sh.id));

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
    // Only the units still to leave take allocated sources (what already left is no longer allocated).
    let q = Math.max(0, (override && override.id === s.id ? override.q : s.qty[sku] || 0) - sentOf(s, sku));
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

// §16.4 — when an allocation shrinks below what the shipments still have to send, units come out of the shipments,
// last shipment first — never units that already left. Returns { ships, cut } without mutating the input.
export function trimShips(ships, sku, allocated) {
  let over = inShipments(ships, sku) - allocated;
  if (over <= 0) return { ships, cut: 0 };
  const cut = over;
  const next = ships.map((s) => ({ ...s, qty: { ...s.qty } }));
  for (const s of [...next].reverse()) {
    if (over <= 0) break;
    const q = s.qty[sku] || 0, take = Math.min(pendingOf(s, sku), over);
    if (take) {
      s.qty[sku] = q - take;
      s.dirty = true;
      over -= take;
    }
  }
  return { ships: next, cut };
}

// Today as YYYY-MM-DD in the user's own time zone (toISOString would give the UTC date, which in New York
// is already "tomorrow" after 8 pm and would block shipping today).
export function localToday(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Concurrency check before saving (§10): with the shipments of this order as they are in monday NOW
// (someone else may have saved since the page was loaded), would this shipment go over what is allocated?
// Returns the SKUs that would be over, with the numbers.
// Units that already left don't count (savedShips and ship carry `shipped`, attributeShipped).
export function overShipped(savedShips, ship, allocatedOf) {
  const out = [];
  for (const sku of ship.skus) {
    const others = savedShips.filter((s) => s.mondayId !== ship.mondayId).reduce((a, s) => a + pendingOf(s, sku), 0);
    const mine = pendingOf(ship, sku);
    const allocated = allocatedOf(sku);
    if (others + mine > allocated) out.push({ sku, others, mine, allocated });
  }
  return out;
}
