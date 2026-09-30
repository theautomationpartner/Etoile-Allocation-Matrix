import { useMemo, useState } from "react";
import { FILTERS } from "../../lib/engine.js";
import { clock } from "../../lib/format.js";
import { rowMatchesSearch } from "../../lib/search.js";
import { MetricCards } from "./MetricCards.jsx";
import { ControlsBar } from "./ControlsBar.jsx";
import { ShowFilters } from "./ShowFilters.jsx";
import { Legend } from "./Legend.jsx";
import { MatrixFrame } from "./MatrixFrame.jsx";

// Allocation matrix screen (§3). Step 1 of 4: metrics, Show filters and search are functional;
// controls, legend and the matrix frame are the skeleton steps 2–4 fill in.
export function AllocationMatrix({ data, model, status, error, search, onRefresh }) {
  const [filter, setFilter] = useState("all"); // §15.1: one filter at a time
  const ready = Boolean(model);
  const busy = status === "loading" || status === "refreshing";

  // §4: a card activates its filter; a second click goes back to Everything.
  const toggleFilter = (key) => setFilter((cur) => (cur === key ? "all" : key));

  // Rows after search + Show filter (the table in step 2 renders exactly these).
  const rows = useMemo(() => {
    if (!model) return null;
    const searched = model.lines.filter((r) => rowMatchesSearch(r, search, data.warehouse));
    return { total: model.lines.length, searched: searched.length, shown: searched.filter(FILTERS[filter].keep) };
  }, [model, data, search, filter]);

  const fresh = status === "loading" ? "Loading from Monday…" : status === "refreshing" ? "Recalculating with fresh Monday data…"
    : data ? `Calculated from Monday data read at ${clock(data.loadedAt)}` : "";

  return (
    <>
      <div className="page-h">
        <div>
          <h2>Allocation matrix</h2>
          <p>Where every sold unit comes from — and the place to decide it. Pick the angle: the sale, the product, or the container.</p>
        </div>
      </div>

      {error && (
        <div className="alert" role="alert">
          <b>{ready ? "Refresh failed." : "Monday could not be read."}</b>
          <span>
            {error}
            {ready && ` Showing the figures loaded at ${clock(data.loadedAt)}.`}
          </span>
          <button type="button" className="btn" onClick={onRefresh}>Try again</button>
        </div>
      )}

      <div className="kpi-bar">
        <span className="fresh" aria-live="polite">{fresh}</span>
        <button type="button" className="btn refresh" onClick={onRefresh} disabled={busy}
          title="Read every board again from Monday and recalculate all figures">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"
            className={busy ? "spin" : ""}>
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
          </svg>
          Refresh
        </button>
      </div>
      <MetricCards metrics={model?.metrics} filter={filter} onFilter={toggleFilter} />
      <ControlsBar />
      <ShowFilters filter={filter} onFilter={setFilter} rows={rows} search={search} />
      <Legend />
      <MatrixFrame model={model} status={status} />
    </>
  );
}
