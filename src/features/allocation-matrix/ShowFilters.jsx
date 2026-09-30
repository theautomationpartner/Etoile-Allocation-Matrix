import { FILTERS } from "../../lib/engine.js";
import { fmt, plural } from "../../lib/format.js";

// §3 controls row 2 / §15.1 — Show chips. Until the rows exist (step 2) the note shows how many match
// the active filter and the topbar search.
export function ShowFilters({ filter, onFilter, rows, search }) {
  let note = "";
  if (rows) {
    const narrowed = filter !== "all" || search.trim();
    note = narrowed ? `${fmt(rows.shown.length)} of ${plural(rows.total, "row", "rows")} match` : plural(rows.total, "row", "rows");
    if (search.trim()) note += ` “${search.trim()}”`;
  }
  return (
    <div className="fbar">
      <span className="fl">Show</span>
      {Object.entries(FILTERS).map(([id, f]) => (
        <button key={id} type="button" className="fchip" aria-pressed={filter === id} onClick={() => onFilter(id)}>
          {f.label}
        </button>
      ))}
      {note && <span className="fnote">{note}</span>}
    </div>
  );
}
