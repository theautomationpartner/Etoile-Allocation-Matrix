import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { readAt } from "../../hooks/useMatrixData.js";
import { SCREEN_PARTS } from "../../lib/screenParts.js";
import { usePanelRequest } from "../../hooks/usePanelRequest.js";
import { clock, fmt, plural, dayMonthYear } from "../../lib/format.js";
import { buildWholesale, GROUPS, URGENT_DAYS, WH_FILTERS } from "../../lib/wholesale.js";
import { Card } from "../allocation-matrix/MetricCards.jsx";
import { SidePanel } from "../allocation-matrix/SidePanel.jsx";

// Wholesale Allocation (mockup vWholesale): every US order synced from Cin7, one card per group (Orders, Pending,
// Fulfilled). Read-only. A row opens the order's side panel (a Fulfilled one shows "Shipped"); ▸ shows its line
// items, and a line opens the SKU's panel.
const LABELS = ["Orders that can't be covered", "Units waiting on allocation", "SKUs blocking these orders", `Cancel date within ${URGENT_DAYS} days`];

const Chip = ({ c, children }) => <span className={`chip ${c}`}>{c !== "mut" && <span className="sq" />}{children}</span>;

export function WholesaleAllocation({ data, model, status, error, onRefresh, shipments, search, filter, onFilter, onGoSku, onGoShipments, panelRequest }) {
  const wh = useMemo(() => (model && data ? buildWholesale(model, data) : null), [model, data]);
  const busy = status === "loading" || status === "refreshing";
  const ready = Boolean(wh);
  const [expanded, setExpanded] = useState({});
  const toggleFilter = (k) => onFilter(filter === k ? "all" : k); // a card activates its filter; a second click goes back
  const toggle = (id) => setExpanded((cur) => ({ ...cur, [id]: !cur[id] }));

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
    if (!wh) return [];
    const keep = wh.is[filter] || wh.is.all;
    return wh.rows.filter((r) => keep(r) && (!q || [r.number, r.so, r.retailer, r.retailerShort].some((t) => String(t).toLowerCase().includes(q))
      || r.lines.some((l) => l.sku.toLowerCase().includes(q) || String(l.name).toLowerCase().includes(q))));
  }, [wh, filter, q]);

  const fresh = status === "loading" ? "Loading from Monday…" : status === "refreshing" ? "Recalculating with fresh Monday data…"
    : data ? `Calculated from Monday data read at ${clock(readAt(data, SCREEN_PARTS.wholesale))} · updates every 6 h` : "";
  const c = wh?.cards;
  const openRow = (r) => openRecord("so", r.id); // every row, Fulfilled included (requirements §5)

  return (
    <>
      <div className="page-h">
        <div>
          <h2>Wholesale Allocation</h2>
          <p>Every order synced from Cin7 and whether it can actually be delivered. An order is only safe when all of its units have a source behind them.</p>
        </div>
      </div>

      {error && (
        <div className="note warn" role="alert">
          <b>{ready ? "Refresh failed." : "Monday could not be read."}</b> {error}
          {ready && ` Showing the figures loaded at ${clock(readAt(data, SCREEN_PARTS.wholesale))}.`}{" "}
          <button type="button" className="btn" onClick={onRefresh}>Try again</button>
        </div>
      )}

      <div className="kpi-bar">
        <span className="fresh" aria-live="polite">{fresh}</span>
        <button type="button" className="btn refresh" onClick={onRefresh} disabled={busy} title="Read this screen's boards again from Monday now (otherwise they update every 6 hours)">
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
          <Card label={LABELS[0]} value={fmt(c.blocked.orders)} tone={c.blocked.orders ? "warn" : ""} filterKey="blocked" filter={filter} onFilter={toggleFilter}
            sub={c.blocked.orders ? `${fmt(c.blocked.units)} units have no stock anywhere` : "Every order can be fulfilled"} />
          <Card label={LABELS[1]} value={fmt(c.waiting.units)} filterKey="unallocated" filter={filter} onFilter={toggleFilter}
            sub={c.waiting.orders ? `across ${plural(c.waiting.orders, "order", "orders")}` : "Nothing left to assign"} />
          <Card label={LABELS[2]} value={fmt(c.blockingSkus.length)} tone={c.blockingSkus.length ? "warn" : ""} cta="Open in Master SKU" onGo={() => onGoSku("short")}
            sub={c.blockingSkus.length ? c.blockingSkus.slice(0, 3).join(", ") + (c.blockingSkus.length > 3 ? "…" : "") : "No product is holding sales back"} />
          <Card label={LABELS[3]} value={fmt(c.urgent)} tone={c.urgent ? "warn" : ""} filterKey="urgent" filter={filter} onFilter={toggleFilter}
            sub={c.urgent ? "still not fully allocated" : "Nothing urgent left unallocated"} />
        </div>
      )}

      <div className="fbar">
        <span className="fl">Show</span>
        {Object.entries(WH_FILTERS).map(([k, f]) => (
          <button key={k} type="button" className={`fchip ${filter === k ? "on" : ""}`} aria-pressed={filter === k} onClick={() => onFilter(k)}>
            {f.label}{wh && <i>{fmt(wh.counts[k])}</i>}
          </button>
        ))}
        {q && wh && <span className="fnote">{fmt(shown.length)} of {plural(wh.rows.filter(wh.is[filter] || wh.is.all).length, "order", "orders")} match “{search.trim()}”</span>}
      </div>

      {wh && !shown.length ? (
        <section className="card">
          <div className="mx-empty">
            <b className="cc-empty-t">{q ? "No order matches this search." : "Nothing matches this filter."}</b>
            {q ? "Try another order number, SO, retailer or SKU." : "That is usually good news — switch back to All orders to see everything."}
          </div>
        </section>
      ) : wh && GROUPS.map((g) => {
        const list = shown.filter((r) => r.group === g.id);
        if (!list.length) return null;
        return (
          <section key={g.id} className="card wh-group">
            <div className="card-h">
              <h3>{g.title}</h3>
              <span className="sub">{plural(list.length, "order", "orders")} · {plural(list.reduce((a, r) => a + r.lines.length, 0), "line item", "line items")}</span>
            </div>
            <div className="tw">
              <table className="wht">
                <thead>
                  <tr>
                    <th className="wh-ord">Order</th><th>Retailer</th><th>Cancel date</th><th>Status</th><th className="wh-alloc">Allocation</th>
                    <th className="r">Ordered</th><th className="r">Fulfilled</th><th className="r">Unallocated</th><th>Covered by</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => {
                    const op = Boolean(expanded[r.id]);
                    return (
                      <Fragment key={r.id}>
                        <tr className="clickable" onClick={() => openRow(r)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && openRow(r)}>
                          <td className="wh-ord">
                            <div className="wh-o">
                              <button type="button" className="exp" aria-expanded={op} aria-label={`${op ? "Hide" : "Show"} the line items of ${r.number}`}
                                onClick={(e) => { e.stopPropagation(); toggle(r.id); }}>{op ? "▾" : "▸"}</button>
                              <div>
                                <b className="eivr">{r.number}</b><span className="slash">/</span><wbr /><span className="ret">{r.retailerShort}</span>
                                <div className="muted wh-meta">{[r.so, plural(r.skus, "SKU", "SKUs"), r.saleStatus.toLowerCase()].filter(Boolean).join(" · ")}</div>
                              </div>
                            </div>
                          </td>
                          <td className="wh-ret" title={r.retailer}>{r.retailer}</td>
                          <td className="wh-date">
                            {r.cancelDate ? (
                              <>{dayMonthYear(r.cancelDate)}<div className="muted wh-days">{r.days >= 0 ? `${plural(r.days, "day", "days")} left` : "past due"}</div></>
                            ) : <span className="muted">—</span>}
                          </td>
                          <td><Chip c={r.status.c}>{r.status.t}</Chip></td>
                          <td className="wh-alloc">
                            <div className="bar">
                              <i className="a" style={{ width: `${r.ord ? Math.min(100, ((r.al + r.ful) / r.ord) * 100) : 0}%` }} />
                              {r.gap > 0 && <i className="d" style={{ width: `${(r.gap / r.ord) * 100}%` }} />}
                            </div>
                            <div className="muted wh-cov">{r.pct}% covered{r.gap > 0 && ` · ${fmt(r.gap)} impossible`}</div>
                          </td>
                          <td className="r">{fmt(r.ord)}</td>
                          <td className="r muted">{fmt(r.ful)}</td>
                          <td className={`r strong ${r.rem ? "" : "wh-none"}`}>{r.rem ? fmt(r.rem) : "—"}</td>
                          <td className="wh-kinds">{r.coveredBy.length ? r.coveredBy.map((k) => <Chip key={k.k} c={k.k}>{k.t}</Chip>) : <span className="muted">nothing yet</span>}</td>
                        </tr>
                        {op && (
                          <>
                            <tr className="subhead">
                              <th>Product</th><th>SKU</th><th className="r">Ordered</th><th className="r">Fulfilled</th><th className="r">Outstanding</th>
                              <th className="r">Unallocated</th><th>Source</th><th colSpan={2}>Coming from</th>
                            </tr>
                            {r.lines.map((l) => (
                              <tr key={l.id} className="sub clickable" onClick={() => openRecord("sku", l.sku)}>
                                <td>{l.name}</td>
                                <td className="strong">{l.sku}</td>
                                <td className="r">{fmt(l.ordered)}</td>
                                <td className="r">{fmt(l.fulfilled)}</td>
                                <td className="r">{fmt(l.outstanding)}</td>
                                <td className={`r strong ${l.left ? "wh-left" : "wh-none"}`}>{l.left ? fmt(l.left) : "—"}</td>
                                <td><Chip c={l.sourceKind}>{l.source}</Chip></td>
                                <td colSpan={2} className="wh-kinds">
                                  {l.from.length ? l.from.map((f, i) => (
                                    <Chip key={i} c={f.kind}>
                                      {f.dead ? `${f.label ? `${f.label} · ` : ""}${fmt(f.qty)} (orphaned)` : `${f.label}${f.from ? ` ← ${f.from}` : ""} · ${fmt(f.qty)}`}
                                    </Chip>
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
        );
      })}

      <SidePanel stack={rail} model={model} data={data} shipments={shipments} {...panel} />
    </>
  );
}
