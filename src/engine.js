// Allocation Matrix — calculation engine (pure functions, no I/O).
// Every rule cites the section of "Allocation Matrix — Functional & Technical Requirements".
//
// Input (normalized by the loader):
//   orders:     [{ id, name, group, region, cancelDate, lines: [{ id, sku, outstanding, entries: [{ source, sourceId, qty }] }] }]
//   warehouse:  { [sku]: { itemId, name, usQty } }
//   containers: [{ id, name, group, location, eta, packingList, lines: [{ id, sku, qty, poRef }] }]
//   pos:        [{ id, name, reference, region, eta, lines: [{ id, sku, qtyOutstanding }] }]

export const OPEN_ORDER_GROUPS = new Set(["topics", "group_mm1730xq"]); // Orders + Pending (§5.1)
export const ACTIVE_CONTAINER_GROUP = "topics"; // In-Transit Shipments (Items) (§6.2)
export const SOURCE = { WAREHOUSE: "warehouse", IN_TRANSIT: "intransit", PO: "po" };

const n = (v) => (Number.isFinite(v) ? v : 0);
const etaKey = (eta) => (eta ? eta : "9999-12-31");
const byEta = (a, b) => etaKey(a.eta).localeCompare(etaKey(b.eta));

// TBD-07: the current Allocation Queue matches the container subitem "PO Reference" against the
// PO item *Name* (PO-00432). Kept as the default until the stored value is confirmed.
export function buildModel(data, { poRefKey = (po) => po.name } = {}) {
  const warehouse = data.warehouse || {};

  // §5.1 / §11.2 — demand: Orders + Pending groups, region US.
  const orders = (data.orders || []).filter((o) => OPEN_ORDER_GROUPS.has(o.group) && o.region === "US");

  // §6.2 / §11.1 — containers: group topics + Location US.
  const containers = (data.containers || []).filter((c) => c.group === ACTIVE_CONTAINER_GROUP && c.location === "US").sort(byEta);

  // §6.3 / §11.1 — POs: Destination Region US, only subitems with Qty Outstanding > 0.
  const pos = (data.pos || [])
    .filter((p) => p.region === "US")
    .map((p) => ({ ...p, lines: (p.lines || []).filter((l) => n(l.qtyOutstanding) > 0) }))
    .sort(byEta);

  const containerById = new Map(containers.map((c) => [String(c.id), c]));
  const poById = new Map(pos.map((p) => [String(p.id), p]));

  // ── Source totals (§6) ──
  const whTotal = (sku) => Math.max(0, n(warehouse[sku]?.usQty)); // 🇺🇸 US qty, never US Availability (§6.1, rule 3)
  const containerTotal = (c, sku) => c.lines.reduce((s, l) => (l.sku === sku ? s + n(l.qty) : s), 0);
  const poShipped = (po, sku) => {
    const key = poRefKey(po);
    return containers.reduce((s, c) => s + c.lines.reduce((t, l) => (l.sku === sku && l.poRef === key ? t + n(l.qty) : t), 0), 0);
  };
  const poOutstanding = (po, sku) => po.lines.reduce((s, l) => (l.sku === sku ? s + n(l.qtyOutstanding) : s), 0);
  const poTotal = (po, sku) => Math.max(0, poOutstanding(po, sku) - poShipped(po, sku)); // rule 2

  // §13 rule 4 — an entry whose source is no longer active does not count anywhere.
  function sourceActive(entry, sku) {
    const id = String(entry.sourceId ?? "");
    if (entry.source === SOURCE.WAREHOUSE) return Boolean(warehouse[sku]);
    if (entry.source === SOURCE.IN_TRANSIT) return Boolean(containerById.get(id)?.lines.some((l) => l.sku === sku));
    if (entry.source === SOURCE.PO) return Boolean(poById.get(id)?.lines.some((l) => l.sku === sku));
    return false;
  }
  const sourceKey = (source, sourceId, sku) => (source === SOURCE.WAREHOUSE ? `warehouse||${sku}` : `${source}|${sourceId}|${sku}`);

  // ── Demand lines (§5.2: only Outstanding > 0) and confirmed usage per source ──
  const used = new Map(); // sourceKey → Σ confirmed qty across all open orders (rule 1)
  const lines = [];
  let orphanUnits = 0;
  for (const o of orders) {
    for (const l of o.lines || []) {
      const toShip = Math.max(0, n(l.outstanding));
      const active = [];
      for (const e of l.entries || []) {
        const qty = n(e.qty);
        if (qty <= 0) continue;
        if (!sourceActive(e, l.sku)) {
          orphanUnits += qty;
          continue;
        }
        active.push({ ...e, qty });
        const k = sourceKey(e.source, e.sourceId, l.sku);
        used.set(k, (used.get(k) || 0) + qty);
      }
      if (toShip <= 0) continue;
      const confirmed = active.reduce((s, e) => s + e.qty, 0);
      const allocated = Math.min(confirmed, toShip); // §7.1
      lines.push({
        orderId: o.id,
        order: o,
        lineId: l.id,
        sku: l.sku,
        toShip,
        allocated,
        left: Math.max(0, toShip - allocated),
        overAllocated: confirmed > toShip, // rule 5 — flag for review
        lostSource: (l.entries || []).some((e) => n(e.qty) > 0 && !sourceActive(e, l.sku)),
        entries: active,
      });
    }
  }
  const usedOf = (source, sourceId, sku) => used.get(sourceKey(source, sourceId, sku)) || 0;

  // ── Free per source (§7.1: Total − Σ confirmed of all open orders) ──
  const whFree = (sku) => Math.max(0, whTotal(sku) - usedOf(SOURCE.WAREHOUSE, null, sku));
  const containerFree = (c, sku) => Math.max(0, containerTotal(c, sku) - usedOf(SOURCE.IN_TRANSIT, c.id, sku));
  const poFree = (po, sku) => Math.max(0, poTotal(po, sku) - usedOf(SOURCE.PO, po.id, sku));

  // Sources for a SKU in proposal order (§11.3): warehouse, containers by ETA, POs by ETA.
  function sourcesFor(sku) {
    const out = [];
    if (warehouse[sku]) out.push({ source: SOURCE.WAREHOUSE, sourceId: warehouse[sku].itemId, total: whTotal(sku), free: whFree(sku) });
    for (const c of containers) {
      const total = containerTotal(c, sku);
      if (total > 0) out.push({ source: SOURCE.IN_TRANSIT, sourceId: c.id, eta: c.eta, total, free: containerFree(c, sku) });
    }
    for (const p of pos) {
      const total = poTotal(p, sku);
      if (total > 0) out.push({ source: SOURCE.PO, sourceId: p.id, eta: p.eta, total, free: poFree(p, sku) });
    }
    return out;
  }

  const skus = [...new Set(lines.map((l) => l.sku))];
  const supplyFree = new Map(skus.map((sku) => [sku, sourcesFor(sku).reduce((s, x) => s + x.free, 0)]));

  // §4 / §6.4 — Impossible is per SKU: open orders asking for the same SKU share one pool.
  const leftBySku = new Map();
  for (const l of lines) leftBySku.set(l.sku, (leftBySku.get(l.sku) || 0) + l.left);
  const impossibleBySku = new Map(skus.map((sku) => [sku, Math.max(0, leftBySku.get(sku) - supplyFree.get(sku))]));
  for (const l of lines) l.impossible = Math.max(0, l.left - supplyFree.get(l.sku)); // §7.1 row shortfall

  const drafts = buildDrafts(lines, sourcesFor);

  // ── Metrics (§4) ──
  const totalLeft = lines.reduce((s, l) => s + l.left, 0);
  const impossible = [...impossibleBySku.values()].reduce((s, v) => s + v, 0);
  const shortSkus = [...impossibleBySku.entries()].filter(([, v]) => v > 0).map(([sku]) => sku);

  // Free inventory: warehouse free + in-transit free; purchase orders are not counted.
  let freeWarehouse = 0;
  for (const sku of Object.keys(warehouse)) freeWarehouse += whFree(sku);
  let freeInTransit = 0;
  for (const c of containers) for (const sku of new Set(c.lines.map((l) => l.sku))) freeInTransit += containerFree(c, sku);

  // Already allocated: confirmed entries of open orders, split by the source's current stage (§6.5).
  const split = { onHand: 0, inTransit: 0, onOrder: 0 };
  for (const o of orders) {
    for (const l of o.lines || []) {
      for (const e of l.entries || []) {
        const qty = n(e.qty);
        if (qty <= 0 || !sourceActive(e, l.sku)) continue;
        if (e.source === SOURCE.WAREHOUSE) split.onHand += qty;
        else if (e.source === SOURCE.IN_TRANSIT) {
          if (containerById.get(String(e.sourceId))?.packingList === "Done") split.onHand += qty;
          else split.inTransit += qty;
        } else split.onOrder += qty;
      }
    }
  }

  const metrics = {
    unitsToAllocate: totalLeft - impossible,
    linesWithLeft: lines.filter((l) => l.left > 0).length,
    draftUnits: drafts.total, // drafts never count, except this subtitle figure (§4)
    impossible,
    shortSkuCount: shortSkus.length,
    freeInventory: freeWarehouse + freeInTransit,
    alreadyAllocated: split.onHand + split.inTransit + split.onOrder,
    allocatedSplit: split,
  };

  return {
    orders,
    lines,
    containers,
    pos,
    drafts,
    metrics,
    shortSkus,
    orphanUnits,
    supplyFree,
    impossibleBySku,
    sourcesFor,
    counts: { orders: new Set(lines.map((l) => l.orderId)).size, rows: lines.length },
  };
}

// §9 — drafts: orders by cancel date (soonest first); each line takes what is still free after the
// drafts already proposed to earlier lines, so two drafts never propose the same units.
// §11.3 — warehouse only if its free units cover 100% of Left; else containers by ETA, then POs by ETA.
export function buildDrafts(lines, sourcesFor) {
  const held = new Map();
  const byLine = new Map();
  let total = 0;
  const ordered = lines
    .map((l, i) => ({ l, i }))
    .sort((a, b) => (a.l.order.cancelDate || "9999-12-31").localeCompare(b.l.order.cancelDate || "9999-12-31") || a.i - b.i);

  for (const { l } of ordered) {
    let need = l.left;
    if (need <= 0) continue;
    const srcs = sourcesFor(l.sku).map((s) => {
      const k = `${s.source}|${s.sourceId}|${l.sku}`;
      return { ...s, k, cap: Math.max(0, s.free - (held.get(k) || 0)) };
    });
    const out = [];
    const wh = srcs.find((s) => s.source === SOURCE.WAREHOUSE);
    if (wh && wh.cap >= need) {
      out.push({ ...wh, qty: need });
      need = 0;
    } else {
      for (const s of srcs) {
        if (s.source === SOURCE.WAREHOUSE || need <= 0 || s.cap <= 0) continue;
        const qty = Math.min(s.cap, need);
        out.push({ ...s, qty });
        need -= qty;
      }
    }
    for (const s of out) {
      held.set(s.k, (held.get(s.k) || 0) + s.qty);
      total += s.qty;
    }
    if (out.length) byLine.set(l.lineId, out);
  }
  return { byLine, total };
}

// §15.1 — Show filter over demand rows (Wholesale order and SKU views).
export const FILTERS = {
  all: { label: "Everything", keep: () => true },
  pending: { label: "Needs allocation", keep: (row) => row.left > 0 },
  blocked: { label: "Cannot be covered", keep: (row) => row.impossible > 0 },
};
