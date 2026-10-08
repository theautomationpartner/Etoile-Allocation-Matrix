// Control center (requirements "Control center — Requerimientos funcionales y técnicos", 1 Oct 2026) — the home
// screen. Read-only. Every figure comes from the Allocation Matrix model (engine.js), never from its own formulas,
// so both screens always show the same numbers:
//   Sales at risk = Impossible to cover · Waiting to be allocated = Units to allocate · Committed to wholesale =
//   Already allocated (split by the units' current stage, as the matrix does) · side nav badge = SKUs short.
import { SOURCE } from "./engine.js";
import { containerCode, orderParts, retailerShort } from "./matrix.js";
import { localToday } from "./shipments.js";

export const SOON_DAYS = 30; // "Landing in 30 days" (TBD-C02: fixed, as in the mockup)
export const WAITING_ROWS = 6; // "Waiting on an allocation" shows the first 6 rows (TBD-C03)

const day = (s) => new Date(`${s}T12:00:00`);
export const daysBetween = (from, to) => Math.round((day(to) - day(from)) / 864e5);
const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);

export function buildControl(model, data, { today = localToday() } = {}) {
  const m = model.metrics;
  const days = (s) => (s ? daysBetween(today, s) : null);
  const poName = new Map((data.pos || []).map((p) => [p.name, p]));
  const posOf = (c) => [...new Set((c.lines || []).map((l) => l.poRef).filter(Boolean))].sort();

  // Container figures: units on board, free (nobody holds them), promised (held by open orders).
  const shipFigures = (c) => {
    const skus = [...new Set(c.lines.map((l) => l.sku))];
    const total = sum(skus, (s) => model.containerTotal(c, s));
    const free = sum(skus, (s) => model.freeOf(SOURCE.IN_TRANSIT, c.id, s));
    return { total, free, promised: Math.max(0, total - free) };
  };

  // §5.1 Needs a buying decision — every SKU short, the largest shortfall first.
  const short = model.shortSkus.map((sku) => ({
    sku,
    name: data.warehouse?.[sku]?.name || sku,
    need: sum(model.lines.filter((l) => l.sku === sku), (l) => l.left), // sold and not allocated
    available: model.supplyFree.get(sku) || 0, // free anywhere: warehouse, containers, POs
    gap: model.impossibleBySku.get(sku) || 0,
  })).sort((a, b) => b.gap - a.gap || a.sku.localeCompare(b.sku));

  // §5.2 Waiting on an allocation — open lines with Left whose SKU has no shortfall, soonest cancel date first.
  const waitingAll = model.lines
    .filter((l) => l.left > 0 && !(model.impossibleBySku.get(l.sku) > 0))
    .map((l) => ({
      lineId: String(l.lineId), orderId: String(l.orderId), sku: l.sku, left: l.left,
      retailer: retailerShort(l.order.retailer), number: orderParts(l.order.name).number,
      cancelDate: l.order.cancelDate || "", daysLeft: days(l.order.cancelDate),
    }))
    .sort((a, b) => (a.cancelDate || "9999-12-31").localeCompare(b.cancelDate || "9999-12-31") || a.number.localeCompare(b.number) || a.sku.localeCompare(b.sku));

  // §5.3 Draft packing lists — active containers whose packing list is still Draft.
  const drafts = model.containers.filter((c) => c.packingList === "Draft").map((c) => ({
    id: String(c.id), code: containerCode(c.name), eta: c.eta, pos: posOf(c), promised: shipFigures(c).promised,
  }));

  // §4 Landing in 30 days — active containers arriving between tomorrow and +30 days.
  const soon = model.containers.filter((c) => { const d = days(c.eta); return d !== null && d > 0 && d <= SOON_DAYS; });
  const landing = { shipments: soon.length, units: sum(soon, (c) => shipFigures(c).total), free: sum(soon, (c) => shipFigures(c).free) };

  // §5.5 What is coming in — every active container and every PO with units not shipped yet, by date.
  const coming = [
    ...model.containers.map((c) => {
      const f = shipFigures(c);
      return { kind: "ship", id: String(c.id), date: c.eta || "", days: days(c.eta), title: containerCode(c.name), units: f.total, free: f.free, pos: posOf(c) };
    }),
    ...model.pos.map((p) => {
      const units = sum([...new Set(p.lines.map((l) => l.sku))], (s) => model.poTotal(p, s));
      return { kind: "po", id: String(p.id), date: p.eta || "", days: days(p.eta), title: p.name, reference: p.reference || poName.get(p.name)?.reference || "", units };
    }).filter((p) => p.units > 0),
  ].sort((a, b) => (a.date || "9999-12-31").localeCompare(b.date || "9999-12-31") || a.title.localeCompare(b.title));

  // §5.6 Where committed units come from.
  const committed = { ...m.allocatedSplit, total: m.alreadyAllocated, notAllocated: sum(model.lines, (l) => l.left) };

  return {
    cards: {
      atRisk: { units: m.impossible, skus: m.shortSkuCount },
      waiting: { units: m.unitsToAllocate, lines: m.linesWithLeft }, // as the matrix card and the mockup
      committed,
      landing,
    },
    orphanUnits: model.orphanUnits || 0,
    short,
    waiting: waitingAll.slice(0, WAITING_ROWS),
    waitingMore: Math.max(0, waitingAll.length - WAITING_ROWS),
    drafts,
    coming,
  };
}
