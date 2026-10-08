// In-Transit Shipments screen (mockup vTransit): every active container of 🚢 In-Transit Shipments (group topics,
// Location US, Packing List not Done — the matrix's in-transit supply) with how much a customer already counts on
// and how much is still free to sell. Read-only. Every figure comes from the Allocation Matrix model (engine.js):
//   On board = Σ Qty of its subitems · Free = units nobody holds (freeOf) · Committed = On board − Free (every open
//   reservation on the container, also the ones already counted as warehouse stock) · Claimed = Committed ÷ On board.
// A container's reservations name the container, not its PO subitem: they are split over the subitems of the SKU,
// earliest PO first and earliest cancel date first — the same bookkeeping as the side panel (paths.js, §8.1).
// Arrived / "landed" follows the ETA, as in the mockup and the Control center.
import { SOURCE } from "./engine.js";
import { containerCode, orderParts, retailerShort } from "./matrix.js";
import { localToday } from "./shipments.js";

export const SOON_DAYS = 30; // "Arriving in 30 days" (same window as the Control center)
export const TRANSIT_FILTERS = {
  all: { label: "All shipments" },
  notarrived: { label: "Not arrived" },
  soon: { label: `Arriving ≤ ${SOON_DAYS} days` },
  free: { label: "Has free units" },
  committed: { label: "Customers depend on it" },
  draft: { label: "Draft packing list" },
};

const day = (s) => new Date(`${s}T12:00:00`);
const daysBetween = (from, to) => Math.round((day(to) - day(from)) / 864e5);
const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);
const byCancel = (a, b) => (a.order.cancelDate || "9999-12-31").localeCompare(b.order.cancelDate || "9999-12-31");

export function buildTransit(model, data, { today = localToday() } = {}) {
  const pos = data.pos || [];
  const poById = new Map(pos.map((p) => [String(p.id), p]));
  const poByName = new Map(pos.map((p) => [p.name, p]));
  const poOf = (l) => (l.poId && poById.get(String(l.poId))) || poByName.get(l.poRef) || null;
  const product = (sku) => data.warehouse?.[sku]?.name || sku;

  // Reservations on each container (every open line, any stage), earliest cancel date first.
  const holds = new Map(); // container id → [{ order, sku, qty }]
  for (const x of [...model.allLines].sort(byCancel)) {
    for (const e of x.entries) {
      if (e.source !== SOURCE.IN_TRANSIT || e.qty <= 0) continue;
      const k = String(e.sourceId);
      if (!holds.has(k)) holds.set(k, []);
      holds.get(k).push({ order: x.order, sku: x.sku, qty: e.qty });
    }
  }

  const rows = model.containers.map((c) => {
    const skus = [...new Set(c.lines.map((l) => l.sku))];
    const total = sum(skus, (s) => model.containerTotal(c, s));
    const free = sum(skus, (s) => model.freeOf(SOURCE.IN_TRANSIT, c.id, s));
    const committed = Math.max(0, total - free);
    const days = c.eta ? daysBetween(today, c.eta) : null;

    // Subitems of each SKU, earliest PO first; the reservations fill them in that order.
    const subsOf = (sku) => c.lines.filter((l) => l.sku === sku)
      .map((l, i) => ({ l, i, po: poOf(l) }))
      .sort((a, b) => String(a.po?.eta || "9999").localeCompare(String(b.po?.eta || "9999")) || a.i - b.i);
    const groups = skus.map((sku) => {
      const subs = subsOf(sku).map(({ l, po }) => ({
        id: String(l.id), name: l.name || `${po?.reference || l.poRef || "—"} - ${product(sku)}`, sku, onBoard: l.qty, committed: 0,
        poId: po ? String(po.id) : null, poName: po?.name || l.poRef || "", promised: new Map(),
      }));
      // Only what the container still holds for open orders (the source cap of the engine: On board − Free).
      let held = Math.max(0, model.containerTotal(c, sku) - model.freeOf(SOURCE.IN_TRANSIT, c.id, sku));
      for (const h of (holds.get(String(c.id)) || []).filter((y) => y.sku === sku)) {
        let left = Math.min(h.qty, held);
        held -= left;
        for (const s of subs) {
          if (left <= 0) break;
          const t = Math.min(left, Math.max(0, s.onBoard - s.committed));
          if (t <= 0) continue;
          s.committed += t;
          left -= t;
          addPromise(s.promised, h.order, t);
        }
        if (left > 0 && subs.length) { const s = subs[subs.length - 1]; s.committed += left; addPromise(s.promised, h.order, left); }
      }
      const out = subs.map((s) => ({ ...s, free: Math.max(0, s.onBoard - s.committed), promised: [...s.promised.values()] }));
      const onBoard = sum(out, (s) => s.onBoard), res = sum(out, (s) => s.committed);
      return { sku, name: product(sku), onBoard, committed: res, free: Math.max(0, onBoard - res), subs: out };
    });

    const poMap = new Map();
    for (const l of c.lines) {
      const po = poOf(l);
      const key = po ? `id:${po.id}` : `ref:${l.poRef}`;
      if (!poMap.has(key)) poMap.set(key, { id: po ? String(po.id) : null, name: po?.name || l.poRef || "—", qty: 0 });
      poMap.get(key).qty += l.qty;
    }
    const customers = [...new Set(groups.flatMap((g) => g.subs.flatMap((s) => s.promised.map((p) => p.retailerShort))))];
    return {
      id: String(c.id), code: containerCode(c.name), name: c.name, eta: c.eta || "", etd: c.etd || "", days,
      arrived: days !== null && days <= 0, packingList: c.packingList || "", skus: skus.length, subitems: c.lines.length,
      total, committed, free, pct: total ? Math.round((committed / total) * 100) : 0,
      pos: [...poMap.values()], customers, groups,
    };
  }).sort((a, b) => (a.eta || "9999").localeCompare(b.eta || "9999") || a.code.localeCompare(b.code));

  const is = {
    all: () => true,
    notarrived: (r) => !r.arrived,
    soon: (r) => !r.arrived && r.days !== null && r.days <= SOON_DAYS,
    free: (r) => r.free > 0,
    committed: (r) => r.committed > 0,
    draft: (r) => r.packingList === "Draft",
  };
  const counts = Object.fromEntries(Object.keys(TRANSIT_FILTERS).map((k) => [k, rows.filter(is[k]).length]));
  const of = (k) => rows.filter(is[k]);
  return {
    rows,
    is,
    counts,
    cards: {
      water: { shipments: counts.notarrived, units: sum(of("notarrived"), (r) => r.total) },
      soon: { shipments: counts.soon, promised: sum(of("soon"), (r) => r.committed) },
      free: { units: sum(rows, (r) => r.free), shipments: counts.free },
      draft: { shipments: counts.draft, promised: sum(of("draft"), (r) => r.committed) },
    },
  };
}

function addPromise(map, order, qty) {
  const k = String(order.id);
  if (!map.has(k)) map.set(k, { orderId: k, number: orderParts(order.name).number, retailerShort: retailerShort(order.retailer), qty: 0 });
  map.get(k).qty += qty;
}
