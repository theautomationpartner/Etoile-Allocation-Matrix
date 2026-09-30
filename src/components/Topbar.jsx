// Same markup as the mockup's topbar, plus the signed-in user at the right. The search narrows the matrix rows (order, SKU, product, container or PO).
import { UserChip } from "./AuthGate.jsx";

export function Topbar({ search, onSearch, user }) {
  return (
    <div className="topbar">
      <div className="crumb">Etoile · US <span>›</span> <b>Allocation matrix</b></div>
      <div className="search">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5 14 14" />
        </svg>
        <input value={search} onChange={(e) => onSearch(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onSearch("")}
          placeholder="Search a SKU, PO, shipment or order…" autoComplete="off" aria-label="Search" />
      </div>
      <div className="sync">US · Red Stag + Boxzooka</div>
      <UserChip user={user} />
    </div>
  );
}
