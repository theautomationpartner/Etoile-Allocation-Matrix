import { useMemo, useRef, useState } from "react";
import { clock } from "../../lib/format.js";
import { buildOrderMatrix } from "../../lib/matrix.js";
import { rowMatchesSearch } from "../../lib/search.js";
import { MetricCards } from "./MetricCards.jsx";
import { ControlsBar } from "./ControlsBar.jsx";
import { ShowFilters } from "./ShowFilters.jsx";
import { Legend } from "./Legend.jsx";
import { MatrixTable } from "./MatrixTable.jsx";
import { useShipments } from "../../hooks/useShipments.js";
import { fetchWrite } from "../../lib/mondayWrites.js";

// Allocation matrix screen (§3). Step 1: metrics + Show filters + search. Step 2: the matrix in the
// Wholesale order view. Step 4: shipments (Shipments tab of each order). Step 3 (allocation editor) is pending.
export function AllocationMatrix({ data, model, status, error, search, onRefresh, toast, patchData }) {
  const shipments = useShipments({ data, model, write: fetchWrite, toast, patchData });

  // Refresh reloads everything from monday: with unsaved shipments it asks for a second click first.
  const armed = useRef(0);
  const refresh = () => {
    if (shipments.hasUnsaved && Date.now() - armed.current > 6000) {
      armed.current = Date.now();
      return toast("Some shipments are not saved yet. Click Refresh again to discard those changes and reload.");
    }
    armed.current = 0;
    onRefresh();
  };
  const [filter, setFilter] = useState("all"); // §15.1: one filter at a time
  const [open, setOpen] = useState({}); // group open/closed, kept while the page is open (§3)
  const ready = Boolean(model);
  const busy = status === "loading" || status === "refreshing";

  // §4: a card activates its filter; a second click goes back to Everything.
  const toggleFilter = (key) => setFilter((cur) => (cur === key ? "all" : key));

  const matrix = useMemo(() => (model ? buildOrderMatrix(model, data, { filter, search }) : null), [model, data, filter, search]);
  const matched = useMemo(() => (model ? model.lines.filter((r) => rowMatchesSearch(r, search, data.warehouse)).length : 0), [model, data, search]);

  // By default only groups with something left to allocate are open; with a filter or a search, all are.
  const narrowed = filter !== "all" || Boolean(search.trim());
  const isOpen = (g) => open[g.key] ?? (narrowed ? true : g.defOpen);
  const toggle = (g, value) => setOpen((cur) => ({ ...cur, [g.key]: value }));
  const expandAll = (value) => setOpen(Object.fromEntries((matrix?.groups || []).map((g) => [g.key, value])));

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
        <div className="note warn" role="alert">
          <b>{ready ? "Refresh failed." : "Monday could not be read."}</b> {error}
          {ready && ` Showing the figures loaded at ${clock(data.loadedAt)}.`}{" "}
          <button type="button" className="btn" onClick={refresh}>Try again</button>
        </div>
      )}

      <div className="kpi-bar">
        <span className="fresh" aria-live="polite">{fresh}</span>
        <button type="button" className="btn refresh" onClick={refresh} disabled={busy}
          title="Read every board again from Monday and recalculate all figures">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true" className={busy ? "spin" : ""}>
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
          </svg>
          Refresh
        </button>
      </div>
      <MetricCards metrics={model?.metrics} filter={filter} onFilter={toggleFilter} />
      <ControlsBar onExpandAll={expandAll} disabled={!matrix?.groups.length} />
      <ShowFilters filter={filter} onFilter={setFilter} search={search} matched={matched} total={model?.lines.length} />
      <Legend totals={matrix?.legend} />
      <MatrixTable matrix={matrix} status={status} isOpen={isOpen} onToggle={toggle} orphanUnits={model?.orphanUnits || 0} shipments={shipments} />
    </>
  );
}
