// Wholesale Allocation screen (mockup vWholesale): every order synced from Cin7 (🛍️ Wholesale Allocation, region US)
// and whether it can actually be delivered. Read-only. Open orders (Orders + Pending) take every figure from the
// Allocation Matrix model (engine.js); Fulfilled orders are listed with their quantities only ("Shipped").
//   Unallocated = Left · Impossible = what no source can cover (the matrix's per-line shortfall) · Covered =
//   (allocated + fulfilled) ÷ ordered · Status: Ready to ship (nothing left) / Cannot be covered / Partially allocated.
import { OPEN_ORDER_GROUPS, SOURCE } from "./engine.js";
import { containerCode, orderParts, retailerShort } from "./matrix.js";
import { localToday } from "./shipments.js";

export const URGENT_DAYS = 45; // "Cancel date within 45 days" (mockup)
export const GROUPS = [
  { id: "topics", title: "Orders" },
  { id: "group_mm1730xq", title: "Pending" },
  { id: "group_mm17q5pm", title: "Fulfilled" },
];
export const WH_FILTERS = {
  all: { label: "All orders" },
  unallocated: { label: "Not fully allocated" },
  blocked: { label: "Cannot be covered" },
  urgent: { label: `Cancel date ≤ ${URGENT_DAYS} days` },
  allocated: { label: "Fully allocated" },
};
const STAGE_KIND = { [SOURCE.WAREHOUSE]: "wh", [SOURCE.IN_TRANSIT]: "it", [SOURCE.PO]: "po" };
const KIND_LABEL = { wh: "Warehouse", it: "In transit", po: "On order" };
const SOURCE_LABEL = { wh: "Warehouse Stock", it: "In-Transit", po: "PO Pending" };

const day = (s) => new Date(`${s}T12:00:00`);
const daysBetween = (from, to) => Math.round((day(to) - day(from)) / 864e5);
const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);

// Ledger reservations whose source no longer exists (the engine's orphan units of the line): the raw entries
// with no live counterpart. A PO reservation that moved to its container (pass 0) is not an orphan. When the
// entries cannot be told apart, one chip with the orphan total.
export function orphansOf(raw, x) {
  const followedPos = new Set(x.rawEntries.map((r) => r.followedFrom).filter(Boolean));
  const list = (raw.entries || []).filter((e) => Number(e.qty) > 0
    && !x.rawEntries.some((r) => r.source === e.source && String(r.sourceId) === String(e.sourceId))
    && !(e.source === SOURCE.PO && followedPos.has(e.ref)));
  if (sum(list, (e) => Number(e.qty)) === x.orphan) return list.map((e) => ({ ref: e.ref || String(e.sourceId), source: e.source, sourceId: String(e.sourceId ?? ""), qty: Number(e.qty) }));
  return [{ ref: "", source: "", sourceId: "", qty: x.orphan }];
}

export function buildWholesale(model, data, { today = localToday() } = {}) {
  const lineById = new Map(model.lines.map((l) => [String(l.lineId), l]));
  const allById = new Map(model.allLines.map((x) => [String(x.line.id), x]));
  const containers = new Map((data.containers || []).map((c) => [String(c.id), c]));
  const pos = new Map((data.pos || []).map((p) => [String(p.id), p]));
  const name = (sku, raw) => data.warehouse?.[sku]?.name || raw.name || sku;
  const label = (e) => (e.source === SOURCE.WAREHOUSE ? "Warehouse"
    : e.source === SOURCE.IN_TRANSIT ? containerCode(containers.get(String(e.sourceId))?.name || e.ref || String(e.sourceId))
      : pos.get(String(e.sourceId))?.name || e.ref || String(e.sourceId));

  const open = (data.orders || []).filter((o) => OPEN_ORDER_GROUPS.has(o.group) && o.region === "US");
  const shipped = (data.fulfilledOrders || []).filter((o) => o.region === "US");

  const orderRow = (o, isOpen) => {
    const lines = (o.lines || []).map((raw) => {
      const l = isOpen ? lineById.get(String(raw.id)) : null; // demand row (To ship > 0)
      const x = isOpen ? allById.get(String(raw.id)) : null; // any line of an open order
      const outstanding = Math.max(0, raw.outstanding ?? (raw.ordered || 0) - (raw.fulfilled || 0)); // US Qty Outstanding, as Cin7 leaves it
      const alive = x ? x.entries : [];
      const dead = x && x.orphan > 0 ? orphansOf(raw, x) : [];
      const kinds = [...new Set(alive.map((e) => STAGE_KIND[e.stage]).filter(Boolean))];
      const source = outstanding === 0 ? "Shipped" : !alive.length ? "Unallocated" : kinds.length > 1 ? "Mixed" : SOURCE_LABEL[kinds[0]];
      return {
        id: String(raw.id), sku: raw.sku, name: name(raw.sku, raw),
        ordered: raw.ordered || 0, fulfilled: raw.fulfilled || 0, outstanding,
        allocated: l ? l.allocated : 0, left: l ? l.left : 0, impossible: l ? l.impossible || 0 : 0,
        source, sourceKind: outstanding === 0 || !alive.length ? "mut" : kinds.length > 1 ? "mut" : kinds[0],
        from: [
          ...alive.map((e) => ({ kind: STAGE_KIND[e.stage], label: label(e), from: e.followedFrom || "", qty: e.qty, dead: false })),
          ...dead.map((e) => ({ kind: "gap", label: e.ref ? containerCode(e.ref) : "", from: "", qty: e.qty, dead: true })),
        ],
      };
    });
    const ord = sum(lines, (l) => l.ordered), ful = sum(lines, (l) => l.fulfilled);
    const al = sum(lines, (l) => l.allocated), rem = sum(lines, (l) => l.left), gap = sum(lines, (l) => l.impossible);
    const kinds = new Set();
    for (const l of lines) for (const f of l.from) if (!f.dead) kinds.add(f.kind);
    const { number, so } = orderParts(o.name);
    const days = o.cancelDate ? daysBetween(today, o.cancelDate) : null;
    const status = !isOpen ? { c: "mut", t: "Shipped" } : rem === 0 ? { c: "wh", t: "Ready to ship" } : gap > 0 ? { c: "gap", t: "Cannot be covered" } : { c: "po", t: "Partially allocated" };
    return {
      id: String(o.id), group: o.group, open: isOpen, number, so, retailer: o.retailer || "", retailerShort: retailerShort(o.retailer),
      saleStatus: o.saleStatus || "", cancelDate: o.cancelDate || "", days, lines, skus: lines.length, // subitems of the sale
      // Same formula as the order's side panel (§14.2): rounded down, 100 only when nothing is missing.
      ord, ful, al, rem, gap, pct: ord ? (rem === 0 ? 100 : Math.min(99, Math.floor(((al + ful) / ord) * 100))) : 0, status,
      coveredBy: ["wh", "it", "po"].filter((k) => kinds.has(k)).map((k) => ({ k, t: KIND_LABEL[k] })),
      // SKUs of the order that are short (the SKU's shortfall, as Master SKU "Sold short"), requirements §4.1.
      blockingSkus: [...new Set(lines.filter((l) => (model.impossibleBySku.get(l.sku) || 0) > 0).map((l) => l.sku))],
    };
  };

  const rows = [...open.map((o) => orderRow(o, true)), ...shipped.map((o) => orderRow(o, false))];
  const is = {
    all: () => true,
    unallocated: (r) => r.open && r.rem > 0,
    blocked: (r) => r.gap > 0,
    urgent: (r) => r.open && r.rem > 0 && r.days !== null && r.days <= URGENT_DAYS,
    allocated: (r) => r.open && r.rem === 0,
  };
  const counts = Object.fromEntries(Object.keys(WH_FILTERS).map((k) => [k, rows.filter(is[k]).length]));
  const blocked = rows.filter(is.blocked);
  const unalloc = rows.filter(is.unallocated);
  return {
    rows,
    is,
    counts,
    cards: {
      blocked: { orders: blocked.length, units: sum(blocked, (r) => r.gap) },
      waiting: { units: sum(rows.filter((r) => r.open), (r) => r.rem), orders: unalloc.length },
      blockingSkus: [...new Set(blocked.flatMap((r) => r.blockingSkus))],
      urgent: counts.urgent,
    },
  };
}
