import { useEffect, useMemo, useRef, useState } from "react";
import { fmt, plural, dayMonth, dayMonthYear } from "../../lib/format.js";
import { containerCode, orderParts, retailerShort } from "../../lib/matrix.js";
import { SOURCE } from "../../lib/engine.js";
import { pathMatch, pathsFor, sortPaths, sumQ, unitPaths } from "../../lib/paths.js";
import { localToday } from "../../lib/shipments.js";
import { incomingRecords } from "../../lib/skuInventory.js";
import { FULFILLED_GROUP } from "../../lib/monday.js";
import { requestShipmentDeletion, useAppActions } from "../../lib/appActions.js";

// Side panel (PDF §8.3, mockup "rail"): opened from an order, a SKU or a source. Each record shows its
// allocation paths <container, PO or warehouse> → <order> with units; a container also shows its split by
// PO subitem. Links inside the panel open the next record and the trail at the top goes back.
// Only data the app already reads from monday is shown.

const EDGE = { wh: "var(--wh)", it: "var(--it)", po: "var(--po)", so: "var(--ink-3)", gap: "var(--gap)" };
const daysTo = (s) => Math.round((new Date(`${s}T12:00:00`) - new Date(`${localToday()}T12:00:00`)) / 864e5);
const sumBy = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);

function RelRow({ kind, title, meta, qty, onOpen }) {
  return (
    <div className="rel-row" onClick={onOpen} style={onOpen ? undefined : { cursor: "default" }} role={onOpen ? "button" : undefined}>
      <span className="edge" style={{ background: EDGE[kind] || "var(--ink-3)" }} />
      <span className="body"><span className="t">{title}</span><span className="m">{meta}</span></span>
      <span className="q">{qty}</span>
    </div>
  );
}

export function SidePanel({ stack, onOpen, onTrail, onClose, model, data, shipments, onGoShipments }) {
  const open = stack.length > 0;
  const cur = stack[stack.length - 1];
  const prev = stack[stack.length - 2];
  const bodyRef = useRef(null);

  const ctx = useMemo(() => {
    if (!model || !data) return null;
    const containerById = new Map((data.containers || []).map((c) => [String(c.id), c]));
    const poById = new Map((data.pos || []).map((p) => [String(p.id), p]));
    const poByName = new Map((data.pos || []).map((p) => [p.name, p]));
    // Open orders, plus the Fulfilled ones (Wholesale Allocation lists them and their row opens this panel).
    const orderById = new Map([...(data.orders || []), ...(data.fulfilledOrders || [])].map((o) => [String(o.id), o]));
    const paths = unitPaths(model, data);
    const stageDate = (p) => (p.k === "it" ? containerById.get(p.ship)?.eta || "" : p.k === "po" ? poById.get(p.po)?.eta || "" : "");
    const orderLabel = (id) => {
      const o = orderById.get(String(id));
      return { number: orderParts(o?.name).number, retailer: retailerShort(o?.retailer) };
    };
    const name = (s) => {
      if (s.type === "so") return orderLabel(s.id).number;
      if (s.type === "ship") return containerCode(containerById.get(s.id)?.name || s.id);
      if (s.type === "po") return poById.get(s.id)?.name || s.id;
      return s.id;
    };
    const poLabel = (p) => (p.po ? poById.get(p.po)?.name || p.po : p.poRef || "");
    return { containerById, poById, poByName, orderById, paths, stageDate, orderLabel, name, poLabel };
  }, [model, data]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [cur?.type, cur?.id]);

  let body = null;
  if (open && ctx) {
    const props = { id: cur.id, prev, ctx, model, data, onOpen, shipments, onGoShipments };
    body = cur.type === "so" ? <OrderPanel {...props} /> : cur.type === "ship" ? <ShipPanel {...props} />
      : cur.type === "po" ? <POPanel {...props} /> : <SkuPanel {...props} />;
  }

  return (
    <>
      <div className={`scrim ${open ? "on" : ""}`} onClick={onClose} />
      <aside className={`rail ${open ? "on" : ""}`} aria-hidden={!open} aria-label="Record details">
        <div className="rail-top">
          <div className="rail-trail">
            {open && ctx && stack.map((s, i) => (i === stack.length - 1
              ? <span key={i} className="cur">{ctx.name(s)}</span>
              : <span key={i} style={{ display: "contents" }}><button type="button" onClick={() => onTrail(i)}>{ctx.name(s)}</button><span>›</span></span>))}
          </div>
          <button type="button" className="rail-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="rail-body" ref={bodyRef}>{body}</div>
      </aside>
    </>
  );
}

// ── the path table: the one component that shows cross-links ──
function PathTable({ type, id, ctx, onOpen, hl, rollup }) {
  const ps = pathsFor(ctx.paths, type, id);
  if (!ps.length) return <div className="empty-note">Nothing is linked here.</div>;
  const { containerById, poById, orderLabel, stageDate, poLabel } = ctx;
  const OrderTag = ({ oid }) => {
    const o = orderLabel(oid);
    return <button type="button" className="pt-l" onClick={() => onOpen("so", oid)}><b className="eivr sm">{o.number}</b><span className="slash">/</span><span className="ret">{o.retailer}</span></button>;
  };
  const cols = [];
  if (type !== "sku") cols.push({ h: "SKU", key: (p) => p.sku, cell: (p) => <button type="button" className="pt-l" onClick={() => onOpen("sku", p.sku)}><b>{p.sku}</b></button> });
  if (type !== "ship") cols.push({
    h: "Container", key: (p) => `${p.k}|${p.ship || ""}`,
    cell: (p) => {
      if (p.k === "wh") return <><span className="chip wh"><span className="sq" />Warehouse</span><i className="pt-i">on hand</i></>;
      if (p.k === "it") {
        const c = containerById.get(p.ship);
        return <><button type="button" className="chip it" onClick={() => onOpen("ship", p.ship)}><span className="sq" />{containerCode(c?.name || p.ship)}</button><i className="pt-i">lands {dayMonth(c?.eta) || "—"}</i></>;
      }
      if (p.k === "po") return <span className="pt-i" style={{ margin: 0 }}>still at supplier</span>;
      return <span className="chip gap"><span className="sq" />No source</span>;
    },
  });
  if (type !== "po") cols.push({
    h: "From PO", key: (p) => p.po || p.poRef || p.k,
    cell: (p) => {
      if (p.po) return <><button type="button" className="chip po" onClick={() => onOpen("po", p.po)}><span className="sq" />{poLabel(p)}</button>{p.k === "po" && <i className="pt-i">ETA {dayMonth(poById.get(p.po)?.eta) || "—"}</i>}</>;
      if (p.poRef) return <span className="chip po"><span className="sq" />{p.poRef}</span>;
      return <span className="pt-i" style={{ margin: 0 }}>{p.k === "wh" ? "already arrived" : "—"}</span>;
    },
  });
  if (type !== "so") cols.push({
    h: "Customer", key: (p) => p.order || (p.free ? "free" : ""),
    cell: (p) => (p.order
      ? <>{<OrderTag oid={p.order} />}{p.k === "need" && <i className="pt-i" style={{ color: "var(--gap)" }}>waiting</i>}</>
      : <span className="pt-i" style={{ margin: 0 }}>free · not promised</span>),
  });
  const rows = sortPaths(ps, type !== "sku", stageDate);
  const promised = sumQ(ps.filter((p) => p.order && p.k !== "need"));
  const free = sumQ(ps.filter((p) => p.free));
  const need = sumQ(ps.filter((p) => p.k === "need"));
  let prevRow = null;
  return (
    <>
      <div className="pt-wrap">
        <table className="pt">
          <thead><tr>{cols.map((c) => <th key={c.h}>{c.h}</th>)}<th className="q">Units</th></tr></thead>
          <tbody>
            {rows.map((p, i) => {
              let same = Boolean(prevRow);
              const tds = cols.map((c) => {
                same = same && c.key(p) === c.key(prevRow);
                return same ? <td key={c.h} className="rep" /> : <td key={c.h}>{c.cell(p)}</td>;
              });
              const cls = [p.free ? "free" : "", p.k === "need" ? "need" : "",
                prevRow && cols.length && cols[0].key(p) !== cols[0].key(prevRow) ? "brk" : "",
                hl && pathMatch(p, hl.type, hl.id) ? "hl" : ""].filter(Boolean).join(" ");
              prevRow = p;
              return <tr key={i} className={cls}>{tds}<td className="q">{fmt(p.q)}</td></tr>;
            })}
          </tbody>
        </table>
      </div>
      <div className="pt-tot">
        <span><b>{fmt(promised)}</b> promised</span>
        {free > 0 && <span><b>{fmt(free)}</b> free</span>}
        {need > 0 && <span className="bad"><b>{fmt(need)}</b> sold with no source</span>}
      </div>
      {rollup && <Rollup ps={sortPaths(ps.filter((p) => p.k !== "need"), false, stageDate)} type={type} ctx={ctx} />}
    </>
  );
}

// The same units, summed along each axis — every line must give the same total.
function Rollup({ ps, type, ctx }) {
  const tot = sumQ(ps);
  const dims = [];
  if (type !== "ship") dims.push({ h: "By container", f: (p) => (p.k === "wh" ? "Warehouse" : p.k === "it" ? containerCode(ctx.containerById.get(p.ship)?.name || p.ship) : "Not shipped yet") });
  if (type !== "po") dims.push({ h: "By PO", f: (p) => ctx.poLabel(p) || (p.k === "wh" ? "Warehouse (arrived)" : "—") });
  if (type !== "so") dims.push({ h: "By customer", f: (p) => (p.order ? ctx.orderLabel(p.order).retailer : "Free") });
  if (type !== "sku") dims.push({ h: "By SKU", f: (p) => p.sku });
  return (
    <div className="rollup">
      {dims.map((dm) => {
        const m = new Map();
        ps.forEach((p) => m.set(dm.f(p), (m.get(dm.f(p)) || 0) + p.q));
        const s = [...m.values()].reduce((a, b) => a + b, 0);
        return (
          <div key={dm.h} className="ru">
            <span className="ru-h">{dm.h}</span>
            <span className="ru-v">{[...m.entries()].map(([k, v], i) => <span key={k}>{i > 0 && <span className="ru-p">+</span>}{k} <b>{fmt(v)}</b></span>)}</span>
            <span className={`ru-s ${s === tot ? "ok" : "bad"}`}>= {fmt(s)} {s === tot ? "✓" : "✗"}</span>
          </div>
        );
      })}
    </div>
  );
}

// Where you came from × where you are: the units both records share.
function ContextStrip({ prev, cur, ctx }) {
  if (!prev || prev.type === cur.type) return null;
  const both = pathsFor(ctx.paths, prev.type, prev.id).filter((p) => pathMatch(p, cur.type, cur.id));
  if (!both.length) return <div className="ctx"><b>{ctx.name(prev)}</b> has no units linked to <b>{ctx.name(cur)}</b>.</div>;
  const parts = sortPaths(both, false, ctx.stageDate).map((p, i) => {
    const src = p.k === "wh" ? "warehouse" : p.k === "it" ? `${containerCode(ctx.containerById.get(p.ship)?.name || p.ship)}${ctx.poLabel(p) ? ` ← ${ctx.poLabel(p)}` : ""}`
      : p.k === "po" ? `${ctx.poLabel(p)} (not shipped)` : "no source";
    const dst = p.order ? ctx.orderLabel(p.order).retailer : "free";
    return <li key={i}><span>{p.sku} · {src} → {dst}</span><b>{fmt(p.q)}</b></li>;
  });
  return (
    <div className="ctx">
      <div className="ctx-h">You came from <b>{ctx.name(prev)}</b> · {fmt(sumQ(both))} units link it to <b>{ctx.name(cur)}</b></div>
      <ul>{parts.slice(0, 6)}</ul>
      {parts.length > 6 && <div className="pt-more">+ {parts.length - 6} more</div>}
      <div className="ctx-f">Highlighted below.</div>
    </div>
  );
}

// ── an order ──
function OrderPanel({ id, prev, ctx, model, onOpen, shipments, onGoShipments }) {
  const o = ctx.orderById.get(String(id));
  if (!o) return <div className="empty-note">This order is no longer open.</div>;
  const { number, so } = orderParts(o.name);
  const lines = model.lines.filter((l) => String(l.orderId) === String(id));
  const raw = o.lines || [];
  const m = {
    ord: sumBy(raw, (l) => l.ordered), ful: sumBy(raw, (l) => l.fulfilled), outstanding: o.group === FULFILLED_GROUP ? sumBy(raw, (l) => l.outstanding) : sumBy(lines, (l) => l.toShip),
    al: sumBy(lines, (l) => l.allocated), rem: sumBy(lines, (l) => l.left), gap: sumBy(lines, (l) => l.impossible),
    // Reserved on a source that no longer exists (any line of the order, also the fully shipped ones).
    orph: sumBy(model.allLines.filter((x) => String(x.order.id) === String(id)), (x) => x.orphan),
  };
  // §14.2 formula: (fulfilled + allocated) ÷ ordered, rounded down; 100 only when nothing is missing.
  const pct = m.ord ? (m.rem === 0 ? 100 : Math.min(99, Math.floor(((m.ful + m.al) / m.ord) * 100))) : 0;
  const shipped = o.group === FULFILLED_GROUP; // Fulfilled group: shipped, no longer part of the matrix
  const chip = shipped ? <span className="chip mut">Shipped</span>
    : m.rem === 0 ? <span className="chip wh"><span className="sq" />Fully allocated</span>
    : m.gap > 0 ? <span className="chip gap"><span className="sq" />Cannot be covered</span>
    : <span className="chip po"><span className="sq" />Partially allocated</span>;
  const ps = pathsFor(ctx.paths, "so", String(id));
  const late = o.cancelDate ? ps.filter((p) => p.order && ctx.stageDate(p) && ctx.stageDate(p) > o.cancelDate) : [];
  const lateSrc = [...new Set(late.map((p) => (p.k === "it" ? containerCode(ctx.containerById.get(p.ship)?.name || p.ship) : ctx.poLabel(p))))];
  const byShip = new Map(), byPO = new Map();
  ps.forEach((p) => {
    if (!p.order || p.k === "need") return;
    if (p.ship) byShip.set(p.ship, (byShip.get(p.ship) || 0) + p.q);
    const key = p.po || p.poRef;
    if (key) {
      const x = byPO.get(key) || { direct: 0, via: 0, ships: new Set(), po: p.po };
      if (p.k === "po") x.direct += p.q;
      else { x.via += p.q; x.ships.add(containerCode(ctx.containerById.get(p.ship)?.name || p.ship)); }
      byPO.set(key, x);
    }
  });
  const ships = shipments.shipsOf(String(id));
  return (
    <>
      <div className="rail-h"><h3><b className="eivr lg">{number}</b><span className="slash">/</span><span className="ret">{retailerShort(o.retailer)}</span></h3></div>
      <p className="rail-sub">
        {[so, o.retailer, o.region, o.saleStatus].filter(Boolean).join(" · ")}<br />
        {[o.orderDate ? `Ordered ${dayMonthYear(o.orderDate)}` : "", o.cancelDate ? `cancel date ${dayMonthYear(o.cancelDate)}` : "no cancel date"].filter(Boolean).join(" · ")}
      </p>
      <div style={{ marginBottom: 12 }}>{chip} <span className="chip mut">{pct}% allocated</span></div>
      <div className="facts">
        <div className="fact"><div className="l">Ordered</div><div className="v">{fmt(m.ord)}</div></div>
        <div className="fact"><div className="l">Fulfilled</div><div className="v">{fmt(m.ful)}</div></div>
        <div className="fact"><div className="l">Outstanding</div><div className="v">{fmt(m.outstanding)}</div></div>
        <div className="fact"><div className="l">Unallocated</div><div className="v" style={{ color: m.rem ? "var(--gap)" : "inherit" }}>{fmt(m.rem)}</div></div>
      </div>
      <ContextStrip prev={prev} cur={{ type: "so", id: String(id) }} ctx={ctx} />
      {m.gap > 0 && <div className="note warn" style={{ marginBottom: 14 }}><b>{fmt(m.gap)} units cannot be covered.</b> Not enough stock in the warehouse, in transit, or on order. This part of the sale needs a purchase decision.</div>}
      {m.orph > 0 && <div className="note warn" style={{ marginBottom: 14 }}><b>{fmt(m.orph)} units lost their source.</b> They were reserved against a shipment that was deleted and need to be reallocated.</div>}
      {late.length > 0 && <div className="note warn" style={{ marginBottom: 14 }}><b>{fmt(sumQ(late))} units land after the {dayMonthYear(o.cancelDate)} cancel date.</b> They come from {lateSrc.join(", ")}. Move them to an earlier source or ask the retailer to extend the date.</div>}

      <div className="sec">
        <h4>Outbound shipments</h4>
        <div className="rel">
          {ships.length ? ships.map((sh) => (
            <RelRow key={sh.id} kind="it" title={sh.name}
              meta={`${sh.target ? `ships ${dayMonthYear(sh.target)}` : "no ship date yet"} · ${plural(sh.skus.filter((k) => sh.qty[k]).length, "SKU", "SKUs")}`}
              qty={`${fmt(Object.values(sh.qty).reduce((a, b) => a + (b || 0), 0))} u`} onOpen={() => onGoShipments(String(id))} />
          )) : <div className="empty-note">No shipment yet.</div>}
        </div>
      </div>

      <div className="sec">
        <h4>Where every unit comes from <span className="c">{plural(lines.length, "SKU", "SKUs")}</span></h4>
        <PathTable type="so" id={String(id)} ctx={ctx} onOpen={onOpen} hl={prev} />
      </div>

      {byShip.size > 0 && (
        <div className="sec">
          <h4>Containers feeding this order <span className="c">{byShip.size}</span></h4>
          <div className="rel">
            {[...byShip.entries()].map(([s, q]) => {
              const c = ctx.containerById.get(s);
              const pos = [...new Set(ps.filter((p) => p.ship === s).map((p) => ctx.poLabel(p)).filter(Boolean))];
              return <RelRow key={s} kind="it" title={containerCode(c?.name || s)}
                meta={`Arrives ${dayMonthYear(c?.eta) || "—"}${c?.eta && o.cancelDate && c.eta > o.cancelDate ? " · after cancel date" : ""}${pos.length ? ` · units from ${pos.join(" + ")}` : ""}`}
                qty={`${fmt(q)} u`} onOpen={() => onOpen("ship", s)} />;
            })}
          </div>
        </div>
      )}
      {byPO.size > 0 && (
        <div className="sec">
          <h4>Purchase Orders behind this sale <span className="c">{byPO.size}</span></h4>
          <div className="rel">
            {[...byPO.entries()].map(([key, x]) => {
              const po = x.po ? ctx.poById.get(x.po) : ctx.poByName.get(key);
              const how = [x.via ? `${fmt(x.via)} via ${[...x.ships].join(", ")}` : "", x.direct ? `${fmt(x.direct)} reserved on the PO, not shipped yet` : ""].filter(Boolean).join(" · ");
              return <RelRow key={key} kind="po" title={po?.name || key} meta={[po?.reference, how].filter(Boolean).join(" · ")}
                qty={`${fmt(x.via + x.direct)} u`} onOpen={po ? () => onOpen("po", String(po.id)) : undefined} />;
            })}
          </div>
        </div>
      )}
    </>
  );
}

// ── a container ──
function ShipPanel({ id, prev, ctx, model, data, onOpen }) {
  const c = ctx.containerById.get(String(id));
  if (!c) return <div className="empty-note">This container is no longer in Monday.</div>;
  const active = model.containers.some((x) => String(x.id) === String(id));
  const skus = [...new Set(c.lines.map((l) => l.sku))];
  const tot = sumBy(c.lines, (l) => l.qty);
  const committedOf = (sku) => model.usedOf(SOURCE.IN_TRANSIT, c.id, sku);
  const res = active ? model.sourceTotals.containers.get(String(id))?.committed || 0 : sumBy(skus, committedOf);
  const free = active ? sumBy(skus, (k) => model.freeOf(SOURCE.IN_TRANSIT, c.id, k)) : 0;
  const pct = tot ? Math.min(100, Math.round((res / tot) * 100)) : 0;
  const pos = [...new Set(c.lines.map((l) => l.poRef))];
  const days = c.eta ? daysTo(c.eta) : null;
  // The Importer upload that created it (In-Transit / Wholesale Importer, its "In-Transit Shipment" connection).
  const imp = (data.imports || []).find((x) => String(x.shipmentId) === String(c.id));
  return (
    <>
      <div className="rail-h rail-h-act">
        <h3>{containerCode(c.name)}</h3>
        {c.packingList === "Draft" && !c.deletionStatus && <DeleteShipment c={c} model={model} pos={pos} res={res} />}
      </div>
      <p className="rail-sub">{c.name}<br />
        {[c.etd ? `Departed ${dayMonthYear(c.etd)}` : "", c.eta ? `${c.etd ? "arrives" : "Arrives"} ${dayMonthYear(c.eta)} (${days > 0 ? `in ${plural(days, "day", "days")}` : "already landed"})` : "No ETA"].filter(Boolean).join(" · ")}
      </p>
      <div style={{ marginBottom: 12 }}>
        <span className={`chip ${c.packingList === "Final" || c.packingList === "Done" ? "wh" : "po"}`}><span className="sq" />Packing list {c.packingList || "—"}</span>
        {pos.length > 1 && <span className="chip mut" style={{ marginLeft: 4 }}>Consolidated · {pos.length} POs</span>}
        {c.deletionStatus && <span className="chip gap" style={{ marginLeft: 4 }}><span className="sq" />{c.deletionStatus}</span>}
      </div>
      <div className="facts">
        <div className="fact"><div className="l">On board</div><div className="v">{fmt(tot)}</div></div>
        <div className="fact"><div className="l">Committed</div><div className="v" style={{ color: "var(--it)" }}>{fmt(res)}</div></div>
        <div className="fact"><div className="l">Free to allocate</div><div className="v">{fmt(free)}</div></div>
      </div>
      <div className="bar" style={{ marginBottom: 4 }}><i className="b" style={{ width: `${pct}%` }} /></div>
      <ContextStrip prev={prev} cur={{ type: "ship", id: String(id) }} ctx={ctx} />

      <div className="sec">
        <h4>Comes from {pos.length > 1 ? "these Purchase Orders" : "this Purchase Order"} <span className="c">{pos.length}</span></h4>
        <div className="rel">
          {pos.map((ref) => {
            const po = ctx.poByName.get(ref);
            const lines = c.lines.filter((l) => l.poRef === ref);
            const ks = new Set(lines.map((l) => l.sku)).size;
            const supplier = String(po?.supplier || "").split(",")[0].trim();
            return <RelRow key={ref || "none"} kind="po" title={ref || "No PO reference"} meta={[po?.reference, supplier, plural(ks, "SKU", "SKUs")].filter(Boolean).join(" · ")}
              qty={`${fmt(sumBy(lines, (l) => l.qty))} of ${fmt(tot)}`} onOpen={po ? () => onOpen("po", String(po.id)) : undefined} />;
          })}
        </div>
      </div>

      {imp && (
        <div className="sec">
          <h4>Packing list that created it</h4>
          <div className="rel">
            <RelRow kind="mut" title={imp.files[0] || imp.name} meta={["Importer", imp.status, imp.uploaded ? `uploaded ${dayMonthYear(imp.uploaded)}` : ""].filter(Boolean).join(" · ")} qty="" />
          </div>
        </div>
      )}

      <div className="sec">
        <h4>SKUs on board <span className="c">{plural(skus.length, "SKU", "SKUs")} · {plural(c.lines.length, "subitem", "subitems")}</span></h4>
        <div className="rel">
          {skus.map((k) => {
            const subs = c.lines.filter((l) => l.sku === k);
            const q = sumBy(subs, (l) => l.qty), r = Math.min(q, committedOf(k));
            const split = subs.length > 1 ? subs.map((x) => `${fmt(x.qty)} ${ctx.poByName.get(x.poRef)?.reference || x.poRef}`).join(" + ") : ctx.poByName.get(subs[0].poRef)?.reference || subs[0].poRef;
            return <RelRow key={k} kind={r >= q ? "it" : "wh"} title={`${k} · ${data.warehouse?.[k]?.name || k}`}
              meta={[`${fmt(r)} committed · ${fmt(q - r)} free`, split].filter(Boolean).join(" · ")} qty={`${fmt(q)} u`} onOpen={() => onOpen("sku", k)} />;
          })}
        </div>
      </div>

      <div className="sec"><h4>Who gets what</h4><PathTable type="ship" id={String(id)} ctx={ctx} onOpen={onOpen} hl={prev} /></div>

      {c.deletionStatus ? <DeletionSteps status={c.deletionStatus} /> : c.packingList !== "Draft" && (
        <div className="sec">
          <h4>Delete this shipment</h4>
          <div className="empty-note">The packing list is <b>{c.packingList || "not set"}</b>. Only shipments created from a <b>Draft</b> file can be deleted. Switch it back to Draft first if it really needs to be removed.</div>
        </div>
      )}
    </>
  );
}

// §8.3 — while monday deletes the shipment, its Deletion Status steps (read from the board).
const DEL_STEPS = ["Pending Deletion", "Searching Master SKU Records", "Deleting Master SKU Records", "Deleting In Transit Shipment"];
function DeletionSteps({ status }) {
  const at = DEL_STEPS.indexOf(status);
  return (
    <div className="sec">
      <h4>Deletion status</h4>
      {at < 0 ? <div className="note warn"><b>{status}.</b> The deletion stopped in Monday — see the update on the In-Transit item.</div> : (
        <ul className="steps">
          {DEL_STEPS.map((t, j) => <li key={t} className={j < at ? "done" : j === at ? "doing" : ""}><span className="b">{j < at ? "✓" : ""}</span>{t}</li>)}
        </ul>
      )}
    </div>
  );
}

// §8 — "Delete shipment", at the top of a Draft shipment's panel. It opens a warning with what gets undone (§8.2);
// only "Yes, delete it" starts monday's deletion through the server (api/delete-shipment.js → DELETE_SHIPMENT_WEBHOOK).
// The steps then show from the container's Deletion Status.
function DeleteShipment({ c, model, pos, res }) {
  const { toast, refresh } = useAppActions();
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const code = containerCode(c.name);
  const start = async () => {
    setBusy(true);
    setError("");
    try {
      await requestShipmentDeletion(c.id);
      setSent(true);
      setAsk(false);
      toast(`Deletion of ${code} started in Monday. It disappears from the app once Monday finishes.`);
      setTimeout(() => refresh(), 6000); // Deletion Status shows the steps after the next read
    } catch (e) {
      setError(e.message || "The deletion could not be started.");
    } finally {
      setBusy(false);
    }
  };
  const close = () => { if (!busy) { setAsk(false); setError(""); } };
  const orders = new Set(model.allLines.filter((x) => x.entries.some((e) => e.source === SOURCE.IN_TRANSIT && String(e.sourceId) === String(c.id))).map((x) => String(x.order.id)));
  const skus = [...new Set(c.lines.map((l) => l.sku))];
  if (sent) return <span className="chip gap" title="Monday is processing it — refresh to follow its steps"><span className="sq" />Deletion requested</span>;
  return (
    <>
      <button type="button" className="btn danger del-btn" onClick={() => setAsk(true)}>Delete shipment</button>
      {ask && (
        <>
          <div className="scrim on del-scrim" onClick={close} />
          {/* The warning: only "Yes, delete it" calls the deletion webhook. */}
          <div className="ua-dlg del-warn" role="alertdialog" aria-modal="true" aria-labelledby="del-dlg-t" aria-describedby="del-dlg-d">
            <h3 id="del-dlg-t"><span aria-hidden="true">⚠</span> Are you sure you want to delete {code}?</h3>
            <p id="del-dlg-d">This unlinks several associated items. It can't be undone.</p>
            <ul className="cascade">
              <li><span className="s">1</span><span><span className="n">In-Transit</span> — the {code} item, its {plural(c.lines.length, "subitem", "subitems")} and its Process twin are removed.</span></li>
              <li><span className="s">2</span><span><span className="n">Master SKU</span> — the incoming records of {plural(skus.length, "SKU", "SKUs")} lose this shipment; records with no other container go back to <b>Estimated</b>.</span></li>
              <li><span className="s">3</span><span><span className="n">Purchase Orders</span> — {pos.map((ref) => `${ref || "no PO"} gets ${fmt(sumBy(c.lines.filter((l) => l.poRef === ref), (l) => l.qty))} back`).join(", ")} as still-to-ship.</span></li>
              <li><span className="s">4</span><span><span className="n">Importer</span> — the file is marked <b>Deleted in In-Transit</b>. The file stays.</span></li>
            </ul>
            {res > 0 && <p className="del-careful">Careful: {fmt(res)} units are already promised to {plural(orders.size, "wholesale order", "wholesale orders")}. Those reservations will be orphaned and have to be reallocated.</p>}
            {error && <div className="note warn" role="alert">{error}</div>}
            <div className="ua-dlg-b">
              <button type="button" className="btn" onClick={close} disabled={busy} autoFocus>Cancel</button>
              <button type="button" className="btn danger" onClick={start} disabled={busy}>{busy ? "Deleting…" : "Yes, delete it"}</button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ── a purchase order ──
function POPanel({ id, prev, ctx, model, data, onOpen }) {
  const p = ctx.poById.get(String(id));
  if (!p) return <div className="empty-note">This purchase order is no longer in Monday.</div>;
  const skus = [...new Set(p.lines.map((l) => l.sku))];
  const ord = (k) => sumBy(p.lines.filter((l) => l.sku === k), (l) => l.qtyOrdered);
  const arrived = (k) => sumBy(p.lines.filter((l) => l.sku === k), (l) => l.qtyArrived); // Qty Arrived (may exceed Qty Ordered)
  const shipped = (k) => model.poShipped(p, k);
  const left = (k) => model.poTotal(p, k);
  const ships = model.containers.filter((c) => c.lines.some((l) => l.poRef === p.name));
  const supplier = String(p.supplier || "");
  return (
    <>
      <div className="rail-h"><h3>{p.name}</h3></div>
      <p className="rail-sub">
        {[p.reference ? `Reference ${p.reference}` : "", supplier].filter(Boolean).join(" · ")}<br />
        {[p.status, p.region ? `destination ${p.region}` : "", p.date ? `raised ${dayMonthYear(p.date)}` : "", `ETA ${dayMonthYear(p.eta) || "—"}`].filter(Boolean).join(" · ")}
      </p>
      <div className="flow">
        <div className="s-po"><div className="fl">Ordered</div><div className="fv">{fmt(sumBy(skus, ord))}</div></div>
        <div className="s-wh"><div className="fl">Arrived</div><div className="fv">{fmt(sumBy(skus, arrived))}</div></div>
        <div className="s-it"><div className="fl">Shipped</div><div className="fv">{fmt(sumBy(skus, shipped))}</div></div>
        <div><div className="fl">Still to ship</div><div className="fv">{fmt(sumBy(skus, left))}</div></div>
      </div>
      <p className="rail-sub" style={{ marginTop: 8 }}>"Shipped" only counts this PO's own units, even inside containers shared with other POs. "Still to ship" is what the supplier has not put on a container yet.</p>
      <ContextStrip prev={prev} cur={{ type: "po", id: String(id) }} ctx={ctx} />

      <div className="sec">
        <h4>Line items <span className="c">{plural(skus.length, "SKU", "SKUs")}</span></h4>
        <div className="rel">
          {skus.map((k) => {
            const st = p.lines.find((l) => l.sku === k && l.status)?.status || (arrived(k) >= ord(k) && ord(k) > 0 ? "Fully Arrived" : arrived(k) > 0 ? "Partially Arrived" : "Ordered");
            const on = ships.map((c) => [c, sumBy(c.lines.filter((l) => l.sku === k && l.poRef === p.name), (l) => l.qty)]).filter(([, q]) => q > 0);
            return <RelRow key={k} kind="po" title={`${k} · ${data.warehouse?.[k]?.name || k}`}
              meta={`${st} · ordered ${fmt(ord(k))} · arrived ${fmt(arrived(k))} · shipped ${fmt(shipped(k))}${on.length ? ` (${on.map(([c, q]) => `${containerCode(c.name)} ${fmt(q)}`).join(", ")})` : ""}`}
              qty={`${fmt(left(k))} left`} onOpen={() => onOpen("sku", k)} />;
          })}
        </div>
      </div>

      <div className="sec">
        <h4>Containers carrying this PO <span className="c">{ships.length}</span></h4>
        {ships.length ? (
          <div className="rel">
            {ships.map((c) => {
              const mine = sumBy(c.lines.filter((l) => l.poRef === p.name), (l) => l.qty), all = sumBy(c.lines, (l) => l.qty);
              const others = [...new Set(c.lines.map((l) => l.poRef))].filter((x) => x !== p.name);
              return <RelRow key={c.id} kind="it" title={containerCode(c.name)}
                meta={`Arrives ${dayMonthYear(c.eta) || "—"} · packing ${c.packingList || "—"}${others.length ? ` · shared with ${others.join(", ")} (${fmt(all)} on board in total)` : ""}`}
                qty={`${fmt(mine)} u`} onOpen={() => onOpen("ship", String(c.id))} />;
            })}
          </div>
        ) : <div className="empty-note">No packing list has been uploaded against this PO yet, so nothing from it is travelling.</div>}
      </div>

      <div className="sec"><h4>Where this PO's units go</h4><PathTable type="po" id={String(id)} ctx={ctx} onOpen={onOpen} hl={prev} /></div>
    </>
  );
}

// ── a SKU ──
function SkuPanel({ id, prev, ctx, model, data, onOpen }) {
  const w = data.warehouse?.[id];
  const inTransit = sumBy(model.containers, (c) => model.containerTotal(c, id));
  const atSupplier = sumBy(model.pos, (p) => model.poTotal(p, id));
  const need = sumBy(model.lines.filter((l) => l.sku === id), (l) => l.left);
  const gap = model.impossibleBySku.get(id) || 0;
  const freeWh = model.freeOf(SOURCE.WAREHOUSE, null, id);
  const freeIt = sumBy(model.containers, (c) => model.freeOf(SOURCE.IN_TRANSIT, c.id, id));
  const freePo = sumBy(model.pos, (p) => model.freeOf(SOURCE.PO, p.id, id));
  const ps = pathsFor(ctx.paths, "sku", id);
  const nPO = new Set(ps.filter((p) => p.po || p.poRef).map((p) => p.po || p.poRef)).size;
  const nShip = new Set(ps.filter((p) => p.ship && p.k === "it").map((p) => p.ship)).size;
  const nSO = new Set(ps.filter((p) => p.order).map((p) => p.order)).size;
  const incoming = incomingRecords(model, data, id);
  return (
    <>
      <div className="rail-h"><h3>{id}</h3></div>
      <p className="rail-sub">{w?.name || "Not in Master SKU Inventory"}</p>
      <div className="facts">
        <div className="fact"><div className="l">In warehouse</div><div className="v">{fmt(Math.max(0, w?.usQty || 0))}</div></div>
        <div className="fact"><div className="l">In transit</div><div className="v" style={{ color: "var(--it)" }}>{fmt(inTransit)}</div></div>
        <div className="fact"><div className="l">Still at supplier</div><div className="v" style={{ color: "var(--po)" }}>{fmt(atSupplier)}</div></div>
        <div className="fact"><div className="l">Sold, unallocated</div><div className="v" style={{ color: need ? "var(--gap)" : "inherit" }}>{fmt(need)}</div></div>
      </div>
      <div className="flow">
        <div className="s-wh"><div className="fl">Warehouse free</div><div className="fv">{fmt(freeWh)}</div></div>
        <div className="s-it"><div className="fl">In transit free</div><div className="fv">{fmt(freeIt)}</div></div>
        <div className="s-po"><div className="fl">On order free</div><div className="fv">{fmt(freePo)}</div></div>
        <div className={gap ? "s-gap" : ""}><div className="fl">Short by</div><div className="fv">{fmt(gap)}</div></div>
      </div>
      {gap > 0 ? <p className="rail-sub" style={{ color: "var(--gap)", marginTop: 8 }}>{fmt(gap)} units are sold with nothing behind them — not on hand, not travelling, not on order. Someone has to raise a PO or move the cancel date.</p>
        : need > 0 ? <p className="rail-sub" style={{ marginTop: 8 }}>There is enough stock to cover everything sold. {fmt(need)} units just need to be allocated.</p> : null}
      <ContextStrip prev={prev} cur={{ type: "sku", id }} ctx={ctx} />
      <div className="sec">
        <h4>Where every unit goes <span className="c">{plural(nPO, "PO", "POs")} · {plural(nShip, "container", "containers")} · {plural(nSO, "order", "orders")}</span></h4>
        <PathTable type="sku" id={id} ctx={ctx} onOpen={onOpen} hl={prev} rollup />
      </div>
      <div className="sec">
        <h4>Incoming records <span className="c">one per PO, as in Master SKU</span></h4>
        <div className="rel">
          {incoming.length ? incoming.map((x) => (
            <RelRow key={x.key} kind={x.ships.length ? "it" : "po"} title={x.name}
              meta={[x.poName || "No PO", x.ships.length ? `on ${x.ships.map((y) => `${y.code || "a container not found"} (${fmt(y.qty)})`).join(" + ")}` : "no shipment yet", x.arrival,
                x.ships.length && x.toShip ? `${fmt(x.toShip)} still estimated${x.poEta ? ` for ${dayMonth(x.poEta)}` : ""}` : ""].filter(Boolean).join(" · ")}
              qty={x.ships.length ? `${fmt(x.travelling)} travelling` : `${fmt(x.toShip)} to ship`} onOpen={x.poId ? () => onOpen("po", x.poId) : undefined} />
          )) : <div className="empty-note">No open purchase orders for this SKU.</div>}
        </div>
      </div>
    </>
  );
}
