// Where the units of a source are (client rules, 2026-10-07). Pure functions over the raw monday data.
//
// A container line (In-Transit subitem: SKU + qty) is confirmed by its PO: the subitem's PO connection
// (board_relation_mm2ef1zr) points to the PO item, and the PO line is the PO subitem with the same SKU.
//   · Packing List "Draft"                         → pending (it never matches the PO before Done)
//   · PO line "Fully Arrived", or Qty Arrived ≥ qty → received: the units are warehouse stock
//   · Qty Arrived ≥ 50% of qty ("Partially Arrived") → partial: counted as warehouse stock too
//   · otherwise: Done → arrived (landed, pending receiving) · Final → pending
//   · no PO connected: Done → received (landed containers in Archive are taken as warehouse stock) · else pending
// Packing List "Final" with the units already arrived in the PO counts like Done, with a notice:
// "arrived in the PO but the container is not marked Done".
//
// The Ledger subitem of each source gets one of six labels (Arrival Status):
//   PO - Pending / PO - Arrived · In-Transit - Pending / In-Transit - Arrived · Warehouse - Pending / Warehouse - Arrived
import { SOURCE, WAREHOUSE_MIN_COVER } from "./engine.js";

export const ARRIVAL = { PENDING: "pending", ARRIVED: "arrived", PARTIAL: "partial", RECEIVED: "received" };
const RANK = { pending: 0, arrived: 1, partial: 2, received: 3 };

export const ARRIVAL_LABEL = {
  poPending: "PO - Pending", poArrived: "PO - Arrived",
  itPending: "In-Transit - Pending", itArrived: "In-Transit - Arrived",
  whPending: "Warehouse - Pending", whArrived: "Warehouse - Arrived",
};
// In-Transit subitem Status (color_mm3kvr2h), written by the app on the lines of containers used by a sale.
export const TRANSIT_LINE_LABEL = { received: "Received", pending: "Arrived – Pending Receiving" };

const n = (v) => (Number.isFinite(v) ? v : 0);
const isDone = (c) => c?.packingList === "Done";

// The PO line of a container line: same SKU in the subitems of the connected PO item.
export function poLineOf(l, poById) {
  const po = l.poId ? poById.get(String(l.poId)) : null;
  return po ? { po, line: (po.lines || []).find((x) => x.sku === l.sku) || null } : { po: null, line: null };
}

// What arrived on a PO line is first the units of its Done containers (client rule: "if it is Done, it all arrived"),
// the earliest ETA first; only what is left can confirm a container that is not Done yet. Without this, a Final
// container would look arrived with units that came on an earlier container of the same PO.
// arrivalIndex(containers, pos) → { poById, done: Map("poId|sku" → [{ cid, lid, eta, qty }]) }
export function arrivalIndex(containers = [], pos = []) {
  const done = new Map();
  for (const c of containers) {
    if (!isDone(c)) continue;
    for (const l of c.lines || []) {
      if (!l.poId) continue;
      const k = `${l.poId}|${l.sku}`;
      if (!done.has(k)) done.set(k, []);
      done.get(k).push({ cid: String(c.id), lid: String(l.id), eta: c.eta || "", qty: n(l.qty) });
    }
  }
  for (const list of done.values()) list.sort((x, y) => x.eta.localeCompare(y.eta) || x.cid.localeCompare(y.cid) || x.lid.localeCompare(y.lid));
  return { poById: new Map(pos.map((p) => [String(p.id), p])), done };
}

// Units of the PO line still free to confirm this container line.
function arrivedFor(c, l, pl, ix) {
  const list = ix.done.get(`${l.poId}|${l.sku}`) || [];
  let before = 0;
  for (const d of list) {
    if (isDone(c) && d.cid === String(c.id) && d.lid === String(l.id)) break;
    before += d.qty;
  }
  return n(pl.qtyArrived) - before;
}

// One container line → { state, notDone }. ix = arrivalIndex(...).
export function lineArrival(c, l, ix) {
  if (c.packingList === "Draft") return { state: ARRIVAL.PENDING, notDone: false };
  const { line: pl } = poLineOf(l, ix.poById);
  if (!pl) return { state: isDone(c) ? ARRIVAL.RECEIVED : ARRIVAL.PENDING, notDone: false };
  const left = arrivedFor(c, l, pl, ix);
  const full = pl.status === "Fully Arrived" || left >= n(l.qty);
  const half = left >= WAREHOUSE_MIN_COVER * n(l.qty);
  const state = full ? ARRIVAL.RECEIVED : half ? ARRIVAL.PARTIAL : isDone(c) ? ARRIVAL.ARRIVED : ARRIVAL.PENDING;
  return { state, notDone: !isDone(c) && (full || half) };
}

// A container and a SKU (the same SKU can come from several POs in one container): the least advanced line decides.
export function containerArrival(c, sku, ix) {
  const lines = (c?.lines || []).filter((l) => l.sku === sku);
  if (!lines.length) return { state: isDone(c) ? ARRIVAL.RECEIVED : ARRIVAL.PENDING, notDone: false };
  const each = lines.map((l) => lineArrival(c, l, ix));
  const state = each.reduce((a, b) => (RANK[b.state] < RANK[a] ? b.state : a), ARRIVAL.RECEIVED);
  return { state, notDone: RANK[state] >= RANK.partial && each.some((x) => x.notDone) };
}

// The units of a container line already count as warehouse stock (received, or at least half arrived).
export const inWarehouse = (state) => state === ARRIVAL.RECEIVED || state === ARRIVAL.PARTIAL;

// Arrival Status label of one confirmed entry. containerById: every container; ix = arrivalIndex(...).
export function arrivalLabel(entry, sku, { containerById, ix }) {
  if (entry.source === SOURCE.WAREHOUSE) return ARRIVAL_LABEL.whArrived;
  if (entry.source === SOURCE.PO) {
    const pl = (ix.poById.get(String(entry.sourceId))?.lines || []).find((x) => x.sku === sku);
    const arrived = pl && (n(pl.qtyArrived) > 0 || pl.status === "Fully Arrived" || pl.status === "Partially Arrived");
    return arrived ? ARRIVAL_LABEL.poArrived : ARRIVAL_LABEL.poPending;
  }
  const { state } = containerArrival(containerById.get(String(entry.sourceId)), sku, ix);
  return state === ARRIVAL.RECEIVED ? ARRIVAL_LABEL.whArrived
    : state === ARRIVAL.PARTIAL ? ARRIVAL_LABEL.whPending
      : state === ARRIVAL.ARRIVED ? ARRIVAL_LABEL.itArrived : ARRIVAL_LABEL.itPending;
}

// In-Transit subitem Status of one container line: Received only when the PO got all of it.
export const transitLineLabel = (c, l, ix) =>
  (lineArrival(c, l, ix).state === ARRIVAL.RECEIVED ? TRANSIT_LINE_LABEL.received : TRANSIT_LINE_LABEL.pending);
