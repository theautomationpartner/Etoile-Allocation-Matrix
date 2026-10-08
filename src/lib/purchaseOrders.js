// Purchase Orders screen (mockup vPO): every US purchase order of 📦 Purchase Orders (PO) — what was ordered from
// suppliers and how much of it is already sold. Read-only. Figures from monday and the Allocation Matrix model:
//   Ordered / Arrived = Qty Ordered / Qty Arrived of its subitems · Shipped = its units on containers in transit
//   (model.poShipped: container lines whose PO Reference is the PO) · Still to ship = Qty Outstanding − Shipped
//   (what the PO still offers to the matrix) · Status of a line = the subitem's Status (Fully / Partially Arrived,
//   Ordered) · Reserved on PO = reservations made on the PO itself · Sold to = direct reservations plus the units of
//   this PO promised on its containers (the same split as In-Transit Shipments, transit.js).
// "Lands too late": a reservation made on the PO for an order whose cancel date is before the PO's ETA.
// Order: open POs first (soonest ETA first), then the ones with nothing outstanding (latest ETA first).
import { SOURCE } from "./engine.js";
import { containerCode, orderParts, retailerShort } from "./matrix.js";
import { localToday } from "./shipments.js";
import { buildTransit } from "./transit.js";

export const PO_FILTERS = {
  all: { label: "All POs" },
  open: { label: "Still open" },
  untouched: { label: "Nothing shipped" },
  partial: { label: "Partially shipped" },
  promised: { label: "Sold to customers" },
  late: { label: "Lands too late" },
};

const day = (s) => new Date(`${s}T12:00:00`);
const daysBetween = (from, to) => Math.round((day(to) - day(from)) / 864e5);
const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);

export function buildPurchaseOrders(model, data, { today = localToday() } = {}) {
  const product = (sku) => data.warehouse?.[sku]?.name || sku;
  const us = (data.pos || []).filter((p) => p.region === "US");

  // Units of each PO promised on containers (per SKU and order), from the In-Transit split.
  const viaShips = new Map(); // po id → [{ sku, orderId, number, retailerShort, qty }]
  for (const r of buildTransit(model, data, { today }).rows) {
    for (const g of r.groups) for (const s of g.subs) {
      if (!s.poId) continue;
      if (!viaShips.has(s.poId)) viaShips.set(s.poId, []);
      for (const p of s.promised) viaShips.get(s.poId).push({ sku: s.sku, ...p });
    }
  }
  // Reservations made on the PO itself (after the engine's source caps), with their order.
  const direct = new Map(); // po id → [{ sku, order, qty }]
  for (const x of model.allLines) {
    for (const e of x.entries) {
      if (e.source !== SOURCE.PO || e.qty <= 0) continue;
      const k = String(e.sourceId);
      if (!direct.has(k)) direct.set(k, []);
      direct.get(k).push({ sku: x.sku, order: x.order, qty: e.qty });
    }
  }

  const rows = us.map((p) => {
    const id = String(p.id);
    const skus = [...new Set(p.lines.map((l) => l.sku))];
    const ships = model.containers.filter((c) => c.lines.some((l) => l.poRef === p.name)).map((c) => ({
      id: String(c.id), code: containerCode(c.name),
      qty: sum(c.lines.filter((l) => l.poRef === p.name), (l) => l.qty), total: sum(c.lines, (l) => l.qty),
    }));
    const dir = direct.get(id) || [];
    const via = viaShips.get(id) || [];
    const lines = skus.map((sku) => {
      const ls = p.lines.filter((l) => l.sku === sku);
      const ordered = sum(ls, (l) => l.qtyOrdered), arrived = sum(ls, (l) => l.qtyArrived), outstanding = sum(ls, (l) => l.qtyOutstanding);
      const shipped = model.poShipped(p, sku);
      const soldTo = new Map();
      const add = (orderId, number, short, qty) => {
        if (!soldTo.has(orderId)) soldTo.set(orderId, { orderId, number, retailerShort: short, qty: 0 });
        soldTo.get(orderId).qty += qty;
      };
      for (const d of dir.filter((y) => y.sku === sku)) add(String(d.order.id), orderParts(d.order.name).number, retailerShort(d.order.retailer), d.qty);
      for (const v of via.filter((y) => y.sku === sku)) add(v.orderId, v.number, v.retailerShort, v.qty);
      return {
        sku, name: product(sku), status: ls.map((l) => l.status).find(Boolean) || "", ordered, arrived, outstanding, shipped,
        toShip: Math.max(0, outstanding - shipped), reserved: sum(dir.filter((y) => y.sku === sku), (y) => y.qty), soldTo: [...soldTo.values()],
      };
    });
    const ord = sum(lines, (l) => l.ordered), arr = sum(lines, (l) => l.arrived), out = sum(lines, (l) => l.outstanding);
    const it = sum(lines, (l) => l.shipped), remaining = sum(lines, (l) => l.toShip);
    const doneP = ord ? Math.min(100, (arr / ord) * 100) : 0;
    const shipP = ord ? Math.min(100 - doneP, (it / ord) * 100) : 0;
    const late = p.eta ? dir.filter((d) => d.order.cancelDate && p.eta > d.order.cancelDate) : [];
    return {
      id, name: p.name, reference: p.reference || "", status: p.status || "", supplier: String(p.supplier || ""), eta: p.eta || "",
      days: p.eta ? daysBetween(today, p.eta) : null, ord, arr, outstanding: out, it, remaining, doneP, shipP,
      moving: Math.round(doneP + shipP), ships, lines,
      customers: [...new Set(lines.flatMap((l) => l.soldTo.map((s) => s.retailerShort)))],
      sold: sum(lines, (l) => sum(l.soldTo, (s) => s.qty)), late: late.length > 0,
    };
  }).sort((a, b) => (b.outstanding > 0) - (a.outstanding > 0) // open POs first, soonest ETA first; then the closed ones, newest first
    || (a.outstanding > 0 ? (a.eta || "9999").localeCompare(b.eta || "9999") : (b.eta || "").localeCompare(a.eta || ""))
    || a.name.localeCompare(b.name));

  const is = {
    all: () => true,
    open: (r) => r.outstanding > 0,
    untouched: (r) => r.outstanding > 0 && r.it === 0,
    partial: (r) => r.outstanding > 0 && r.it > 0,
    promised: (r) => r.sold > 0,
    late: (r) => r.late,
  };
  const counts = Object.fromEntries(Object.keys(PO_FILTERS).map((k) => [k, rows.filter(is[k]).length]));
  return {
    rows,
    is,
    counts,
    cards: {
      open: { pos: counts.open, toShip: sum(rows, (r) => r.remaining) },
      untouched: counts.untouched,
      promised: counts.promised,
      late: counts.late,
    },
  };
}
