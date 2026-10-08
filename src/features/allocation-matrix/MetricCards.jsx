import { fmt, plural } from "../../lib/format.js";

const LABELS = ["Units to allocate", "Impossible to cover", "Free inventory to draw on", "Already allocated"];

// Same markup as the mockup's metricStrip(): div.kpi (.act when it filters or opens another screen, .on when
// its filter is active). onGo + cta: the card opens another screen (mockup data-goto); ctaSoon: that screen is
// not built yet, so the action is shown dimmed with the reason.
export function Card({ label, value, sub, tone = "", filterKey, filter, onFilter, cta, ctaSoon, onGo }) {
  const on = filterKey && filter === filterKey;
  const act = Boolean(filterKey || onGo);
  const activate = () => (filterKey ? onFilter(filterKey) : onGo?.());
  return (
    <div className={`kpi ${tone} ${act ? "act" : ""} ${on ? "on" : ""}`}
      {...(act ? { role: "button", tabIndex: 0, "aria-pressed": on, onClick: activate, onKeyDown: (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), activate()) } : {})}>
      <div className="lab">{label}</div>
      <div className="val">{value}</div>
      <div className="sub">{sub}</div>
      {act && <div className="cta">{on ? "Showing these" : cta || "Show these"} <span>→</span></div>}
      {ctaSoon && <div className="cta soon" title={ctaSoon}>{cta} <span>→</span></div>}
    </div>
  );
}

// §4 — the four cards summarise all open US wholesale demand. Drafts never count,
// except the draft figure in the "Units to allocate" subtitle.
export function MetricCards({ metrics: m, filter, onFilter, onGoTransit }) {
  if (!m) {
    return (
      <div className="kpis">
        {LABELS.map((label) => (
          <div key={label} className="kpi" aria-busy="true">
            <div className="lab">{label}</div>
            <div className="val"><span className="sk v" /></div>
            <div className="sub"><span className="sk s" /></div>
          </div>
        ))}
      </div>
    );
  }
  const a = m.allocatedSplit, f = m.freeSplit;
  return (
    <div className="kpis">
      <Card label="Units to allocate" value={fmt(m.unitsToAllocate)} filterKey="pending" filter={filter} onFilter={onFilter}
        sub={`${plural(m.linesWithLeft, "line item", "line items")} · ${fmt(m.draftUnits)} already proposed as draft`} />
      <Card label="Impossible to cover" value={fmt(m.impossible)} tone={m.impossible > 0 ? "warn" : "ok"} filterKey="blocked" filter={filter} onFilter={onFilter}
        sub={m.impossible > 0 ? `${plural(m.shortSkuCount, "SKU needs", "SKUs need")} a new purchase order` : "Nothing is blocked"} />
      <Card label="Free inventory to draw on" value={fmt(m.freeInventory)}
        sub={`${fmt(f.onHand)} on hand · ${fmt(f.inTransit)} in transit · ${fmt(f.onOrder)} on order`}
        cta="See where it sits" onGo={() => onGoTransit("free")} />
      <Card label="Already allocated" value={fmt(m.alreadyAllocated)}
        sub={`${fmt(a.onHand)} on hand · ${fmt(a.inTransit)} in transit · ${fmt(a.onOrder)} on order`} />
    </div>
  );
}
