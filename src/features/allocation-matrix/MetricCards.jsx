import { fmt, plural } from "../../lib/format.js";

const LABELS = ["Units to allocate", "Impossible to cover", "Free inventory to draw on", "Already allocated"];

function FilterCard({ id, label, value, sub, tone = "", filter, onFilter }) {
  const on = filter === id;
  return (
    <button type="button" className={`kpi ${tone} ${on ? "on" : ""}`} aria-pressed={on} onClick={() => onFilter(id)}>
      <span className="lab">{label}</span>
      <span className="val">{value}</span>
      <span className="sub">{sub}</span>
      <span className="cta">
        {on ? "Showing these" : "Show these"} <span aria-hidden="true">→</span>
      </span>
    </button>
  );
}

// §4 — the four cards summarise all open US wholesale demand. Drafts never count,
// except the draft figure in the "Units to allocate" subtitle.
export function MetricCards({ metrics: m, filter, onFilter }) {
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
  const split = m.allocatedSplit;
  return (
    <div className="kpis">
      <FilterCard id="pending" label="Units to allocate" value={fmt(m.unitsToAllocate)} filter={filter} onFilter={onFilter}
        sub={`${plural(m.linesWithLeft, "line item", "line items")} · ${fmt(m.draftUnits)} already proposed as draft`} />
      <FilterCard id="blocked" label="Impossible to cover" value={fmt(m.impossible)} tone={m.impossible > 0 ? "warn" : ""}
        filter={filter} onFilter={onFilter}
        sub={m.impossible > 0 ? `${plural(m.shortSkuCount, "SKU needs", "SKUs need")} a new purchase order` : "Nothing is blocked"} />
      <div className="kpi">
        <div className="lab">Free inventory to draw on</div>
        <div className="val">{fmt(m.freeInventory)}</div>
        <div className="sub">on hand plus arriving, nobody has claimed it</div>
        <span className="cta soon" title="The In-Transit Shipments screen is not available yet">
          See where it sits <span aria-hidden="true">→</span>
        </span>
      </div>
      <div className="kpi">
        <div className="lab">Already allocated</div>
        <div className="val">{fmt(m.alreadyAllocated)}</div>
        <div className="sub">{fmt(split.onHand)} on hand · {fmt(split.inTransit)} in transit · {fmt(split.onOrder)} on order</div>
      </div>
    </div>
  );
}
