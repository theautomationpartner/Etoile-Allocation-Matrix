// Same markup as the mockup's topbar, plus the signed-in user at the right. The search narrows the rows of the
// open view: the matrix (order, SKU, product, container or PO) or Users & access (name or email).
import { startTransition, useEffect, useState } from "react";
import { UserChip } from "./AuthGate.jsx";

// The field keeps what is typed itself, so typing never waits for the screens: the app gets the text as a
// low-priority update (startTransition) that React can interrupt while the user keeps typing.
// Enter (onSubmit) opens the first matching record in a side panel (Connections §3.1).
export function Topbar({ search, onSearch, onSubmit, user, title = "Allocation matrix", placeholder = "Search a SKU, PO, shipment or order…" }) {
  const [text, setText] = useState(search);
  useEffect(() => setText(search), [search]); // cleared or changed by the app
  const change = (v) => {
    setText(v);
    startTransition(() => onSearch(v));
  };
  return (
    <div className="topbar">
      <div className="crumb">Etoile · US <span>›</span> <b>{title}</b></div>
      <div className="search">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5 14 14" />
        </svg>
        <input value={text} onChange={(e) => change(e.target.value)} onKeyDown={(e) => (e.key === "Escape" ? change("") : e.key === "Enter" && onSubmit ? onSubmit(text) : null)}
          placeholder={placeholder} autoComplete="off" aria-label="Search" />
      </div>
      <div className="sync">US · Red Stag + Boxzooka</div>
      <UserChip user={user} />
    </div>
  );
}
