// Allocation Matrix — calculation engine (pure functions, no I/O).
// Every rule cites the section of "Allocation Matrix — Functional & Technical Requirements"
// or the client decision that replaced it.
//
// Input (normalized by the loader):
//   orders:     [{ id, name, group, region, cancelDate, lines: [{ id, sku, ordered, fulfilled, outstanding, lastProcessed, ledgerFulfilled,
//                 entries: [{ source, sourceId, ref, qty }] }] }]
//   warehouse:  { [sku]: { itemId, name, usQty } }
//   containers: [{ id, name, group, location, eta, packingList, lines: [{ id, sku, qty, poRef, poId }] }]   (all groups, no "Is Process")
//   pos:        [{ id, name, reference, region, eta, lines: [{ id, sku, qtyOrdered, qtyOutstanding, qtyArrived, status }] }]
import { containerArrival, inWarehouse } from "./arrival.js";

// Client decision (2026-10-08): only the Orders group is demand. Pending (group_mm1730xq) held old, obsolete
// sales (EIVR114, #ECUS28341): it is not read any more; its Ledger records were archived.
export const OPEN_ORDER_GROUPS = new Set(["topics"]); // Orders (§5.1)
export const ACTIVE_CONTAINER_GROUP = "topics"; // In-Transit Shipments (Items) (§6.2)
export const SOURCE = { WAREHOUSE: "warehouse", IN_TRANSIT: "intransit", PO: "po" };

// Client rule (2026-09-30): the warehouse takes part in a draft when its free units cover at least half
// of the line. The same 50% decides when a partly arrived container line counts as warehouse (arrival.js).
export const WAREHOUSE_MIN_COVER = 0.5;

const n = (v) => (Number.isFinite(v) ? v : 0);
const etaKey = (eta) => (eta ? eta : "9999-12-31");
const byEta = (a, b) => etaKey(a.eta).localeCompare(etaKey(b.eta));
const byCancel = (a, b) => (a.order.cancelDate || "9999-12-31").localeCompare(b.order.cancelDate || "9999-12-31") || a.index - b.index;

// TBD-07 (verified with real data): a container subitem's "PO Reference" holds the PO item *Name*.
export function buildModel(data, { poRefKey = (po) => po.name } = {}) {
  const warehouse = data.warehouse || {};

  // §5.1 / §11.2 — demand: Orders group, region US.
  const orders = (data.orders || []).filter((o) => OPEN_ORDER_GROUPS.has(o.group) && o.region === "US");

  // §6.2 — in-transit supply: group topics + Location US + Packing List not "Done".
  const isDone = (c) => c.packingList === "Done";
  const containers = (data.containers || []).filter((c) => c.group === ACTIVE_CONTAINER_GROUP && c.location === "US" && !isDone(c)).sort(byEta);
  // Landed containers (any group, e.g. Archive): their reservations are checked against the PO's arrivals.
  const doneContainerById = new Map((data.containers || []).filter((c) => c.location === "US" && isDone(c)).map((c) => [String(c.id), c]));

  // §6.3 — POs: Destination Region US, only subitems with Qty Outstanding > 0.
  const pos = (data.pos || [])
    .filter((p) => p.region === "US")
    .map((p) => ({ ...p, lines: (p.lines || []).filter((l) => n(l.qtyOutstanding) > 0) }))
    .sort(byEta);

  const containerById = new Map(containers.map((c) => [String(c.id), c]));
  const poById = new Map(pos.map((p) => [String(p.id), p]));
  const poAllById = new Map((data.pos || []).map((p) => [String(p.id), p])); // every line: arrivals of landed units
  const arrivalOf = (c, sku) => containerArrival(c, sku, poAllById);
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

  // ── Pass 0 — client rule (2026-10-07): a reservation follows its units from the PO to the container ──
  // When units of a PO are loaded on a container the PO stops offering them (rule 2), and a reservation on
  // the PO above what it still offers would be lost. That part moves to the containers carrying units of
  // that PO and SKU (PO connection of the container line, or its PO Reference), the soonest ETA first, only
  // into units of the container nobody holds yet; the earliest cancel date moves first. What no container
  // can take stays on the PO (and pass 3 cuts it).
  const usContainers = (data.containers || []).filter((c) => c.location === "US");
  const rawLines = [];
  for (const o of orders) for (const l of o.lines || []) rawLines.push({ order: o, line: l, entries: (l.entries || []).map((e) => ({ ...e, qty: n(e.qty) })) });
  const onContainer = new Map(); // container|sku → units already reserved there
  const byPoSku = new Map();
  for (const x of rawLines) {
    for (const e of x.entries) {
      if (e.source === SOURCE.IN_TRANSIT) onContainer.set(`${e.sourceId}|${x.line.sku}`, (onContainer.get(`${e.sourceId}|${x.line.sku}`) || 0) + e.qty);
      if (e.source !== SOURCE.PO || e.qty <= 0) continue;
      const k = `${e.sourceId}|${x.line.sku}`;
      if (!byPoSku.has(k)) byPoSku.set(k, []);
      byPoSku.get(k).push({ x, e });
    }
  }
  for (const [k, list] of byPoSku) {
    const sku = list[0].x.line.sku;
    const po = poAllById.get(k.slice(0, k.length - sku.length - 1));
    if (!po) continue;
    const offered = poById.has(String(po.id)) ? poTotal(poById.get(String(po.id)), sku) : 0;
    let excess = list.reduce((s, it) => s + it.e.qty, 0) - offered;
    if (excess <= 0) continue;
    const key = poRefKey(po);
    const dests = usContainers
      .map((c) => ({
        c,
        room: Math.min(
          c.lines.reduce((s, l) => (l.sku === sku && (String(l.poId || "") === String(po.id) || l.poRef === key) ? s + n(l.qty) : s), 0),
          containerTotal(c, sku) - (onContainer.get(`${c.id}|${sku}`) || 0),
        ),
      }))
      .filter((d) => d.room > 0)
      .sort((a, b) => byEta(a.c, b.c));
    if (!dests.length) continue;
    for (const { x, e } of list.sort((a, b) => (a.x.order.cancelDate || "9999-12-31").localeCompare(b.x.order.cancelDate || "9999-12-31"))) {
      let move = Math.min(e.qty, excess);
      for (const d of dests) {
        const t = Math.min(move, d.room);
        if (t <= 0) continue;
        const same = x.entries.find((y) => y.source === SOURCE.IN_TRANSIT && String(y.sourceId) === String(d.c.id));
        if (same) same.qty += t;
        else x.entries.push({ source: SOURCE.IN_TRANSIT, sourceId: String(d.c.id), ref: d.c.name, qty: t, eta: d.c.eta || "", followedFrom: po.name });
        if (same && !same.followedFrom) same.followedFrom = po.name;
        e.qty -= t;
        d.room -= t;
        onContainer.set(`${d.c.id}|${sku}`, (onContainer.get(`${d.c.id}|${sku}`) || 0) + t);
        move -= t;
        excess -= t;
        x.followed = true;
      }
      if (excess <= 0) break;
    }
  }
  for (const x of rawLines) x.entries = x.entries.filter((e) => e.qty > 0);

  // ── Pass 1: classify every confirmed entry by where its source is today ──
  //   warehouse / intransit / po → active source · done → landed container · null → orphan (§13 rule 4)
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
  for (const { order: o, line: l, entries: raw, followed } of rawLines) {
    const entries = [];
    let orphan = 0;
    for (const e of raw) {
      if (e.qty <= 0) continue;
      const kind = classify(e, l.sku);
      if (kind === null) orphan += e.qty;
      else entries.push({ ...e, kind });
    }
    allLines.push({ order: o, line: l, sku: l.sku, toShip: Math.max(0, n(l.outstanding)), entries, orphan, followed: Boolean(followed), index: index++ });
  }

  // ── Pass 2 — client rule (2026-10-07): a container's reservation becomes warehouse stock when its PO confirms
  // the arrival (arrival.js): PO line Fully Arrived, or at least half of it arrived. It keeps its own source (the
  // container, never the Master SKU US qty: "no mix") — only its stage changes. Otherwise it stays In-Transit.
  for (const x of allLines) {
    for (const e of x.entries) {
      if (e.kind === SOURCE.IN_TRANSIT || e.kind === "done") {
        const c = containerById.get(String(e.sourceId)) || doneContainerById.get(String(e.sourceId));
        const a = arrivalOf(c, x.sku);
        e.arrival = a.state;
        e.notDone = a.notDone;
        e.landed = e.kind === "done";
        e.stage = inWarehouse(a.state) ? SOURCE.WAREHOUSE : SOURCE.IN_TRANSIT;
      } else e.stage = e.kind;
    }
    x.reservedRaw = x.entries.reduce((s, e) => s + e.qty, 0); // what the Ledger holds (sources still alive)
    x.rawEntries = x.entries.map((e) => ({ ...e }));
  }

  // ── Pass 3 — client rule (2026-10-06): a source never gives more units of a SKU than it has ──
  // (warehouse: US qty; container: units of the SKU on board; PO: Total of §6.3). Earliest cancel
  // date keeps its units first; what goes over is not allocated and goes back to Left.
  // A container's reservation counts against the container even when it already is warehouse stock.
  const sourceKey = (source, sourceId, sku) => (source === SOURCE.WAREHOUSE ? `warehouse||${sku}` : `${source}|${sourceId}|${sku}`);
  const capOf = (source, sourceId, sku) => {
    if (source === SOURCE.WAREHOUSE) return whTotal(sku);
    if (source === SOURCE.IN_TRANSIT) {
      const c = containerById.get(String(sourceId)) || doneContainerById.get(String(sourceId));
      return c ? containerTotal(c, sku) : 0;
    }
    const p = poById.get(String(sourceId));
    return p ? poTotal(p, sku) : 0;
  };
  const given = new Map();
  for (const x of [...allLines].sort(byCancel)) {
    const kept = [];
    for (const e of x.entries) {
      const k = sourceKey(e.source, e.sourceId, x.sku);
      const q = Math.min(e.qty, Math.max(0, capOf(e.source, e.sourceId, x.sku) - (given.get(k) || 0)));
      if (q < e.qty) {
        x.overSource = (x.overSource || 0) + (e.qty - q);
        (x.overBy ||= []).push({ source: e.source, sourceId: String(e.sourceId), ref: e.ref, reserved: e.qty, kept: q });
      }
      if (q > 0) {
        kept.push(q === e.qty ? e : { ...e, qty: q, reserved: e.qty });
        given.set(k, (given.get(k) || 0) + q);
      }
    }
    x.entries = kept;
  }

  // ── Confirmed usage per source (rule 1: all open orders) ──
  const used = new Map();
  const arrivedOnHand = new Map(); // sku → container units already counted as warehouse stock (reserved)
  for (const x of allLines) {
    for (const e of x.entries) {
      const k = sourceKey(e.source, e.sourceId, x.sku);
      used.set(k, (used.get(k) || 0) + e.qty);
      if (e.source === SOURCE.IN_TRANSIT && e.stage === SOURCE.WAREHOUSE) arrivedOnHand.set(x.sku, (arrivedOnHand.get(x.sku) || 0) + e.qty);
    }
  }
  const usedOf = (source, sourceId, sku) => used.get(sourceKey(source, sourceId, sku)) || 0;

  // ── Demand rows (§5.2: only Outstanding > 0) ──
  let orphanUnits = 0;
  const lines = [];
  for (const x of allLines) {
    orphanUnits += x.orphan;
    if (x.toShip <= 0) continue;
    const confirmed = x.entries.reduce((s, e) => s + e.qty, 0);
    const allocated = Math.min(confirmed, x.toShip); // §7.1
    // Review (client, 2026-10-07): US Qty Fulfilled already reviewed = Last Fulfilled Processed of the Wholesale
    // subitem; while that column is empty, the Ledger's Qty Fulfilled (written with the allocation).
    const fulfilled = n(x.line.fulfilled);
    const base = x.line.lastProcessed ?? x.line.ledgerFulfilled ?? fulfilled;
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
      overSource: x.overSource || 0, // reserved above what its source has (pass 3): not allocated
      overBy: x.overBy || [],
      ordered: n(x.line.ordered),
      fulfilled,
      fulfilledBase: base,
      shippedSince: Math.max(0, fulfilled - base), // shipped in Cin7 since the last review
      reservedRaw: x.reservedRaw, // what the Ledger holds on sources still alive (before the source caps)
      rawEntries: x.rawEntries,
      followed: x.followed, // part of a PO reservation moved to its container (pass 0), not written yet
      entries: x.entries,
    });
  }

  // Lines with nothing left to ship (fully shipped in Cin7) whose Ledger record still holds units: those units
  // stay blocked for other orders until someone releases them (Review). Same shape as a demand row.
  const heldLines = allLines.filter((x) => x.toShip <= 0 && x.reservedRaw > 0).map((x) => {
    const fulfilled = n(x.line.fulfilled);
    const base = x.line.lastProcessed ?? x.line.ledgerFulfilled ?? fulfilled;
    return {
      orderId: x.order.id, order: x.order, lineId: x.line.id, sku: x.sku, toShip: 0, allocated: 0, left: 0,
      ordered: n(x.line.ordered), fulfilled, fulfilledBase: base, shippedSince: Math.max(0, fulfilled - base),
      reservedRaw: x.reservedRaw, rawEntries: x.rawEntries, entries: x.entries, raw: x.line, held: true,
    };
  });

  // ── Free per source (§7.1: Total − Σ confirmed of all open orders) ──
  const whFree = (sku) => Math.max(0, whTotal(sku) - usedOf(SOURCE.WAREHOUSE, null, sku));
  const containerFree = (c, sku) => Math.max(0, containerTotal(c, sku) - usedOf(SOURCE.IN_TRANSIT, c.id, sku));
  const poFree = (po, sku) => Math.max(0, poTotal(po, sku) - usedOf(SOURCE.PO, po.id, sku));

  // Sources for a SKU in proposal order (§11.3): warehouse, containers by ETA, POs by ETA.
  function sourcesFor(sku) {
    const out = [];
    // Total shown for the warehouse: US qty plus the container units already received for reservations.
    if (warehouse[sku]) out.push({ source: SOURCE.WAREHOUSE, sourceId: warehouse[sku].itemId, total: whTotal(sku) + (arrivedOnHand.get(sku) || 0), free: whFree(sku) });
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
    warehouse: {
      total: sum(whSkus, (s) => whTotal(s) + (arrivedOnHand.get(s) || 0)),
      committed: sum(whSkus, (s) => Math.min(whTotal(s), usedOf(SOURCE.WAREHOUSE, null, s)) + (arrivedOnHand.get(s) || 0)),
    },
    containers: new Map(containers.map((c) => [String(c.id), {
      total: sum(skusOf(c), (s) => containerTotal(c, s)),
      committed: sum(skusOf(c), (s) => Math.min(containerTotal(c, s), usedOf(SOURCE.IN_TRANSIT, c.id, s))),
    }])),
    pos: new Map(pos.map((p) => [String(p.id), {
      total: sum(skusOf(p), (s) => poTotal(p, s)),
      committed: sum(skusOf(p), (s) => Math.min(poTotal(p, s), usedOf(SOURCE.PO, p.id, s))),
    }])),
  };

  // Free units of one source for a SKU (editor caps, side panel).
  function freeOf(source, sourceId, sku) {
    if (source === SOURCE.WAREHOUSE) return whFree(sku);
    if (source === SOURCE.IN_TRANSIT) { const c = containerById.get(String(sourceId)); return c ? containerFree(c, sku) : 0; }
    const p = poById.get(String(sourceId));
    return p ? poFree(p, sku) : 0;
  }

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
    poShipped,
    whTotal,
    freeOf,
    usedOf,
    arrivalOf,
    arrivedOnHand,
    allLines,
    heldLines,
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
