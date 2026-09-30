import { useState } from "react";
import { clock } from "../../lib/format.js";
import { MetricCards } from "./MetricCards.jsx";
import { ControlsBar } from "./ControlsBar.jsx";
import { ShowFilters } from "./ShowFilters.jsx";
import { Legend } from "./Legend.jsx";
import { MatrixFrame } from "./MatrixFrame.jsx";

// Allocation matrix screen (§3). Step 1 of 4: metrics + Show filters are functional;
// controls, legend and the matrix frame are the skeleton steps 2–4 fill in.
export function AllocationMatrix({ data, model, status, error, onRetry }) {
  const [filter, setFilter] = useState("all"); // §15.1: one at a time, kept when the view changes
  const [view, setView] = useState("order"); // order | sku | source
  const ready = Boolean(model);

  // §4: a card activates its filter; a second click goes back to Everything.
  const toggleFilter = (key) => setFilter((cur) => (cur === key ? "all" : key));

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
          <button type="button" className="btn" onClick={onRetry}>Try again</button>
        </div>
      )}

      <MetricCards metrics={model?.metrics} filter={filter} onFilter={toggleFilter} />
      <ControlsBar view={view} onView={setView} />
      <ShowFilters filter={filter} onFilter={setFilter} rows={model?.lines} />
      <Legend />
      <MatrixFrame view={view} model={model} status={status} />
    </>
  );
}
