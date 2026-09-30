import { Icon } from "./Icon.jsx";

// Only "Allocation matrix" is built in this phase; the rest are shown but cannot be opened.
const NAV = [
  { section: "OVERVIEW" },
  { id: "home", label: "Control center", icon: "grid" },
  { id: "matrix", label: "Allocation matrix", icon: "table", active: true },
  { section: "BOARDS" },
  { id: "wholesale", label: "Wholesale Allocation", icon: "bag" },
  { id: "transit", label: "In-Transit Shipments", icon: "ship" },
  { id: "po", label: "Purchase Orders", icon: "box" },
  { id: "sku", label: "Master SKU Inventory", icon: "tag" },
  { id: "importer", label: "In-Transit Importer", icon: "up" },
];

export function Sidebar({ collapsed, onToggle, onToggleTheme }) {
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
        {NAV.map((item) =>
          item.section ? (
            <div key={item.section} className="nav-h">{item.section}</div>
          ) : item.active ? (
            <a key={item.id} className="nav-i on" href="#" aria-current="page" title={item.label} onClick={(e) => e.preventDefault()}>
              <Icon name={item.icon} />
              <span className="lb">{item.label}</span>
            </a>
          ) : (
            <span key={item.id} className="nav-i off" role="link" aria-disabled="true" title={`${item.label} — not available yet`}>
              <Icon name={item.icon} />
              <span className="lb">{item.label}</span>
            </span>
          ),
        )}
      </nav>
      <div className="side-foot">
        <span>Monday · US</span>
        <button type="button" onClick={onToggleTheme}>Theme</button>
      </div>
    </aside>
  );
}
