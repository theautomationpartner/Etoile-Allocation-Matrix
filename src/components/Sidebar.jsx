import { Icon } from "./Icon.jsx";
import { clock } from "../lib/format.js";

// Same markup as the mockup's side nav. Built so far: "Control center", "Allocation matrix", "Master SKU Inventory" and, for admins only,
// "Users & access"; the rest are shown (with their counts) but cannot be opened.
const NAV = [
  { section: "OVERVIEW" },
  { id: "home", label: "Control center", icon: "grid", open: true },
  { id: "matrix", label: "Allocation matrix", icon: "table", open: true },
  { section: "BOARDS" },
  { id: "wholesale", label: "Wholesale Allocation", icon: "bag", open: true },
  { id: "transit", label: "In-Transit Shipments", icon: "ship", open: true },
  { id: "po", label: "Purchase Orders", icon: "box" },
  { id: "sku", label: "Master SKU Inventory", icon: "tag", open: true },
  { id: "importer", label: "In-Transit Importer", icon: "up" },
];
const ADMIN_NAV = [{ section: "ADMIN" }, { id: "users", label: "Users & access", icon: "users", open: true }];

// counts: { home (SKUs that cannot be covered, shown as an alert), wholesale, transit, po, sku, importer }
export function Sidebar({ collapsed, onToggle, onToggleTheme, counts = {}, loadedAt, view = "home", onView, isAdmin = false }) {
  return (
    <aside className="side">
      <div className="brand">
        <div className="brand-t">
          <h1>Etoile Flow</h1>
          <p>Inventory &amp; allocation</p>
        </div>
        <button type="button" className="side-tg" onClick={onToggle}
          aria-label={collapsed ? "Expand menu" : "Collapse menu"} title={collapsed ? "Expand menu" : "Collapse menu"}>
          <Icon name="chevronLeft" className="" size={16} />
        </button>
      </div>
      <nav className="nav" aria-label="Sections">
        {(isAdmin ? [...NAV, ...ADMIN_NAV] : NAV).map((item) => {
          if (item.section) return <div key={item.section} className="nav-h">{item.section}</div>;
          const n = counts[item.id];
          const badge = item.id === "home" ? (n > 0 ? <span className="cnt alert">{n}</span> : null) : n ? <span className="cnt">{n}</span> : null;
          return item.open ? (
            <a key={item.id} href="#" className={view === item.id ? "on" : ""} aria-current={view === item.id ? "page" : undefined} title={item.label}
              data-nav={item.id} onClick={(e) => { e.preventDefault(); onView?.(item.id); }}>
              <Icon name={item.icon} /><span className="lb">{item.label}</span>{badge}
            </a>
          ) : (
            <a key={item.id} className="off" aria-disabled="true" title={`${item.label} — not available yet`} onClick={(e) => e.preventDefault()}>
              <Icon name={item.icon} /><span className="lb">{item.label}</span>{badge}
            </a>
          );
        })}
      </nav>
      <div className="side-foot">
        <span>{loadedAt ? `Monday synced ${clock(loadedAt)}` : "Monday · US"}</span>
        <button type="button" onClick={onToggleTheme}>Theme</button>
      </div>
    </aside>
  );
}
