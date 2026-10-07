// Step 3 — the allocation editor of one sale line (PDF §8.1, §10) and the Allocation Ledger record it
// writes (format of scripts/migrate-ledger.mjs). Pure functions over the engine model and the raw data.
//
// Editor rows use the matrix column ids: "warehouse", a container id or a PO id.
import { SOURCE, WAREHOUSE_MIN_COVER } from "./engine.js";
import { containerCode, orderParts, retailerShort } from "./matrix.js";
import { LEDGER } from "./mondayWrites.js";
import { fmt, plural, dayMonthYear } from "./format.js";
import { localToday } from "./shipments.js";
import { arrivalLabel } from "./arrival.js";

const KIND = { [SOURCE.WAREHOUSE]: "wh", [SOURCE.IN_TRANSIT]: "it", [SOURCE.PO]: "po" };
const RANK = { wh: 0, it: 1, po: 2 };
// The row (matrix column) a confirmed entry belongs to: its current stage (a landed container whose units
// count as warehouse stock sits in the warehouse row).
export const rowIdOf = (e) => (e.stage === SOURCE.WAREHOUSE ? "warehouse" : String(e.sourceId));
const rowIdOfDraft = (p) => (p.source === SOURCE.WAREHOUSE ? "warehouse" : String(p.sourceId));
const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + (f(x) || 0), 0);
const daysBetween = (from, to) => Math.round((new Date(`${to}T12:00:00`) - new Date(`${from}T12:00:00`)) / 864e5);

export const WAREHOUSE_REF = "Warehouse Stock"; // ref of a warehouse entry (client decision, 2026-10-05)
export const WAREHOUSE_DETAIL = "physical stock at Red Stag + Boxzooka · ready to ship today";
export const RULE_NOTE = "Warehouse stock is only suggested when it covers at least half of the line. After that the container arriving soonest is used, and a purchase order last. Change any of it by hand.";

function containerRow(c, sku, poRefByName) {
  return {
    title: containerCode(c.name),
    meta: `arrives ${c.eta ? dayMonthYear(c.eta) : "no ETA"} · packing list ${c.packingList || "—"}`,
    // §8.1 — one line per PO subitem on board, with the supplier's PO reference.
    lines: c.lines.filter((x) => x.sku === sku).map((x) => `${fmt(x.qty)} from ${poRefByName.get(x.poRef) || x.poRef || "—"}`),
    eta: c.eta,
  };
}
function poRow(p) {
  const supplier = String(p.supplier || "").split(",")[0].trim();
  return {
    title: p.name,
    meta: [p.reference, supplier, `ETA ${p.eta ? dayMonthYear(p.eta) : "—"}`, "supplier has not shipped it yet"].filter(Boolean).join(" · "),
    lines: [],
    eta: p.eta,
  };
}

// The editor of a line: { line, raw, order, sku, title, sub, goal, hasDraft, rows, values, note }.
//   row: { id, k, source, sourceId, title, meta, lines, max, base, supply }
//   max  = free units of the source + what this line already has there (§10)
//   supply = false for a row that only holds this line's units (e.g. a landed container): it can be lowered, not raised
export function editorFor(model, data, lineId, { today = localToday() } = {}) {
  const line = model.lines.find((l) => String(l.lineId) === String(lineId));
  if (!line) return null;
  const order = line.order;
  const raw = (order.lines || []).find((l) => String(l.id) === String(lineId)) || {};
  const sku = line.sku;
  const poRefByName = new Map((data.pos || []).map((p) => [p.name, p.reference || p.name]));
  const containerById = new Map((data.containers || []).map((c) => [String(c.id), c]));
  const poById = new Map((data.pos || []).map((p) => [String(p.id), p]));

  const base = new Map();
  for (const e of line.entries) base.set(rowIdOf(e), (base.get(rowIdOf(e)) || 0) + e.qty);
  const draft = new Map();
  for (const p of model.drafts.byLine.get(line.lineId) || []) draft.set(rowIdOfDraft(p), (draft.get(rowIdOfDraft(p)) || 0) + p.qty);

  const rows = [];
  for (const s of model.sourcesFor(sku)) {
    const id = s.source === SOURCE.WAREHOUSE ? "warehouse" : String(s.sourceId);
    const b = base.get(id) || 0;
    const info = s.source === SOURCE.WAREHOUSE ? { title: "Warehouse", meta: WAREHOUSE_DETAIL, lines: [], eta: "" }
      : s.source === SOURCE.IN_TRANSIT ? containerRow(containerById.get(id), sku, poRefByName) : poRow(poById.get(id));
    const others = Math.max(0, model.usedOf(s.source, s.sourceId, sku) - b);
    if (others > 0) info.meta += ` · ${fmt(others)} already in other orders`;
    rows.push({ id, k: KIND[s.source], source: s.source, sourceId: String(s.sourceId), ...info, base: b, max: s.free + b, supply: true });
  }
  // Units this line holds on a source that no longer offers supply (a landed container still In-Transit, a PO
  // already fully shipped): shown so they can be kept or lowered, never raised.
  for (const [id, b] of base) {
    if (rows.some((r) => r.id === id)) continue;
    const e = line.entries.find((x) => rowIdOf(x) === id);
    const c = e.source === SOURCE.IN_TRANSIT ? containerById.get(id) : null;
    const p = e.source === SOURCE.PO ? poById.get(id) : null;
    const info = c ? containerRow(c, sku, poRefByName) : p ? poRow(p) : { title: e.ref || id, meta: "", lines: [], eta: e.eta || "" };
    rows.push({ id, k: KIND[e.stage] || KIND[e.source], source: e.stage, sourceId: id, ...info, base: b, max: b, supply: false });
  }
  rows.sort((a, b) => RANK[a.k] - RANK[b.k] || String(a.eta || "9999").localeCompare(String(b.eta || "9999")));

  const values = {};
  for (const r of rows) {
    const v = (base.get(r.id) || 0) + (draft.get(r.id) || 0);
    if (v > 0) values[r.id] = Math.min(v, Math.max(r.max, base.get(r.id) || 0));
  }
  const { number, so } = orderParts(order.name);
  const name = data.warehouse?.[sku]?.name;
  const days = order.cancelDate ? daysBetween(today, order.cancelDate) : null;
  const when = order.cancelDate
    ? `cancel date ${dayMonthYear(order.cancelDate)} · ${days >= 0 ? `${plural(days, "day", "days")} left` : `${plural(-days, "day", "days")} past it`}`
    : "no cancel date";
  return {
    line, raw, order, sku, rows, values,
    number,
    title: `Allocate ${sku}${name ? ` - ${name}` : ""} · ${number} / ${retailerShort(order.retailer)}`,
    sub: [so, when].filter(Boolean).join(" · "),
    goal: line.toShip,
    hasDraft: sum([...draft.values()]) > 0,
    note: RULE_NOTE,
  };
}

// §11.3 with the client's 50% rule — what "Suggest a split" fills in: warehouse when its units cover at least
// half of the line, then containers by ETA, then POs by ETA. Caps include what the line already has (§10).
export function suggestSplit(ed) {
  let need = ed.goal;
  const out = {};
  const supply = ed.rows.filter((r) => r.supply && r.max > 0);
  const wh = supply.find((r) => r.k === "wh");
  if (wh && wh.max >= WAREHOUSE_MIN_COVER * need) {
    out[wh.id] = Math.min(wh.max, need);
    need -= out[wh.id];
  }
  for (const r of supply) {
    if (r.k === "wh" || need <= 0) continue;
    const q = Math.min(r.max, need);
    out[r.id] = q;
    need -= q;
  }
  return out;
}

// A typed quantity: whole number between 0 and the row's cap.
export function clampValue(row, raw) {
  let v = parseInt(raw, 10);
  if (Number.isNaN(v) || v < 0) v = 0;
  return { value: Math.min(v, row.max), capped: v > row.max };
}

export const usedOf = (values) => sum(Object.values(values || {}));

// §10 — every field within its cap and the total within To ship. Returns an error message or "".
export function validate(ed, values) {
  for (const r of ed.rows) {
    const v = values[r.id] || 0;
    if (v < 0 || !Number.isInteger(v)) return `${r.title}: enter a whole number of units.`;
    if (v > r.max) return `${r.title} has ${fmt(r.max)} units available for this line. Lower it to ${fmt(r.max)} at most.`;
  }
  const total = usedOf(values);
  if (total > ed.goal) return `This line has ${fmt(ed.goal)} units to ship: the total can be ${fmt(ed.goal)} at most (now ${fmt(total)}).`;
  return "";
}

// §14.1 JSON contract — the confirmed entries the editor's values stand for:
// [{ source, sourceId, ref, qty, eta? (po, intransit), packingDone? (intransit) }]
export function entriesFrom(ed, values, data) {
  const out = [];
  const containerById = new Map((data.containers || []).map((c) => [String(c.id), c]));
  const poById = new Map((data.pos || []).map((p) => [String(p.id), p]));
  const transit = (c, qty, prev) => ({
    source: SOURCE.IN_TRANSIT, sourceId: String(c?.id || prev.sourceId), ref: c?.name || prev?.ref || "", qty,
    eta: c?.eta || prev?.eta || "", packingDone: c ? c.packingList === "Done" : Boolean(prev?.packingDone),
  });
  for (const r of ed.rows) {
    let q = values[r.id] || 0;
    if (q <= 0) continue;
    if (r.id === "warehouse") {
      // Landed containers counted as warehouse stock keep their own record first; the rest is warehouse stock.
      for (const e of ed.line.entries.filter((x) => rowIdOf(x) === "warehouse" && x.source === SOURCE.IN_TRANSIT)) {
        const t = Math.min(q, e.qty);
        if (t > 0) out.push(transit(containerById.get(String(e.sourceId)), t, e));
        q -= t;
      }
      if (q > 0) {
        const prev = ed.line.entries.find((x) => x.source === SOURCE.WAREHOUSE);
        out.push({ source: SOURCE.WAREHOUSE, sourceId: String(data.warehouse?.[ed.sku]?.itemId || prev?.sourceId || ""), ref: WAREHOUSE_REF, qty: q });
      }
    } else if (r.source === SOURCE.IN_TRANSIT) {
      out.push(transit(containerById.get(r.id), q, ed.line.entries.find((x) => String(x.sourceId) === r.id)));
    } else {
      const p = poById.get(r.id);
      const prev = ed.line.entries.find((x) => String(x.sourceId) === r.id);
      out.push({ source: SOURCE.PO, sourceId: r.id, ref: p?.name || prev?.ref || "", qty: q, eta: p?.eta || prev?.eta || "" });
    }
  }
  return out;
}

// Ledger "Status Allocation" by quantities (client decision, 2026-10-07): what the line holds against what it
// still has to ship. Where each part comes from is in the Source Type / Arrival Status of each subitem.
export const ALLOCATION_STATUS = { allocated: "Allocated", partial: "Partially Allocated", over: "Over Allocated", released: "Released" };
export const RELEASED = ALLOCATION_STATUS.released;
export function allocationStatus(reserved, outstanding) {
  if (reserved <= 0) return ALLOCATION_STATUS.released;
  if (reserved > outstanding) return ALLOCATION_STATUS.over;
  return reserved === outstanding ? ALLOCATION_STATUS.allocated : ALLOCATION_STATUS.partial;
}
const TYPE_LABEL = { warehouse: "Warehouse Stock", intransit: "In-Transit", po: "Purchase Order" };
const numericId = (id) => (/^\d+$/.test(String(id || "")) ? Number(id) : null);

// The Ledger record of a sale line: item column values and one subitem per entry (migration format).
// With no entries it is the "Released" record: no units, no connections, empty JSON (§14.1 "Limpiar una línea").
export function ledgerRecord({ order, raw, sku, entries, data, now = new Date() }) {
  const L = LEDGER.col, LS = LEDGER.subCol;
  const { number, so } = orderParts(order.name);
  const whItem = data.warehouse?.[sku];
  const totalOf = (e) => {
    if (e.source === SOURCE.PO) {
      const p = (data.pos || []).find((x) => String(x.id) === String(e.sourceId));
      return p ? sum(p.lines.filter((l) => l.sku === sku), (l) => l.qtyOrdered) : null;
    }
    if (e.source === SOURCE.IN_TRANSIT) {
      const c = (data.containers || []).find((x) => String(x.id) === String(e.sourceId));
      return c ? sum(c.lines.filter((l) => l.sku === sku), (l) => l.qty) : null;
    }
    return whItem ? Math.max(0, whItem.usQty || 0) : null;
  };
  const parts = entries.map((e) => ({ ...e, total: totalOf(e) }));
  const of = (t) => parts.filter((p) => p.source === t);
  const refs = (arr) => [...new Set(arr.map((p) => p.ref).filter(Boolean))].join(", ");
  const total = (arr, f) => String(sum(arr, f));
  const ids = (arr) => [...new Set(arr.map((p) => numericId(p.sourceId)).filter(Boolean))];
  const where = { containerById: new Map((data.containers || []).map((c) => [String(c.id), c])), poById: new Map((data.pos || []).map((p) => [String(p.id), p])) };
  const etas = parts.filter((p) => p.source !== SOURCE.WAREHOUSE && p.eta).map((p) => p.eta).sort();
  const po = of(SOURCE.PO), it = of(SOURCE.IN_TRANSIT), wh = of(SOURCE.WAREHOUSE);
  const iso = now.toISOString();

  const itemValues = {
    [L.key]: String(raw.id),
    [L.sale]: { item_ids: [numericId(order.id)].filter(Boolean) },
    [L.saleId]: so || number,
    [L.sku]: sku,
    ...(numericId(whItem?.itemId) ? { [L.master]: { item_ids: [numericId(whItem.itemId)] } } : {}),
    [L.ordered]: String(raw.ordered ?? ""),
    [L.fulfilled]: String(raw.fulfilled ?? ""),
    [L.outstanding]: String(raw.outstanding ?? ""),
    [L.allocated]: String(sum(parts, (p) => p.qty)),
    [L.status]: { label: allocationStatus(sum(parts, (p) => p.qty), Number(raw.outstanding) || 0) },
    [L.poRel]: { item_ids: ids(po) },
    [L.poRefs]: refs(po),
    [L.poUsed]: total(po, (p) => p.qty),
    [L.poTotal]: total(po, (p) => p.total),
    [L.poUsedTotal]: total(po, (p) => p.qty),
    [L.itRel]: { item_ids: ids(it) },
    [L.itRefs]: refs(it),
    [L.itUsed]: total(it, (p) => p.qty),
    [L.itTotal]: total(it, (p) => p.total),
    [L.itUsedTotal]: total(it, (p) => p.qty),
    [L.whUsed]: total(wh, (p) => p.qty),
    [L.earliestEta]: etas[0] ? { date: etas[0] } : "",
    [L.json]: { text: parts.length ? JSON.stringify(entries) : "" },
    [L.updated]: { date: iso.slice(0, 10), time: iso.slice(11, 19) },
  };
  const subitems = parts.map((p) => ({
    name: p.ref || TYPE_LABEL[p.source],
    values: {
      [LS.type]: { label: TYPE_LABEL[p.source] },
      [LS.sourceId]: String(p.sourceId),
      [LS.ref]: p.ref || "",
      [LS.qty]: String(p.qty),
      ...(p.total !== null ? { [LS.total]: String(p.total) } : {}),
      ...(p.eta ? { [LS.eta]: { date: p.eta } } : {}),
      ...(p.source === SOURCE.IN_TRANSIT ? { [LS.packingDone]: { checked: p.packingDone ? "true" : "false" } } : {}),
      [LS.arrival]: { label: arrivalLabel(p, sku, where) },
    },
  }));
  return { name: `${so || number} | ${sku}`, itemValues, subitems };
}

// Review (client, 2026-10-07) — "Release": a line holds more than it still has to ship (Cin7 shipped units,
// or the order was lowered). The extra units go back to the sources: first what already arrived (warehouse
// stock, plain first, then received containers by ETA — that is what could have shipped), then the farthest
// arrival. Returns null when nothing is extra, else
//   { units, parts: [{ rowId, title, qty }], values }  — values: what stays per editor row (for saveAllocation)
export function releasePlan(line) {
  const units = (line.reservedRaw || 0) - line.toShip;
  if (units <= 0) return null;
  const etaKey = (e) => e.eta || "9999-12-31";
  const arrived = line.rawEntries.filter((e) => e.stage === SOURCE.WAREHOUSE)
    .sort((a, b) => (a.source === SOURCE.WAREHOUSE ? 0 : 1) - (b.source === SOURCE.WAREHOUSE ? 0 : 1) || etaKey(a).localeCompare(etaKey(b)));
  const coming = line.rawEntries.filter((e) => e.stage !== SOURCE.WAREHOUSE).sort((a, b) => etaKey(b).localeCompare(etaKey(a)));
  const left = new Map(line.rawEntries.map((e) => [e, e.qty]));
  const parts = [];
  let need = units;
  for (const e of [...arrived, ...coming]) {
    if (need <= 0) break;
    const t = Math.min(e.qty, need);
    left.set(e, e.qty - t);
    need -= t;
    const title = e.source === SOURCE.WAREHOUSE ? "Warehouse" : e.source === SOURCE.IN_TRANSIT ? containerCode(e.ref || String(e.sourceId)) : e.ref || String(e.sourceId);
    const same = parts.find((p) => p.title === title);
    if (same) same.qty += t;
    else parts.push({ rowId: rowIdOf(e), title, qty: t });
  }
  // What stays per row: never more than the line can actually keep after the source caps (pass 3).
  const keep = new Map();
  for (const e of line.rawEntries) keep.set(rowIdOf(e), (keep.get(rowIdOf(e)) || 0) + left.get(e));
  const capped = new Map();
  for (const e of line.entries) capped.set(rowIdOf(e), (capped.get(rowIdOf(e)) || 0) + e.qty);
  const values = {};
  for (const [id, q] of keep) {
    const v = Math.min(q, capped.get(id) || 0);
    if (v > 0) values[id] = v;
  }
  return { units, parts, values };
}

// §10 toast after Allocate.
export function allocatedMessage({ sku, number, allocated, toShip }) {
  const left = Math.max(0, toShip - allocated);
  return `Allocated · ${sku} for ${number}: ${fmt(allocated)} of ${fmt(toShip)} units${left ? `. ${fmt(left)} still unallocated.` : ". This line is fully covered."}`;
}
