// Breadcrumb + search. The search narrows the matrix rows (order, SKU, product, container or PO).
export function Topbar({ search, onSearch }) {
  return (
    <div className="topbar">
      <div className="crumb">
        Etoile · US <span aria-hidden="true">›</span> <b>Allocation matrix</b>
      </div>
      <div className="top-r">
        <label className="search">
          <span className="sr-only">Search</span>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 14 14" />
          </svg>
          <input type="search" value={search} onChange={(e) => onSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onSearch("")}
            placeholder="Search a SKU, PO, shipment or order…" autoComplete="off" />
        </label>
        <span className="sync">US · Red Stag + Boxzooka</span>
      </div>
    </div>
  );
}
