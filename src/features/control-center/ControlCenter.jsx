import { useEffect, useMemo, useRef, useState } from "react";
import { clock, fmt, plural, dayMonthYear } from "../../lib/format.js";
import { buildControl, SOON_DAYS } from "../../lib/control.js";
import { Card } from "../allocation-matrix/MetricCards.jsx";
import { SidePanel } from "../allocation-matrix/SidePanel.jsx";

// Control center (mockup vHome, "Control center — Requerimientos funcionales y técnicos"): the home screen.
// Read-only: nothing here writes to monday. Every figure comes from the Allocation Matrix model (control.js).
// Rows open the side panel of their record; buttons open another screen already filtered.
const LABELS = ["Sales at risk", "Waiting to be allocated", "Committed to wholesale", `Landing in ${SOON_DAYS} days`];

const inDays = (n) => (n === null ? "no date" : n === 0 ? "today" : n > 0 ? `in ${plural(n, "day", "days")}` : `${plural(-n, "day", "days")} late`);
const daysLeft = (n) => (n === null ? "no cancel date" : n === 0 ? "cancel date today" : n > 0 ? `${plural(n, "day", "days")} left` : `${plural(-n, "day", "days")} past it`);
const joinPos = (pos) => (pos.length ? pos.join(" + ") : "no PO linked");

// A clickable row (mockup .att): mouse and keyboard.
function Row({ sev, title, meta, chip, onOpen }) {
  return (
    <div className="att" role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}>
      <span className={`sev ${sev || ""}`} />
      <span className="b"><span className="t">{title}</span>{" "}<span className="m">{meta}</span></span>
      {chip}
    </div>
  );
}

function Empty({ title, sub }) {
  return (
    <div className="cc-empty-wrap">
      <div className="mx-empty"><b className="cc-empty-t">{title}</b>{sub}</div>
    </div>
  );
}

function Block({ title, sub, action, children }) {
  return (
    <section className="card">
      <div className="card-h">
        <h3>{title}</h3>
        {sub && <span className="sub">{sub}</span>}
        {action && <span className="right">{action}</span>}
      </div>
      {children}
    </section>
  );
}

// A header button that opens another screen; dimmed with its reason when that screen is not built.
function GoButton({ label, onGo }) {
  return <button type="button" className="btn" onClick={onGo}>{label}</button>;
}

export function ControlCenter({ data, model, status, error, onRefresh, onGoMatrix, onGoSku, onGoWholesale, onGoTransit, onGoShipments, shipments, search }) {
  const cc = useMemo(() => (model && data ? buildControl(model, data) : null), [model, data]);
  const busy = status === "loading" || status === "refreshing";
  const ready = Boolean(cc);

  // Side panel of a record (same rail and trail as the matrix).
  const [rail, setRail] = useState([]);
  const panel = {
    onOpen: (type, id) => setRail((cur) => [...cur, { type, id: String(id) }]),
    onTrail: (i) => setRail((cur) => cur.slice(0, i + 1)),
    onClose: () => setRail([]),
    onGoShipments(orderId) {
      setRail([]);
      onGoShipments(orderId);
    },
  };
  const openRecord = (type, id) => setRail([{ type, id: String(id) }]);
  const escRef = useRef(null);
  escRef.current = () => rail.length && setRail([]);
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && escRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Typing in the top search opens the matrix with that search (the Control center has no rows to narrow).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (search.trim()) onGoMatrix(null);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const fresh = status === "loading" ? "Loading from Monday…" : status === "refreshing" ? "Recalculating with fresh Monday data…"
    : data ? `Calculated from Monday data read at ${clock(data.loadedAt)}` : "";

  const c = cc?.cards;
  return (
    <>
      <div className="page-h">
        <div>
          <h2>Control center</h2>
          <p>Where the business stands right now: what is sold, what is covered, what is blocked and what someone has to do about it today.</p>
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
          <Card label="Sales at risk" value={fmt(c.atRisk.units)} tone={c.atRisk.units > 0 ? "warn" : ""}
            sub={c.atRisk.units > 0 ? `${plural(c.atRisk.skus, "SKU", "SKUs")} sold with nothing behind them` : "Everything sold has stock behind it"}
            cta="Review SKUs" onGo={() => onGoSku("short")} />
          <Card label="Waiting to be allocated" value={fmt(c.waiting.units)}
            sub={c.waiting.units > 0 ? `${plural(c.waiting.lines, "order line", "order lines")} · stock exists, decision missing` : "Nothing left to allocate"}
            cta="Open matrix" onGo={() => onGoMatrix("pending")} />
          <Card label="Committed to wholesale" value={fmt(c.committed.total)}
            sub={`${fmt(c.committed.onHand)} on hand · ${fmt(c.committed.inTransit)} in transit · ${fmt(c.committed.onOrder)} on order`}
            cta="See orders" onGo={() => onGoWholesale("allocated")} />
          <Card label={`Landing in ${SOON_DAYS} days`} value={fmt(c.landing.units)}
            sub={c.landing.shipments ? `${plural(c.landing.shipments, "shipment", "shipments")} · ${fmt(c.landing.free)} units still unclaimed` : "No containers due this month"}
            cta="See shipments" onGo={() => onGoTransit("soon")} />
        </div>
      )}

      {cc?.orphanUnits > 0 && (
        <div className="note warn">
          <b>{fmt(cc.orphanUnits)} committed units lost their source.</b> They point at a shipment that was deleted or archived in Monday, so they no longer count as allocated. Allocate those lines again from the matrix.
        </div>
      )}

      {cc && (
        <div className="two">
          <div className="cc-col">
            <Block title="Needs a buying decision" sub="sold, but no stock anywhere to cover it"
              action={<GoButton label="Open in Master SKU" onGo={() => onGoSku("short")} />}>
              {cc.short.length ? cc.short.map((s) => (
                <Row key={s.sku} title={`${s.sku} · ${s.name}`} onOpen={() => openRecord("sku", s.sku)}
                  meta={`${fmt(s.need)} units sold · only ${fmt(s.available)} available anywhere`}
                  chip={<span className="chip gap"><span className="sq" />short {fmt(s.gap)}</span>} />
              )) : <Empty title="Nothing is blocked." sub="Every unit sold can be covered from stock on hand, in transit, or on order." />}
            </Block>

            <Block title="Waiting on an allocation" sub="stock is there — sorted by cancel date"
              action={<GoButton label="Allocate now" onGo={() => onGoMatrix("pending")} />}>
              {cc.waiting.length ? (
                <>
                  {cc.waiting.map((w) => (
                    <Row key={w.lineId} sev="warn" title={`${w.sku} · ${w.retailer}`} onOpen={() => openRecord("so", w.orderId)}
                      meta={`${w.number} · ${w.cancelDate ? `cancel date ${dayMonthYear(w.cancelDate)} · ` : ""}${daysLeft(w.daysLeft)}`}
                      chip={<span className="chip mut">{fmt(w.left)} u</span>} />
                  ))}
                  {cc.waitingMore > 0 && (
                    <button type="button" className="cc-more" onClick={() => onGoMatrix("pending")}>
                      {plural(cc.waitingMore, "more line", "more lines")} waiting · see them all in the matrix →
                    </button>
                  )}
                </>
              ) : <Empty title="Everything is allocated." sub="No open line has stock sitting unassigned." />}
            </Block>

            {cc.drafts.length > 0 && (
              <Block title="Draft packing lists" sub="not confirmed by the freight forwarder yet"
                action={<GoButton label="Review" onGo={() => onGoTransit("draft")} />}>
                {cc.drafts.map((d) => (
                  <Row key={d.id} sev="warn" title={d.code} onOpen={() => openRecord("ship", d.id)}
                    meta={`${joinPos(d.pos)} · arrives ${d.eta ? dayMonthYear(d.eta) : "no ETA"} · ${plural(d.promised, "unit", "units")} already promised to customers`}
                    chip={<span className="chip po"><span className="sq" />Draft</span>} />
                ))}
              </Block>
            )}
          </div>

          <div className="cc-col">
            <Block title="What is coming in">
              <div className="cc-pad">
                {cc.coming.length ? (
                  <div className="tl">
                    {cc.coming.map((a) => (
                      <div key={`${a.kind}-${a.id}`} className={`tl-i ${a.kind === "po" ? "po" : ""}`} role="button" tabIndex={0}
                        onClick={() => openRecord(a.kind, a.id)}
                        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), openRecord(a.kind, a.id))}>
                        <div className="d">{a.date ? `${dayMonthYear(a.date)} · ${inDays(a.days)}` : "No ETA"}</div>
                        <div className="t">{a.kind === "po" ? `${a.title}${a.reference ? ` · ${a.reference}` : ""}` : a.title}</div>
                        <div className="m">{a.kind === "po"
                          ? `${fmt(a.units)} units not shipped yet`
                          : `${fmt(a.units)} units · ${fmt(a.free)} unclaimed · from ${joinPos(a.pos)}`}</div>
                      </div>
                    ))}
                  </div>
                ) : <div className="mx-empty cc-empty-in"><b className="cc-empty-t">Nothing is on its way.</b>No container is travelling and every purchase order is already shipped.</div>}
              </div>
            </Block>

            <Block title="Where committed units come from">
              <CommittedBreakdown c={c.committed} />
            </Block>
          </div>
        </div>
      )}

      <SidePanel stack={rail} model={model} data={data} shipments={shipments} {...panel} />
    </>
  );
}

function CommittedBreakdown({ c }) {
  const total = c.onHand + c.inTransit + c.onOrder + c.notAllocated || 1;
  const pct = (v) => `${(v / total) * 100}%`;
  const rows = [
    { k: "wh", label: "Warehouse stock", v: c.onHand },
    { k: "it", label: "In transit", v: c.inTransit },
    { k: "po", label: "On order", v: c.onOrder },
    { k: "mut", label: "Not allocated yet", v: c.notAllocated, plain: true },
  ];
  return (
    <div className="cc-pad">
      <div className="bar cc-bar" role="img" aria-label={rows.map((r) => `${r.label} ${fmt(r.v)} units`).join(", ")}>
        <i className="a" style={{ width: pct(c.onHand) }} /><i className="b" style={{ width: pct(c.inTransit) }} />
        <i className="c" style={{ width: pct(c.onOrder) }} /><i className="d" style={{ width: pct(c.notAllocated) }} />
      </div>
      <div className="cc-rows">
        {rows.map((r) => (
          <div key={r.k} className="cc-row">
            <span className={`chip ${r.k}`}>{!r.plain && <span className="sq" />}{r.label}</span>
            <b>{fmt(r.v)} u</b>
          </div>
        ))}
      </div>
      <p className="mx-sub cc-note">The further right a unit sits, the later it can actually ship to the customer.</p>
    </div>
  );
}
