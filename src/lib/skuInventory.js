// Master SKU Inventory screen (mockup vSKU): one row per product of 👜💄 Master SKU Inventory — what is on hand,
// what is coming, how much is already sold and whether that adds up. Read-only. Every figure comes from the
// Allocation Matrix model (engine.js), so this screen, the matrix and the Control center always agree:
//   On hand = 🇺🇸 US qty · In transit = units on board of the containers in transit (US, not Done) · On order =
//   Qty Outstanding of the US PO lines (not received yet, travelling included) · Sold = left to ship of open sales ·
//   Unassigned = Left · Free to sell = free warehouse + free in transit · Short = Impossible to cover of the SKU.
// The expanded row lists the product's Incoming records (Master SKU subitems, region US), grouped per
// PurchaseID (PO × SKU) as in the mockup: one row per PO with the containers that carry it (see incomingOf).
import { SOURCE } from "./engine.js";
import { containerCode } from "./matrix.js";

const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);

export const SKU_FILTERS = {
  all: { label: "All products" },
  short: { label: "Sold short" },
  oos: { label: "No warehouse stock" },
  unalloc: { label: "Has unassigned demand" },
  free: { label: "Free stock available" },
  idle: { label: "No wholesale demand" },
};

export function buildSkuInventory(model, data) {
  const warehouse = data.warehouse || {};
  const linesBy = new Map();
  for (const l of model.lines) {
    if (!linesBy.has(l.sku)) linesBy.set(l.sku, []);
    linesBy.get(l.sku).push(l);
  }
  const usPos = (data.pos || []).filter((p) => p.region === "US");
  const poById = new Map((data.pos || []).map((p) => [String(p.id), p]));

  const rows = Object.entries(warehouse).map(([sku, w]) => {
    const lines = linesBy.get(sku) || [];
    const sold = sum(lines, (l) => l.toShip);
    const need = sum(lines, (l) => l.left);
    const gap = model.impossibleBySku.get(sku) || 0;
    const onHand = Math.max(0, w.usQty || 0);
    const inTransit = sum(model.containers, (c) => model.containerTotal(c, sku));
    const onOrder = sum(usPos, (p) => sum(p.lines.filter((x) => x.sku === sku), (x) => x.qtyOutstanding));
    const whFree = model.freeOf(SOURCE.WAREHOUSE, null, sku);
    const itFree = sum(model.containers, (c) => model.freeOf(SOURCE.IN_TRANSIT, c.id, sku));
    const free = whFree + itFree;
    const cover = sold ? Math.min(100, Math.round(((sold - gap) / sold) * 100)) : 100;
    const status = gap ? { c: "gap", t: `Short ${gap.toLocaleString("en-US")}` } : need ? { c: "po", t: "Needs assigning" } : sold ? { c: "wh", t: "Covered" } : { c: "mut", t: "No demand" };
    return { sku, name: w.name, onHand, inTransit, onOrder, sold, need, gap, whFree, itFree, free, cover, status, incoming: incomingOf(w, sku, model.containers, poById) };
  });
  rows.sort((a, b) => b.gap - a.gap || b.need - a.need || a.sku.localeCompare(b.sku));

  const is = {
    short: (r) => r.gap > 0,
    oos: (r) => r.onHand === 0 && r.sold > 0,
    unalloc: (r) => r.need > 0,
    free: (r) => r.free > 0,
    idle: (r) => r.sold === 0,
    all: () => true,
  };
  const counts = Object.fromEntries(Object.keys(SKU_FILTERS).map((k) => [k, rows.filter(is[k]).length]));
  return {
    rows,
    is,
    counts,
    cards: {
      short: { skus: counts.short, units: sum(rows, (r) => r.gap) },
      oos: counts.oos,
      sellable: { now: sum(rows, (r) => r.whFree), soon: sum(rows, (r) => r.itFree) },
      committed: { units: model.metrics.alreadyAllocated, unassignedSkus: counts.unalloc },
    },
  };
}

// Incoming records of one product, for its side panel (the same rows as the expanded Master SKU row).
export function incomingRecords(model, data, sku) {
  return incomingOf(data.warehouse?.[sku] || {}, sku, model.containers, new Map((data.pos || []).map((p) => [String(p.id), p])));
}

// Incoming records of one product (requirements §6): one per purchase order (PurchaseID = PO × SKU, the Master
// SKU subitems of region US, grouped as in the mockup) that still has units of the SKU to receive.
//   Shipment = the containers in transit (the matrix's: topics, US, not Done) carrying that SKU from that PO —
//   container line with the same SKU and PO Reference (or PO connection) · Travelling = Σ of those · Still to ship =
//   the record's US Qty Outstanding − Travelling · ETA = first container's ETA, else the PO's · Arrival = Confirmed
//   when a container carries it, else Estimated.
function incomingOf(w, sku, containers, poById) {
  const groups = new Map();
  for (const rec of w.incoming || []) {
    const us = rec.region ? rec.region === "US" : rec.onOrder > 0 || rec.inTransit > 0;
    if (!us) continue;
    const k = rec.purchaseId || rec.id;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(rec);
  }
  const out = [];
  for (const [key, recs] of groups) {
    const po = recs.map((r) => r.poId && poById.get(String(r.poId))).find(Boolean) || null;
    const ships = po ? containers.map((c) => {
      const qty = sum(c.lines.filter((l) => l.sku === sku && (l.poRef === po.name || String(l.poId || "") === String(po.id))), (l) => l.qty);
      return { recordId: `${key}|${c.id}`, containerId: String(c.id), code: containerCode(c.name), qty, eta: c.eta || "", packingList: c.packingList || "" };
    }).filter((x) => x.qty > 0).sort((a, b) => (a.eta || "9999").localeCompare(b.eta || "9999")) : [];
    const travelling = sum(ships, (x) => x.qty);
    const outstanding = Math.max(...recs.map((r) => r.outstanding), 0);
    const toShip = Math.max(0, outstanding - travelling);
    if (!travelling && !toShip) continue; // nothing pending any more
    out.push({
      key, name: recs[0].name, poId: po ? String(po.id) : null, poName: po?.name || "", poEta: po?.eta || "",
      ships, eta: ships[0]?.eta || po?.eta || "", arrival: ships.length ? "Confirmed" : "Estimated", travelling, toShip,
    });
  }
  return out.sort((a, b) => (a.eta || "9999").localeCompare(b.eta || "9999") || a.name.localeCompare(b.name));
}
