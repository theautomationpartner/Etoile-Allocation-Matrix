// Side panel (PDF §8.3) — every unit as one path: PO → container → customer, as in the mockup's unitPaths.
// Warehouse stock has no PO (it already arrived). Free stock has no customer. Demand with no source has neither.
// Every total of the panel is a sum of paths, so the same units can be rolled up by PO, container or customer
// without being counted twice.
//
// path: { sku, k: "wh"|"it"|"po"|"need", ship, po, poRef, order, q, free }
// Reservations whose source is no longer active are not paths: their units are back in Left (need).
//   ship = container id · po = PO item id (null when only its name is known) · order = wholesale order id
import { SOURCE } from "./engine.js";

const byCancel = (a, b) => (a.order.cancelDate || "9999-12-31").localeCompare(b.order.cancelDate || "9999-12-31");

export function unitPaths(model, data) {
  const out = [];
  const containerById = new Map((data.containers || []).map((c) => [String(c.id), c]));
  const poByName = new Map((data.pos || []).map((p) => [p.name, p]));
  const poIdOf = (ref) => (poByName.has(ref) ? String(poByName.get(ref).id) : null);
  const taken = new Map(); // container|sku|poRef → units already on a path

  // A container's units of a SKU, one entry per PO subitem on board (earliest PO first). In transit the
  // units are co-mingled: this split is bookkeeping only (§8.1 note), the user just picks the container.
  const subsOf = (c, sku) => {
    const m = new Map();
    for (const l of c?.lines || []) if (l.sku === sku) m.set(l.poRef, (m.get(l.poRef) || 0) + l.qty);
    return [...m.entries()].map(([poRef, qty]) => ({ poRef, qty }))
      .sort((a, b) => String(poByName.get(a.poRef)?.eta || "9999").localeCompare(String(poByName.get(b.poRef)?.eta || "9999")));
  };
  function pieces(c, sku, q) {
    const subs = subsOf(c, sku);
    const res = [];
    let left = q;
    for (const s of subs) {
      const k = `${c.id}|${sku}|${s.poRef}`;
      const t = Math.min(Math.max(0, s.qty - (taken.get(k) || 0)), left);
      if (t > 0) {
        res.push({ poRef: s.poRef, q: t });
        taken.set(k, (taken.get(k) || 0) + t);
        left -= t;
      }
    }
    if (left > 0) res.push({ poRef: subs.length ? subs[subs.length - 1].poRef : "", q: left });
    return res;
  }

  for (const l of [...model.lines].sort(byCancel)) {
    const order = String(l.orderId);
    for (const e of l.entries) {
      if (e.stage === SOURCE.WAREHOUSE) out.push({ sku: l.sku, k: "wh", ship: null, po: null, poRef: "", order, q: e.qty });
      else if (e.stage === SOURCE.IN_TRANSIT) {
        const c = containerById.get(String(e.sourceId));
        for (const p of pieces(c, l.sku, e.qty)) out.push({ sku: l.sku, k: "it", ship: String(e.sourceId), po: poIdOf(p.poRef), poRef: p.poRef, order, q: p.q });
      } else out.push({ sku: l.sku, k: "po", ship: null, po: String(e.sourceId), poRef: "", order, q: e.qty });
    }
    if (l.left > 0) out.push({ sku: l.sku, k: "need", ship: null, po: null, poRef: "", order, q: l.left });
  }

  // Free units: nobody has claimed them.
  for (const sku of Object.keys(data.warehouse || {})) {
    const f = model.freeOf(SOURCE.WAREHOUSE, null, sku);
    if (f > 0) out.push({ sku, k: "wh", ship: null, po: null, poRef: "", order: null, q: f, free: true });
  }
  for (const c of model.containers) {
    for (const sku of new Set(c.lines.map((l) => l.sku))) {
      let f = model.freeOf(SOURCE.IN_TRANSIT, c.id, sku);
      for (const s of subsOf(c, sku)) {
        if (f <= 0) break;
        const t = Math.min(f, Math.max(0, s.qty - (taken.get(`${c.id}|${sku}|${s.poRef}`) || 0)));
        if (t > 0) out.push({ sku, k: "it", ship: String(c.id), po: poIdOf(s.poRef), poRef: s.poRef, order: null, q: t, free: true });
        f -= t;
      }
    }
  }
  for (const p of model.pos) {
    for (const sku of new Set(p.lines.map((l) => l.sku))) {
      const f = model.freeOf(SOURCE.PO, p.id, sku);
      if (f > 0) out.push({ sku, k: "po", ship: null, po: String(p.id), poRef: "", order: null, q: f, free: true });
    }
  }
  return out;
}

export function pathMatch(p, type, id) {
  if (type === "sku") return p.sku === id;
  if (type === "so") return p.order === id;
  if (type === "ship") return p.ship === id;
  if (type === "po") return p.po === id;
  return false;
}
export const pathsFor = (paths, type, id) => paths.filter((p) => pathMatch(p, type, id));
export const sumQ = (ps) => ps.reduce((a, p) => a + p.q, 0);

const STAGE_RANK = { wh: 0, it: 1, gap: 2, po: 3, need: 4 };
// stageDate(p) → arrival date of the path's stage ("" for warehouse / no source).
export function sortPaths(ps, skuFirst, stageDate) {
  return ps.slice().sort((a, b) =>
    (skuFirst ? a.sku.localeCompare(b.sku) : 0) ||
    STAGE_RANK[a.k] - STAGE_RANK[b.k] || String(stageDate(a)).localeCompare(String(stageDate(b))) ||
    String(a.ship || "").localeCompare(String(b.ship || "")) || String(a.po || a.poRef || "").localeCompare(String(b.po || b.poRef || "")) ||
    a.sku.localeCompare(b.sku) || (a.free ? 1 : 0) - (b.free ? 1 : 0) || String(a.order || "").localeCompare(String(b.order || "")));
}
