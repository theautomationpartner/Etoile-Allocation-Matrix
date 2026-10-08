import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { clock, fmt, plural, dayMonth, dayMonthYear } from "../../lib/format.js";
import { buildTransit, SOON_DAYS, TRANSIT_FILTERS } from "../../lib/transit.js";
import { Card } from "../allocation-matrix/MetricCards.jsx";
import { SidePanel } from "../allocation-matrix/SidePanel.jsx";

// In-Transit Shipments (mockup vTransit): one row per active container, soonest ETA first. Read-only. A row opens
// the container's side panel, a PO chip the PO's, a customer chip the order's; ▸ shows its subitems (SKU × PO),
// with a total row when a SKU comes from more than one PO (its Committed, Free and Promised to live on that row,
// requirements §5.2), and a subitem opens the SKU's panel. A container monday is deleting is dimmed with its step.
const LABELS = ["Still on the water", `Arriving in ${SOON_DAYS} days`, "Unclaimed units in transit", "Draft packing lists"];

const SPLIT_UNKNOWN = "Monday does not record which PO the promised units come from: see the SKU total above";

const Chip = ({ c, children }) => <span className={`chip ${c}`}>{c !== "mut" && <span className="sq" />}{children}</span>;

export function InTransitShipments({ data, model, status, error, onRefresh, shipments, search, filter, onFilter, onGoShipments }) {
  const tr = useMemo(() => (model && data ? buildTransit(model, data) : null), [model, data]);
  const busy = status === "loading" || status === "refreshing";
  const ready = Boolean(tr);
  const [expanded, setExpanded] = useState({});
  const toggleFilter = (k) => onFilter(filter === k ? "all" : k); // a card activates its filter; a second click goes back
  const toggle = (id) => setExpanded((cur) => ({ ...cur, [id]: !cur[id] }));

  // Side panel (same rail and trail as the matrix).
  const [rail, setRail] = useState([]);
  const openRecord = (type, id) => setRail([{ type, id: String(id) }]);
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
    if (!tr) return [];
    const keep = tr.is[filter] || tr.is.all;
    const has = (t) => String(t || "").toLowerCase().includes(q);
    return tr.rows.filter((r) => keep(r) && (!q || has(r.code) || has(r.name) || r.pos.some((p) => has(p.name)) || r.customers.some(has)
      || r.groups.some((g) => has(g.sku) || has(g.name) || g.subs.some((s) => s.promised.some((p) => has(p.number))))));
  }, [tr, filter, q]);

  const fresh = status === "loading" ? "Loading from Monday…" : status === "refreshing" ? "Recalculating with fresh Monday data…"
    : data ? `Calculated from Monday data read at ${clock(data.loadedAt)}` : "";
  const c = tr?.cards;

  return (
    <>
      <div className="page-h">
        <div>
          <h2>In-Transit Shipments</h2>
          <p>Stock that is paid for and moving. Each container shows how much a customer is already counting on, and how much is still free to sell.</p>
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
          <Card label={LABELS[0]} value={fmt(c.water.shipments)} filterKey="notarrived" filter={filter} onFilter={toggleFilter}
            sub={`${fmt(c.water.units)} units not landed yet`} />
          <Card label={LABELS[1]} value={fmt(c.soon.shipments)} filterKey="soon" filter={filter} onFilter={toggleFilter}
            sub={c.soon.shipments ? `${fmt(c.soon.promised)} units already promised` : "Nothing due this month"} />
          <Card label={LABELS[2]} value={fmt(c.free.units)} filterKey="free" filter={filter} onFilter={toggleFilter}
            sub={c.free.shipments ? `${plural(c.free.shipments, "container carries", "containers carry")} sellable stock` : "Every unit is spoken for"} />
          <Card label={LABELS[3]} value={fmt(c.draft.shipments)} tone={c.draft.promised ? "warn" : ""} filterKey="draft" filter={filter} onFilter={toggleFilter}
            sub={c.draft.shipments ? `${fmt(c.draft.promised)} promised units depend on unconfirmed files` : "All packing lists confirmed"} />
        </div>
      )}

      <div className="fbar">
        <span className="fl">Show</span>
        {Object.entries(TRANSIT_FILTERS).map(([k, f]) => (
          <button key={k} type="button" className={`fchip ${filter === k ? "on" : ""}`} aria-pressed={filter === k} onClick={() => onFilter(k)}>
            {f.label}{tr && <i>{fmt(tr.counts[k])}</i>}
          </button>
        ))}
        {q && tr && <span className="fnote">{fmt(shown.length)} of {plural(tr.rows.filter(tr.is[filter] || tr.is.all).length, "shipment", "shipments")} match “{search.trim()}”</span>}
      </div>

      {tr && !shown.length ? (
        <section className="card">
          <div className="mx-empty">
            <b className="cc-empty-t">{q ? "No shipment matches this search." : "No shipment matches this filter."}</b>
            {q ? "Try another container, PO, SKU, retailer or order." : "Switch back to All shipments to see everything in transit."}
          </div>
        </section>
      ) : tr && (
        <section className="card">
          <div className="tw">
            <table className="trt">
              <thead>
                <tr>
                  <th className="tr-ship">Shipment</th><th>Arrives</th><th>From PO</th><th>Packing list</th>
                  <th className="r">On board</th><th className="r">Committed</th><th className="r">Free</th><th className="tr-claim">Claimed</th>
                  <th>Customers waiting</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const op = Boolean(expanded[r.id]);
                  return (
                    <Fragment key={r.id}>
                      <tr className={`clickable ${r.deletionStatus ? "gone" : ""}`} onClick={() => openRecord("ship", r.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && openRecord("ship", r.id)}>
                        <td className="tr-ship">
                          <div className="tr-o">
                            <button type="button" className="exp" aria-expanded={op} aria-label={`${op ? "Hide" : "Show"} the subitems of ${r.code}`}
                              onClick={(e) => { e.stopPropagation(); toggle(r.id); }}>{op ? "▾" : "▸"}</button>
                            <div>
                              <span className="strong">{r.code}</span>
                              {r.deletionStatus && <span className="chip gap tr-del" title="Monday is deleting this shipment"><span className="sq" />{r.deletionStatus}</span>}
                              <div className="muted tr-meta">
                                {[plural(r.skus, "SKU", "SKUs"), plural(r.subitems, "subitem", "subitems"), r.etd ? `departed ${dayMonth(r.etd)}` : ""].filter(Boolean).join(" · ")}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="tr-date">
                          {r.eta ? <>{dayMonthYear(r.eta)}<div className="muted tr-days">{r.days > 0 ? `in ${plural(r.days, "day", "days")}` : "landed"}</div></>
                            : <span className="muted">no ETA yet</span>}
                        </td>
                        <td className="tr-chips">
                          {r.pos.map((p) => (p.id ? (
                            <button key={p.id} type="button" className="chip po" title={`${fmt(p.qty)} units from ${p.name}`} onClick={(e) => openFrom(e, "po", p.id)}>
                              <span className="sq" />{p.name} · {fmt(p.qty)}
                            </button>
                          ) : <span key={p.name} className="chip po" title={`${fmt(p.qty)} units from ${p.name} (not found in Purchase Orders)`}><span className="sq" />{p.name} · {fmt(p.qty)}</span>))}
                        </td>
                        <td><Chip c={r.packingList === "Final" ? "wh" : "po"}>{r.packingList || "—"}</Chip></td>
                        <td className="r">{fmt(r.total)}</td>
                        <td className="r strong tr-it">{fmt(r.committed)}</td>
                        <td className={`r ${r.free ? "strong" : "muted"}`}>{r.free ? fmt(r.free) : "—"}</td>
                        <td className="tr-claim">
                          <div className="bar"><i className="b" style={{ width: `${r.pct}%` }} /></div>
                          <div className="muted tr-pct">{r.pct}% claimed</div>
                        </td>
                        <td className="tr-chips">{r.customers.length ? r.customers.map((k) => <span key={k} className="chip mut">{k}</span>) : <span className="muted">nobody yet</span>}</td>
                      </tr>
                      {op && (
                        <>
                          <tr className="subhead">
                            <th>Subitem · product</th><th>SKU</th><th className="r">On board</th><th className="r">Committed</th><th className="r">Free</th>
                            <th>From PO</th><th colSpan={3}>Promised to</th>
                          </tr>
                          {r.groups.map((g) => {
                            const multi = g.subs.length > 1;
                            return (
                              <Fragment key={g.sku}>
                                {multi && (
                                  <tr className="sub clickable skusum" onClick={() => openRecord("sku", g.sku)}>
                                    <td>{g.name}<div className="muted tr-days">same SKU from {plural(g.subs.length, "PO", "POs")} · {plural(g.subs.length, "subitem", "subitems")} in Monday</div></td>
                                    <td className="strong">{g.sku}</td>
                                    <td className="r strong">{fmt(g.onBoard)}</td>
                                    <td className="r strong tr-it">{fmt(g.committed)}</td>
                                    <td className="r strong">{fmt(g.free)}</td>
                                    <td className="muted">total of the rows below</td>
                                    <td colSpan={3} className="tr-chips">
                                      {g.promised.length ? g.promised.map((p) => (
                                        <button key={p.orderId} type="button" className="chip it" title={p.number} onClick={(e) => openFrom(e, "so", p.orderId)}>
                                          <span className="sq" />{p.retailerShort || p.number} · {fmt(p.qty)}
                                        </button>
                                      )) : <span className="muted">free to sell</span>}
                                    </td>
                                  </tr>
                                )}
                                {g.subs.map((s) => (
                                  <tr key={s.id} className={`sub clickable ${multi ? "subsub" : ""}`} onClick={() => openRecord("sku", s.sku)}>
                                    <td>{multi && <span className="tree">└</span>}{s.name}</td>
                                    <td className={multi ? "muted" : "strong"}>{s.sku}</td>
                                    <td className="r">{fmt(s.onBoard)}</td>
                                    {/* Several POs of one SKU: Monday does not record which PO the promised units come from (TBD-13). */}
                                    <td className="r tr-it">{multi ? <span className="muted" title={SPLIT_UNKNOWN}>—</span> : fmt(s.committed)}</td>
                                    <td className="r">{multi ? <span className="muted" title={SPLIT_UNKNOWN}>—</span> : fmt(s.free)}</td>
                                    <td>{s.poId ? <button type="button" className="chip po" onClick={(e) => openFrom(e, "po", s.poId)}><span className="sq" />{s.poName}</button>
                                      : s.poName ? <Chip c="po">{s.poName}</Chip> : <span className="muted">—</span>}</td>
                                    <td colSpan={3} className="tr-chips">
                                      {multi ? <span className="muted">see the SKU total above</span> : s.promised.length ? s.promised.map((p) => (
                                        <button key={p.orderId} type="button" className="chip it" title={p.number} onClick={(e) => openFrom(e, "so", p.orderId)}>
                                          <span className="sq" />{p.retailerShort || p.number} · {fmt(p.qty)}
                                        </button>
                                      )) : <span className="muted">free to sell</span>}
                                    </td>
                                  </tr>
                                ))}
                              </Fragment>
                            );
                          })}
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
