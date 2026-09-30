import { FILTERS } from "../../lib/engine.js";
import { fmt, plural } from "../../lib/format.js";

// §3 controls row 2 / §15.1 — Show chips (mockup markup). While searching, the note says how many rows match.
export function ShowFilters({ filter, onFilter, search, matched, total }) {
  const q = search.trim();
  return (
    <div className="fbar">
      <span className="fl">Show</span>
      {Object.entries(FILTERS).map(([id, f]) => (
        <button key={id} type="button" className={`fchip ${filter === id ? "on" : ""}`} aria-pressed={filter === id} onClick={() => onFilter(id)}>
          {f.label}
        </button>
      ))}
      {q && total != null && <span className="fnote">{fmt(matched)} of {plural(total, "row", "rows")} match “{q}”</span>}
    </div>
  );
}
