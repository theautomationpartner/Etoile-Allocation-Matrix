// Allocation Matrix — calculation engine (pure functions, no I/O).
// Every rule cites the section of "Allocation Matrix — Functional & Technical Requirements"
// or the client decision that replaced it.
//
// Input (normalized by the loader):
//   orders:     [{ id, name, group, region, cancelDate, lines: [{ id, sku, outstanding, entries: [{ source, sourceId, ref, qty }] }] }]
//   warehouse:  { [sku]: { itemId, name, usQty } }
//   containers: [{ id, name, group, location, eta, packingList, lines: [{ id, sku, qty, poRef }] }]   (all groups)
//   pos:        [{ id, name, reference, region, eta, lines: [{ id, sku, qtyOutstanding }] }]

export const OPEN_ORDER_GROUPS = new Set(["topics", "group_mm1730xq"]); // Orders + Pending (§5.1)
export const ACTIVE_CONTAINER_GROUP = "topics"; // In-Transit Shipments (Items) (§6.2)
export const SOURCE = { WAREHOUSE: "warehouse", IN_TRANSIT: "intransit", PO: "po" };

// Client rule (2026-09-30): the warehouse takes part when its free units cover at least half of
// the line. Used both to move a landed container's reservation to warehouse stock and for drafts.
export const WAREHOUSE_MIN_COVER = 0.5;

const n = (v) => (Number.isFinite(v) ? v : 0);
const etaKey = (eta) => (eta ? eta : "9999-12-31");
const byEta = (a, b) => etaKey(a.eta).localeCompare(etaKey(b.eta));
const byCancel = (a, b) => (a.order.cancelDate || "9999-12-31").localeCompare(b.order.cancelDate || "9999-12-31") || a.index - b.index;

// TBD-07 (verified with real data): a container subitem's "PO Reference" holds the PO item *Name*.
export function buildModel(data, { poRefKey = (po) => po.name } = {}) {
  const warehouse = data.warehouse || {};

  // §5.1 / §11.2 — demand: Orders + Pending groups, region US.
  const orders = (data.orders || []).filter((o) => OPEN_ORDER_GROUPS.has(o.group) && o.region === "US");

  // §6.2 — in-transit supply: group topics + Location US + Packing List not "Done".
  const isDone = (c) => c.packingList === "Done";
  const containers = (data.containers || []).filter((c) => c.group === ACTIVE_CONTAINER_GROUP && c.location === "US" && !isDone(c)).sort(byEta);
  // Landed containers (any group, e.g. Archive): their units are warehouse stock now.
  const doneContainerById = new Map((data.containers || []).filter((c) => c.location === "US" && isDone(c)).map((c) => [String(c.id), c]));

  // §6.3 — POs: Destination Region US, only subitems with Qty Outstanding > 0.
  const pos = (data.pos || [])
    .filter((p) => p.region === "US")
    .map((p) => ({ ...p, lines: (p.lines || []).filter((l) => n(l.qtyOutstanding) > 0) }))
    .sort(byEta);

  const containerById = new Map(containers.map((c) => [String(c.id), c]));
  const poById = new Map(pos.map((p) => [String(p.id), p]));
  const has = (src, sku) => Boolean(src?.lines.some((l) => l.sku === sku));

  // ── Source totals (§6) ──
  const whTotal = (sku) => Math.max(0, n(warehouse[sku]?.usQty)); // 🇺🇸 US qty, never US Availability (§6.1, rule 3)
  const containerTotal = (c, sku) => c.lines.reduce((s, l) => (l.sku === sku ? s + n(l.qty) : s), 0);
  // Rule 2 — units of a PO already on a container in transit are offered by the container, not the PO.
  const poShipped = (po, sku) => {
    const key = poRefKey(po);
    return containers.reduce((s, c) => s + c.lines.reduce((t, l) => (l.sku === sku && l.poRef === key ? t + n(l.qty) : t), 0), 0);
  };
  const poOutstanding = (po, sku) => po.lines.reduce((s, l) => (l.sku === sku ? s + n(l.qtyOutstanding) : s), 0);
  const poTotal = (po, sku) => Math.max(0, poOutstanding(po, sku) - poShipped(po, sku));

  // ── Pass 1: classify every confirmed entry by where its source is today ──
  //   warehouse / intransit / po → active source · done → landed container (decided in pass 2) · null → orphan (§13 rule 4)
  function classify(entry, sku) {
    const id = String(entry.sourceId ?? "");
    if (entry.source === SOURCE.WAREHOUSE) return warehouse[sku] ? SOURCE.WAREHOUSE : null;
    if (entry.source === SOURCE.IN_TRANSIT) {
      if (has(containerById.get(id), sku)) return SOURCE.IN_TRANSIT;
      if (has(doneContainerById.get(id), sku)) return "done";
      return null;
    }
    if (entry.source === SOURCE.PO) return has(poById.get(id), sku) ? SOURCE.PO : null;
    return null;
  }

  const allLines = []; // every line of every open order (Outstanding 0 included: its reservations still hold units)
  let index = 0;
  for (const o of orders) {
    for (const l of o.lines || []) {
      const entries = [];
      let orphan = 0;
      for (const e of l.entries || []) {
        const qty = n(e.qty);
        if (qty <= 0) continue;
        const kind = classify(e, l.sku);
        if (kind === null) orphan += qty;
        else entries.push({ ...e, qty, kind });
      }
      allLines.push({ order: o, line: l, sku: l.sku, toShip: Math.max(0, n(l.outstanding)), entries, orphan, index: index++ });
    }
  }

  // ── Pass 2: reservations on a landed ("Done") container ──
  // They become warehouse stock only when the warehouse's free units of that SKU cover at least half of
  // the line; otherwise they stay In-Transit until the condition is met (re-evaluated on every load).
  const whUsedSoFar = new Map();
  for (const x of allLines) for (const e of x.entries) if (e.kind === SOURCE.WAREHOUSE) whUsedSoFar.set(x.sku, (whUsedSoFar.get(x.sku) || 0) + e.qty);
  for (const x of [...allLines].sort(byCancel)) {
    const done = x.entries.filter((e) => e.kind === "done");
    if (!done.length) continue;
    const free = Math.max(0, whTotal(x.sku) - (whUsedSoFar.get(x.sku) || 0));
    const toWarehouse = Boolean(warehouse[x.sku]) && free >= WAREHOUSE_MIN_COVER * x.toShip;
    for (const e of done) {
      e.stage = toWarehouse ? SOURCE.WAREHOUSE : SOURCE.IN_TRANSIT;
      e.landed = true;
    }
    if (toWarehouse) whUsedSoFar.set(x.sku, (whUsedSoFar.get(x.sku) || 0) + done.reduce((s, e) => s + e.qty, 0));
  }
  for (const x of allLines) for (const e of x.entries) if (!e.stage) e.stage = e.kind;

  // ── Confirmed usage per source (rule 1: all open orders) ──
  const sourceKey = (stage, sourceId, sku) => (stage === SOURCE.WAREHOUSE ? `warehouse||${sku}` : `${stage}|${sourceId}|${sku}`);
  const used = new Map();
  for (const x of allLines) {
    for (const e of x.entries) {
      const k = sourceKey(e.stage, e.sourceId, x.sku);
      used.set(k, (used.get(k) || 0) + e.qty);
    }
  }
  const usedOf = (stage, sourceId, sku) => used.get(sourceKey(stage, sourceId, sku)) || 0;

  // ── Demand rows (§5.2: only Outstanding > 0) ──
  let orphanUnits = 0;
  const lines = [];
  for (const x of allLines) {
    orphanUnits += x.orphan;
    if (x.toShip <= 0) continue;
    const confirmed = x.entries.reduce((s, e) => s + e.qty, 0);
    const allocated = Math.min(confirmed, x.toShip); // §7.1
    lines.push({
      orderId: x.order.id,
      order: x.order,
      lineId: x.line.id,
      sku: x.sku,
      toShip: x.toShip,
      allocated,
      left: Math.max(0, x.toShip - allocated),
      overAllocated: confirmed > x.toShip, // rule 5 — flag for review
      lostSource: x.orphan > 0,
      orphan: x.orphan,
      entries: x.entries,
    });
  }

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

  // Free inventory to draw on — client decision (2026-09-30): the whole catalogue and every source,
  // purchase orders included (the document left POs out). No unit is counted twice: PO units already
  // on a container count once, in the container (rule 2), and landed containers are not in-transit supply.
  const free = { onHand: 0, inTransit: 0, onOrder: 0 };
  for (const sku of Object.keys(warehouse)) free.onHand += whFree(sku);
  for (const c of containers) for (const sku of new Set(c.lines.map((l) => l.sku))) free.inTransit += containerFree(c, sku);
  for (const p of pos) for (const sku of new Set(p.lines.map((l) => l.sku))) free.onOrder += poFree(p, sku);

  // Already allocated: confirmed entries of open orders, split by the units' current stage (§6.5).
  const split = { onHand: 0, inTransit: 0, onOrder: 0 };
  for (const x of allLines) {
    for (const e of x.entries) {
      if (e.stage === SOURCE.WAREHOUSE) split.onHand += e.qty;
      else if (e.stage === SOURCE.IN_TRANSIT) split.inTransit += e.qty;
      else split.onOrder += e.qty;
    }
  }

  const metrics = {
    unitsToAllocate: totalLeft - impossible,
    linesWithLeft: lines.filter((l) => l.left > 0).length,
    draftUnits: drafts.total, // drafts never count, except this subtitle figure (§4)
    impossible,
    shortSkuCount: shortSkus.length,
    freeInventory: free.onHand + free.inTransit + free.onOrder,
    freeSplit: free,
    alreadyAllocated: split.onHand + split.inTransit + split.onOrder,
    allocatedSplit: split,
  };

  // ── Column totals for the header bars (§5.3: committed ÷ total of that source, all SKUs) ──
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  const skusOf = (src) => [...new Set(src.lines.map((l) => l.sku))];
  const whSkus = Object.keys(warehouse);
  const sourceTotals = {
    warehouse: { total: sum(whSkus, whTotal), committed: sum(whSkus, (s) => Math.min(whTotal(s), usedOf(SOURCE.WAREHOUSE, null, s))) },
    containers: new Map(containers.map((c) => [String(c.id), {
      total: sum(skusOf(c), (s) => containerTotal(c, s)),
      committed: sum(skusOf(c), (s) => Math.min(containerTotal(c, s), usedOf(SOURCE.IN_TRANSIT, c.id, s))),
    }])),
    pos: new Map(pos.map((p) => [String(p.id), {
      total: sum(skusOf(p), (s) => poTotal(p, s)),
      committed: sum(skusOf(p), (s) => Math.min(poTotal(p, s), usedOf(SOURCE.PO, p.id, s))),
    }])),
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
    sourceTotals,
    containerTotal,
    poTotal,
    counts: { orders: new Set(lines.map((l) => l.orderId)).size, rows: lines.length },
  };
}

// §9 — drafts: orders by cancel date (soonest first); each line takes what is still free after the
// drafts already proposed to earlier lines, so two drafts never propose the same units.
// §11.3 as changed by the client (TBD-02, 2026-09-30): the warehouse is used when its free units
// cover at least half of the line's Left (it gives what it has, up to Left); otherwise it is skipped.
// Then containers by ETA, then POs by ETA.
export function buildDrafts(lines, sourcesFor) {
  const held = new Map();
  const byLine = new Map();
  let total = 0;
  const ordered = lines.map((l, i) => ({ l, i })).sort((a, b) =>
    (a.l.order.cancelDate || "9999-12-31").localeCompare(b.l.order.cancelDate || "9999-12-31") || a.i - b.i);

  for (const { l } of ordered) {
    let need = l.left;
    if (need <= 0) continue;
    const srcs = sourcesFor(l.sku).map((s) => {
      const k = `${s.source}|${s.sourceId}|${l.sku}`;
      return { ...s, k, cap: Math.max(0, s.free - (held.get(k) || 0)) };
    });
    const out = [];
    const wh = srcs.find((s) => s.source === SOURCE.WAREHOUSE);
    if (wh && wh.cap > 0 && wh.cap >= WAREHOUSE_MIN_COVER * need) {
      const qty = Math.min(wh.cap, need);
      out.push({ ...wh, qty });
      need -= qty;
    }
    for (const s of srcs) {
      if (s.source === SOURCE.WAREHOUSE || need <= 0 || s.cap <= 0) continue;
      const qty = Math.min(s.cap, need);
      out.push({ ...s, qty });
      need -= qty;
    }
    for (const s of out) {
      held.set(s.k, (held.get(s.k) || 0) + s.qty);
      total += s.qty;
    }
    if (out.length) byLine.set(l.lineId, out);
  }
  return { byLine, total };
}

// §15.1 — Show filter over demand rows.
export const FILTERS = {
  all: { label: "Everything", keep: () => true },
  pending: { label: "Needs allocation", keep: (row) => row.left > 0 },
  blocked: { label: "Cannot be covered", keep: (row) => row.impossible > 0 },
};
