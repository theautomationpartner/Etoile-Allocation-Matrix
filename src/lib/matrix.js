// Step 2 — view model of the matrix in the "Wholesale order" view (§5): one group per open order,
// one row per SKU line, one column per source. Pure function over the engine model.
import { FILTERS, SOURCE } from "./engine.js";
import { rowMatchesSearch } from "./search.js";

// TBD-04 — short retailer label in the group header. Taken from the agreed mockup; other values
// fall back to the dropdown text in capitals.
const RETAILER_SHORT = {
  "Eminent, Inc. dba Revolve Clothing": "REVOLVE",
  Revolve: "REVOLVE",
  Anthropologie: "ANTHROPOLOGIE",
  Anthro: "ANTHROPOLOGIE",
  "MACY'S INC.": "MACY'S",
  BLOOMINGDALES: "BLOOMINGDALE'S",
  "HARRODS LIMITED": "HARRODS",
};
export const retailerShort = (r) => RETAILER_SHORT[r] || String(r || "").toUpperCase();

// "EIVR118 - SO-201939" → number "EIVR118", SO "SO-201939"
export function orderParts(name = "") {
  const m = String(name).match(/^\s*(.*?)\s*-\s+(.+)$/); // "<number> - <SO>"; the number may be missing
  const parts = m ? { number: m[1].trim(), so: m[2].trim() } : { number: String(name).trim(), so: "" };
  if (!parts.number) parts.number = parts.so || "(no number)"; // e.g. "- SO-176618"
  return parts;
}

// §5.3 — container code from the item name: "US / FLEX-4119719 / 40HC" → "FLEX-4119719", "US / Harrods" → "Harrods"
export function containerCode(name = "") {
  const parts = name.split("/").map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && /^(US|AU)$/i.test(parts[0])) parts.shift();
  return (parts[0] || name).replace(/\s*-\s*/g, "-");
}

export function buildOrderMatrix(model, data, { filter = "all", search = "" } = {}) {
  const { warehouse } = data;
  const poRefByName = new Map((data.pos || []).map((p) => [p.name, p.reference || p.name]));
  const containerOf = new Map((data.containers || []).map((c) => [String(c.id), c]));

  // ── Columns (§5.3): Warehouse, containers by ETA, POs by ETA ──
  const cols = [{ k: "wh", id: "warehouse", label: "Warehouse", meta: "on hand", cap: model.sourceTotals.warehouse }];

  // Landed ("Done") containers whose reservations are still In-Transit (warehouse < 50% of the line)
  // get their own column so those units stay visible where they are.
  const landed = new Map();
  for (const l of model.lines) {
    for (const e of l.entries) {
      if (!e.landed || e.stage !== SOURCE.IN_TRANSIT) continue;
      const c = containerOf.get(String(e.sourceId));
      if (c) landed.set(String(c.id), c);
    }
  }
  const containerCols = [
    ...model.containers.map((c) => ({ k: "it", id: String(c.id), ref: c, label: containerCode(c.name), meta: `arrives ${dayMonth(c.eta)}`, cap: model.sourceTotals.containers.get(String(c.id)) })),
    ...[...landed.values()].map((c) => ({ k: "it", id: String(c.id), ref: c, landed: true, label: containerCode(c.name), meta: "landed · Done", cap: null })),
  ].sort((a, b) => (a.ref.eta || "9999").localeCompare(b.ref.eta || "9999"));
  cols.push(...containerCols);

  // A PO column only while some SKU of that PO has Total > 0 (§5.3).
  for (const p of model.pos) {
    const total = model.sourceTotals.pos.get(String(p.id));
    if (total?.total > 0) cols.push({ k: "po", id: String(p.id), ref: p, label: p.name, meta: `ETA ${dayMonth(p.eta)}`, cap: total });
  }

  // Header bar of a landed column: what is still reserved on it ÷ what it brought.
  for (const c of cols.filter((x) => x.landed)) {
    let committed = 0;
    for (const l of model.lines) for (const e of l.entries) if (e.landed && e.stage === SOURCE.IN_TRANSIT && String(e.sourceId) === c.id) committed += e.qty;
    c.cap = { committed, total: c.ref.lines.reduce((s, x) => s + x.qty, 0) };
  }

  // ── Cells ──
  const colMatches = (col, stage, sourceId) =>
    col.k === "wh" ? stage === SOURCE.WAREHOUSE : col.k === "it" ? stage === SOURCE.IN_TRANSIT && String(sourceId) === col.id : stage === SOURCE.PO && String(sourceId) === col.id;

  function cellsFor(line) {
    const srcs = model.sourcesFor(line.sku);
    const draft = model.drafts.byLine.get(line.lineId) || [];
    return cols.map((col) => {
      const a = line.entries.filter((e) => colMatches(col, e.stage, e.sourceId)).reduce((s, e) => s + e.qty, 0);
      const dr = draft.filter((p) => colMatches(col, p.source, p.sourceId)).reduce((s, p) => s + p.qty, 0);
      // A landed container is not supply any more: its column only shows reservations still held there.
      if (col.landed && a <= 0) return { id: col.id, k: col.k, a: 0, dr: 0, av: 0, cap: 0, tot: null, split: "", lbl: "" };
      const src = srcs.find((s) => colMatches(col, s.source, s.sourceId));
      let tot = null, split = "";
      if (col.k === "it") {
        const subs = col.ref.lines.filter((x) => x.sku === line.sku);
        tot = subs.reduce((s, x) => s + x.qty, 0);
        // §8 / §12.1 — same SKU from two POs in one container: show the container's composition.
        const byPo = new Map();
        for (const x of subs) byPo.set(x.poRef, (byPo.get(x.poRef) || 0) + x.qty);
        if (byPo.size > 1) split = [...byPo.entries()].map(([po, q]) => `${q.toLocaleString("en-US")} from ${poRefByName.get(po) || po}`).join(" + ");
      }
      return { id: col.id, k: col.k, a, dr, av: src?.free || 0, cap: src?.total || (tot || 0), tot, split, lbl: `${line.sku} in ${col.label}` };
    });
  }

  // ── Groups (§5.1) and rows (§5.2) ──
  const keep = FILTERS[filter]?.keep || FILTERS.all.keep;
  const searching = Boolean(search.trim());
  const byOrder = new Map();
  for (const l of model.lines) {
    if (!byOrder.has(l.orderId)) byOrder.set(l.orderId, []);
    byOrder.get(l.orderId).push(l);
  }

  const groups = [];
  for (const o of model.orders) {
    const all = byOrder.get(o.id) || [];
    if (!all.length) continue;
    const rows = all
      .filter((l) => keep(l) && rowMatchesSearch(l, search, warehouse))
      .map((l) => ({
        key: l.lineId,
        line: l,
        title: `${l.sku} - ${warehouse[l.sku]?.name || l.sku}`,
        nums: [l.toShip, l.allocated, l.left],
        qty: [l.ordered, l.fulfilled], // US Quantity Ordered · US Qty Fulfilled of the subitem (client request)
        end: l.impossible,
        needs: l.left > 0,
        dr: (model.drafts.byLine.get(l.lineId) || []).reduce((s, p) => s + p.qty, 0),
        cells: cellsFor(l),
      }));
    if ((filter !== "all" || searching) && !rows.length) continue; // a group with no visible rows is hidden (§15.1)
    const { number, so } = orderParts(o.name);
    const sum = (f) => all.reduce((s, l) => s + f(l), 0);
    const left = sum((l) => l.left);
    groups.push({
      key: o.id,
      order: o,
      number,
      retailer: retailerShort(o.retailer),
      meta: [so, o.saleStatus ? o.saleStatus.toLowerCase() : "", o.cancelDate ? `cancel date ${dayMonthYear(o.cancelDate)}` : "no cancel date"].filter(Boolean).join(" · "),
      nums: [sum((l) => l.toShip), sum((l) => l.allocated), left],
      // Whole order, every subitem (fully shipped lines included), as the board's subitem totals.
      qty: [(o.lines || []).reduce((s, l) => s + (Number(l.ordered) || 0), 0), (o.lines || []).reduce((s, l) => s + (Number(l.fulfilled) || 0), 0)],
      end: sum((l) => l.impossible),
      defOpen: left > 0,
      rows,
      roll: cols.map((_, i) => rows.reduce((s, r) => s + r.cells[i].a, 0)),
      // Where each subtotal comes from: the SKU lines allocated from that column (tooltip).
      rollDetail: cols.map((_, i) => rows.filter((r) => r.cells[i].a > 0).map((r) => ({ title: r.title, qty: r.cells[i].a }))),
      allocated: sum((l) => l.allocated),
    });
  }
  // Legend totals for what the matrix is showing (client request: the legend shows real totals
  // instead of the document's static "240" examples).
  const legend = { wh: 0, it: 0, po: 0, draft: 0, free: 0 };
  const skusInView = new Set();
  for (const g of groups) {
    for (const r of g.rows) {
      skusInView.add(r.line.sku);
      legend.draft += r.dr;
      r.cells.forEach((c) => { legend[c.k] += c.a; });
    }
  }
  for (const sku of skusInView) legend.free += model.supplyFree.get(sku) || 0;

  return { cols, groups, legend, rowCount: groups.reduce((s, g) => s + g.rows.length, 0) };
}


const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const parse = (s) => new Date(`${s}T12:00:00`);
function dayMonth(s) { return s ? `${parse(s).getDate()} ${MON[parse(s).getMonth()]}` : "no ETA"; }
function dayMonthYear(s) { return s ? `${dayMonth(s)} ${parse(s).getFullYear()}` : ""; }
