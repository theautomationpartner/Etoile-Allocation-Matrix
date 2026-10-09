import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { usePanelRequest } from "../../hooks/usePanelRequest.js";
import { clock, fmt, plural, dayMonthYear } from "../../lib/format.js";
import { buildPurchaseOrders, PO_FILTERS } from "../../lib/purchaseOrders.js";
import { Card } from "../allocation-matrix/MetricCards.jsx";
import { SidePanel } from "../allocation-matrix/SidePanel.jsx";

// Purchase Orders (mockup vPO): one row per US purchase order. Read-only. A row opens the PO's side panel, a
// shipment chip the container's; ▸ shows its line items (one per SKU), and a line opens the SKU's panel.
const LABELS = ["Open purchase orders", "Nothing shipped yet", "Already sold to customers", "Arrives after a cancel date"];
const STATUS_CHIP = { "Fully Arrived": "wh", "Partially Arrived": "po" };

export function PurchaseOrders({ data, model, status, error, onRefresh, shipments, search, filter, onFilter, onGoShipments, panelRequest }) {
  const po = useMemo(() => (model && data ? buildPurchaseOrders(model, data) : null), [model, data]);
  const busy = status === "loading" || status === "refreshing";
  const ready = Boolean(po);
  const [expanded, setExpanded] = useState({});
  const toggleFilter = (k) => onFilter(filter === k ? "all" : k); // a card activates its filter; a second click goes back
  const toggle = (id) => setExpanded((cur) => ({ ...cur, [id]: !cur[id] }));

  // Side panel (same rail and trail as the matrix).
  const [rail, setRail] = useState([]);
  const openRecord = (type, id) => setRail([{ type, id: String(id) }]);
  usePanelRequest(panelRequest, openRecord);
  const openFrom = (e, type, id) => { e.stopPropagation(); openRecord(type, id); };
  const panel = {
    onOpen: (type, id) => setRail((cur) => [...cur, { type, id: String(id) }]),
    onTrail: (i) => setRail((cur) => cur.slice(0, i + 1)),
    onClose: () => setRail([]),
    onGoShipments(orderId) { setRail([]); onGoShipments(orderId); },
  };
  const escRef = useRef(null);
  escRef.current = () => rail.length && setRail([]);
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && escRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const q = search.trim().toLowerCase();
  const shown = useMemo(() => {
    if (!po) return [];
    const keep = po.is[filter] || po.is.all;
    const has = (t) => String(t || "").toLowerCase().includes(q);
    return po.rows.filter((r) => keep(r) && (!q || has(r.name) || has(r.reference) || has(r.supplier) || r.ships.some((s) => has(s.code)) || r.customers.some(has)
      || r.lines.some((l) => has(l.sku) || has(l.name) || l.soldTo.some((s) => has(s.number)))));
  }, [po, filter, q]);

  const fresh = status === "loading" ? "Loading from Monday…" : status === "refreshing" ? "Recalculating with fresh Monday data…"
    : data ? `Calculated from Monday data read at ${clock(data.loadedAt)}` : "";
  const c = po?.cards;

  return (
    <>
      <div className="page-h">
        <div>
          <h2>Purchase Orders</h2>
          <p>What has been ordered from suppliers and how much of it is already sold. "Still to ship" excludes anything the supplier has already put on a container.</p>
        </div>
      </div>

      {error && (
        <div className="note warn" role="alert">
          <b>{ready ? "Refresh failed." : "Monday could not be read."}</b> {error}
          {ready && ` Showing the figures loaded at ${clock(data.loadedAt)}.`}{" "}
          <button type="button" className="btn" onClick={onRefresh}>Try again</button>
        </div>
      )}

      <div className="kpi-bar">
        <span className="fresh" aria-live="polite">{fresh}</span>
        <button type="button" className="btn refresh" onClick={onRefresh} disabled={busy} title="Read every board again from Monday and recalculate all figures">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" className={busy ? "spin" : ""}>
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
          </svg>
          Refresh
        </button>
      </div>

      {!c ? (
        <div className="kpis">
          {LABELS.map((label) => (
            <div key={label} className="kpi" aria-busy="true">
              <div className="lab">{label}</div>
              <div className="val"><span className="sk v" /></div>
              <div className="sub"><span className="sk s" /></div>
            </div>
          ))}
        </div>
      ) : (
        <div className="kpis">
          <Card label={LABELS[0]} value={fmt(c.open.pos)} filterKey="open" filter={filter} onFilter={toggleFilter}
            sub={`${fmt(c.open.toShip)} units not shipped by suppliers yet`} />
          <Card label={LABELS[1]} value={fmt(c.untouched)} tone={c.untouched ? "warn" : ""} filterKey="untouched" filter={filter} onFilter={toggleFilter}
            sub={c.untouched ? "no packing list has arrived for these" : "Every open PO has started shipping"} />
          <Card label={LABELS[2]} value={fmt(c.promised)} filterKey="promised" filter={filter} onFilter={toggleFilter}
            sub={c.promised ? "these POs cannot slip without breaking a sale" : "No PO is carrying a customer promise"} />
          <Card label={LABELS[3]} value={fmt(c.late)} tone={c.late ? "warn" : ""} filterKey="late" filter={filter} onFilter={toggleFilter}
            sub={c.late ? "the stock lands too late for the order it covers" : "All committed POs land in time"} />
        </div>
      )}

      <div className="fbar">
        <span className="fl">Show</span>
        {Object.entries(PO_FILTERS).map(([k, f]) => (
          <button key={k} type="button" className={`fchip ${filter === k ? "on" : ""}`} aria-pressed={filter === k} onClick={() => onFilter(k)}>
            {f.label}{po && <i>{fmt(po.counts[k])}</i>}
          </button>
        ))}
        {q && po && <span className="fnote">{fmt(shown.length)} of {plural(po.rows.filter(po.is[filter] || po.is.all).length, "purchase order", "purchase orders")} match “{search.trim()}”</span>}
      </div>

      {po && !shown.length ? (
        <section className="card">
          <div className="mx-empty">
            <b className="cc-empty-t">{q ? "No purchase order matches this search." : "No purchase order matches this filter."}</b>
            {q ? "Try another PO, reference, supplier, SKU, container or retailer." : "Switch back to All POs to see everything."}
          </div>
        </section>
      ) : po && (
        <section className="card">
          <div className="tw">
            <table className="pot">
              <thead>
                <tr>
                  <th className="po-name">Purchase order</th><th>Supplier</th><th>ETA</th>
                  <th className="r">Ordered</th><th className="r">Arrived</th><th className="r">Shipped</th><th className="r">Still to ship</th>
                  <th className="po-prog">Progress</th><th>Shipments</th><th>Sold to</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const op = Boolean(expanded[r.id]);
                  return (
                    <Fragment key={r.id}>
                      <tr className="clickable" onClick={() => openRecord("po", r.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && openRecord("po", r.id)}>
                        <td className="po-name">
                          <div className="po-o">
                            <button type="button" className="exp" aria-expanded={op} aria-label={`${op ? "Hide" : "Show"} the line items of ${r.name}`}
                              onClick={(e) => { e.stopPropagation(); toggle(r.id); }}>{op ? "▾" : "▸"}</button>
                            <div>
                              <span className="strong">{r.name}</span>
                              <div className="muted po-meta">{[r.reference, r.status.toLowerCase()].filter(Boolean).join(" · ")}</div>
                            </div>
                          </div>
                        </td>
                        <td className="po-sup" title={r.supplier}>{r.supplier || <span className="muted">—</span>}</td>
                        <td className="po-date">
                          {r.eta ? <>{dayMonthYear(r.eta)}<div className="muted po-days">{r.days > 0 ? `in ${plural(r.days, "day", "days")}` : "past ETA"}</div></>
                            : <span className="muted">no ETA</span>}
                        </td>
                        <td className="r">{fmt(r.ord)}</td>
                        <td className="r muted">{fmt(r.arr)}</td>
                        <td className="r po-it">{fmt(r.it)}</td>
                        <td className="r strong">{fmt(r.remaining)}</td>
                        <td className="po-prog">
                          <div className="bar"><i className="a" style={{ width: `${r.doneP}%` }} /><i className="b" style={{ width: `${r.shipP}%` }} /></div>
                          <div className="muted po-pct">{r.moving}% on the move</div>
                        </td>
                        <td className="po-chips">
                          {r.ships.length ? r.ships.map((s) => (
                            <button key={s.id} type="button" className="chip it" title={`${fmt(s.qty)} of this PO's units, ${fmt(s.total)} on board in total`} onClick={(e) => openFrom(e, "ship", s.id)}>
                              <span className="sq" />{s.code} · {fmt(s.qty)}
                            </button>
                          )) : <span className="muted">none yet</span>}
                        </td>
                        <td className="po-chips">{r.customers.length ? r.customers.map((k) => <span key={k} className="chip mut">{k}</span>) : <span className="muted">—</span>}</td>
                      </tr>
                      {op && (
                        <>
                          <tr className="subhead">
                            <th>Product</th><th>SKU</th><th>Status</th><th className="r">Ordered</th><th className="r">Arrived</th>
                            <th className="r">Shipped</th><th className="r">Still to ship</th><th className="r">Reserved on PO</th><th colSpan={2}>Sold to (direct + via containers)</th>
                          </tr>
                          {r.lines.map((l) => (
                            <tr key={l.sku} className="sub clickable" onClick={() => openRecord("sku", l.sku)}>
                              <td>{l.name}</td>
                              <td className="strong">{l.sku}</td>
                              <td>{l.status ? <span className={`chip ${STATUS_CHIP[l.status] || "mut"}`}>{STATUS_CHIP[l.status] && <span className="sq" />}{l.status}</span> : <span className="muted">—</span>}</td>
                              <td className="r">{fmt(l.ordered)}</td>
                              <td className="r">{fmt(l.arrived)}</td>
                              <td className="r po-it">{fmt(l.shipped)}</td>
                              <td className="r strong">{fmt(l.toShip)}</td>
                              <td className="r">{fmt(l.reserved)}</td>
                              <td colSpan={2} className="po-chips">
                                {l.soldTo.length ? l.soldTo.map((s) => (
                                  <button key={s.orderId} type="button" className="chip mut" title={s.number} onClick={(e) => openFrom(e, "so", s.orderId)}>
                                    {s.retailerShort || s.number} · {fmt(s.qty)}
                                  </button>
                                )) : <span className="muted">—</span>}
                              </td>
                            </tr>
                          ))}
                        </>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <SidePanel stack={rail} model={model} data={data} shipments={shipments} {...panel} />
    </>
  );
}
