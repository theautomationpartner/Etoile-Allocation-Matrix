import { clock } from "../lib/format.js";

export function Topbar({ status, loadedAt, onRefresh }) {
  const fresh = status === "loading" ? "Loading…" : status === "refreshing" ? "Refreshing…" : loadedAt ? `Loaded ${clock(loadedAt)}` : "";
  return (
    <div className="topbar">
      <div className="crumb">
        Etoile · US <span aria-hidden="true">›</span> <b>Allocation matrix</b>
      </div>
      <div className="top-r">
        <span className="fresh" aria-live="polite">{fresh}</span>
        <button type="button" className="btn" onClick={onRefresh} disabled={status === "loading" || status === "refreshing"}>
          Refresh
        </button>
        <span className="sync">US · Red Stag + Boxzooka</span>
      </div>
    </div>
  );
}
