import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { usePanelRequest } from "../../hooks/usePanelRequest.js";
import { clock, fmt, plural, dayMonthYear } from "../../lib/format.js";
import { buildSkuInventory, SKU_FILTERS } from "../../lib/skuInventory.js";
import { Card } from "../allocation-matrix/MetricCards.jsx";
import { SidePanel } from "../allocation-matrix/SidePanel.jsx";

// Master SKU Inventory (mockup vSKU): one row per product. Read-only. A row opens the SKU's side panel; ▸ shows
// its Incoming records (Master SKU subitems, US) — the PO and the containers carrying each one.
const LABELS = ["SKUs sold short", "Out of stock, still selling", "Sellable right now", "Committed to wholesale"];
const PACKING_CHIP = { Final: "wh", Draft: "po", Done: "wh" };

export function SkuInventory({ data, model, status, error, onRefresh, shipments, search, filter, onFilter, onGoShipments, panelRequest }) {
  const inv = useMemo(() => (model && data ? buildSkuInventory(model, data) : null), [model, data]);
  const busy = status === "loading" || status === "refreshing";
  const ready = Boolean(inv);
  const [expanded, setExpanded] = useState({});
  const toggleFilter = (k) => onFilter(filter === k ? "all" : k); // a card activates its filter; a second click goes back

  // Side panel (same rail and trail as the matrix).
  const [rail, setRail] = useState([]);
  const openRecord = (type, id) => setRail([{ type, id: String(id) }]);
  usePanelRequest(panelRequest, openRecord);
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
    if (!inv) return [];
    const keep = inv.is[filter] || inv.is.all;
    return inv.rows.filter((r) => keep(r) && (!q || r.sku.toLowerCase().includes(q) || String(r.name || "").toLowerCase().includes(q)
      || r.incoming.some((x) => x.poName.toLowerCase().includes(q) || x.ships.some((s) => s.code.toLowerCase().includes(q)))));
  }, [inv, filter, q]);

  const fresh = status === "loading" ? "Loading from Monday…" : status === "refreshing" ? "Recalculating with fresh Monday data…"
    : data ? `Calculated from Monday data read at ${clock(data.loadedAt)}` : "";
  const c = inv?.cards;

  return (
    <>
      <div className="page-h">
        <div>
          <h2>Master SKU Inventory</h2>
          <p>One row per product: what is on hand, what is coming, how much is already sold, and whether that adds up.</p>
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
          <Card label="SKUs sold short" value={fmt(c.short.skus)} tone={c.short.skus ? "warn" : ""} filterKey="short" filter={filter} onFilter={toggleFilter}
            sub={c.short.skus ? `${fmt(c.short.units)} units sold with no stock behind them` : "Every product can cover what is sold"} />
          <Card label="Out of stock, still selling" value={fmt(c.oos)} tone={c.oos ? "warn" : ""} filterKey="oos" filter={filter} onFilter={toggleFilter}
            sub={c.oos ? "nothing on hand — depends entirely on arrivals" : "No product is running on empty"} />
          <Card label="Sellable right now" value={fmt(c.sellable.now)} filterKey="free" filter={filter} onFilter={toggleFilter}
            sub={`plus ${fmt(c.sellable.soon)} units arriving and still unclaimed`} />
          <Card label="Committed to wholesale" value={fmt(c.committed.units)} filterKey="unalloc" filter={filter} onFilter={toggleFilter} cta="See what's unassigned"
            sub={c.committed.unassignedSkus ? `${plural(c.committed.unassignedSkus, "SKU still has", "SKUs still have")} units to assign` : "Nothing left to assign"} />
        </div>
      )}

      <div className="fbar">
        <span className="fl">Show</span>
        {Object.entries(SKU_FILTERS).map(([k, f]) => (
          <button key={k} type="button" className={`fchip ${filter === k ? "on" : ""}`} aria-pressed={filter === k} onClick={() => onFilter(k)}>
            {f.label}{inv && <i>{fmt(inv.counts[k])}</i>}
          </button>
        ))}
        {q && inv && <span className="fnote">{fmt(shown.length)} of {plural((inv.rows.filter(inv.is[filter] || inv.is.all)).length, "product", "products")} match “{search.trim()}”</span>}
      </div>

      {inv && !shown.length ? (
        <section className="card">
          <div className="mx-empty"><b className="cc-empty-t">No product matches this {q ? "search" : "filter"}.</b>
            {q ? "Try another SKU, product name, PO or container." : "Switch back to All products to see the full catalogue."}</div>
        </section>
      ) : inv && (
        <section className="card">
          <div className="tw">
            <table className="skt">
              <thead>
                <tr>
                  <th className="sk-prod">Product</th><th className="sk-sku">SKU</th><th className="r">On hand</th><th className="r">In transit</th>
                  <th className="r">On order</th><th className="r">Sold</th><th className="r">Unassigned</th><th className="r">Free to sell</th>
                  <th className="sk-cover">Cover</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const op = Boolean(expanded[r.sku]);
                  const has = r.incoming.length > 0;
                  return (
                    <Fragment key={r.sku}>
                      <tr className="clickable" onClick={() => openRecord("sku", r.sku)} tabIndex={0}
                        onKeyDown={(e) => e.key === "Enter" && openRecord("sku", r.sku)}>
                        <td className="sk-prod">
                          <span className="sk-name">
                            {has ? (
                              <button type="button" className="exp" aria-expanded={op} aria-label={`${op ? "Hide" : "Show"} incoming records of ${r.sku}`}
                                onClick={(e) => { e.stopPropagation(); setExpanded((cur) => ({ ...cur, [r.sku]: !op })); }}>{op ? "▾" : "▸"}</button>
                            ) : <span className="exp" aria-hidden="true">·</span>}
                            <span>{r.name}</span>
                          </span>
                        </td>
                        <td className="strong sk-sku">{r.sku}</td>
                        <td className={`r ${r.onHand ? "" : "muted"}`}>{fmt(r.onHand)}</td>
                        <td className="r sk-it">{fmt(r.inTransit)}</td>
                        <td className="r sk-po">{fmt(r.onOrder)}</td>
                        <td className="r">{r.sold ? fmt(r.sold) : "—"}</td>
                        <td className={`r ${r.need ? "strong sk-gap" : "muted"}`}>{r.need ? fmt(r.need) : "—"}</td>
                        <td className="r strong">{r.free ? fmt(r.free) : "—"}</td>
                        <td className="sk-cover">
                          {r.sold ? (
                            <>
                              <div className="bar"><i className="a" style={{ width: `${r.cover}%` }} />{r.gap > 0 && <i className="d" style={{ width: `${100 - r.cover}%` }} />}</div>
                              <div className="muted sk-cov-t">{r.cover}% of what's sold</div>
                            </>
                          ) : <span className="muted">—</span>}
                        </td>
                        <td><span className={`chip ${r.status.c}`}>{r.status.c !== "mut" && <span className="sq" />}{r.status.t}</span></td>
                      </tr>
                      {op && has && (
                        <>
                          <tr className="subhead">
                            <th>Incoming record</th><th>Purchase order</th><th>Shipment</th><th>ETA</th><th>Arrival</th>
                            <th className="r">Travelling</th><th className="r">Still to ship</th><th colSpan={3}>Packing list</th>
                          </tr>
                          {r.incoming.map((x) => (
                            <tr key={x.key} className={`sub ${x.poId ? "clickable" : ""}`} onClick={() => x.poId && openRecord("po", x.poId)}>
                              <td>{x.name}</td>
                              <td>{x.poName ? <span className="chip po"><span className="sq" />{x.poName}</span> : <span className="muted">—</span>}</td>
                              <td className="sk-ships">
                                {x.ships.length ? x.ships.map((s) => (s.containerId ? (
                                  <button key={s.recordId} type="button" className="chip it" onClick={(e) => { e.stopPropagation(); openRecord("ship", s.containerId); }}>
                                    <span className="sq" />{s.code} · {fmt(s.qty)}
                                  </button>
                                ) : <span key={s.recordId} className="chip mut">{fmt(s.qty)} on a container not found</span>)) : <span className="muted">not shipped yet</span>}
                              </td>
                              <td>{x.eta ? dayMonthYear(x.eta) : <span className="muted">—</span>}</td>
                              <td><span className={`chip ${x.arrival === "Confirmed" ? "wh" : "mut"}`}>{x.arrival === "Confirmed" && <span className="sq" />}{x.arrival}</span></td>
                              <td className="r sk-it">{fmt(x.travelling)}</td>
                              <td className="r">{fmt(x.toShip)}</td>
                              <td colSpan={3} className="sk-ships">
                                {x.ships.length ? x.ships.map((s) => (
                                  <span key={s.recordId} className={`chip ${PACKING_CHIP[s.packingList] || "mut"}`}>{PACKING_CHIP[s.packingList] && <span className="sq" />}{s.packingList || "—"}</span>
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
