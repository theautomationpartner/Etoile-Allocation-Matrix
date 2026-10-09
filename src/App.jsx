import { useDeferredValue, useEffect, useState } from "react";
import { ControlCenter } from "./features/control-center/ControlCenter.jsx";
import { SkuInventory } from "./features/sku-inventory/SkuInventory.jsx";
import { WholesaleAllocation } from "./features/wholesale/WholesaleAllocation.jsx";
import { InTransitShipments } from "./features/in-transit/InTransitShipments.jsx";
import { PurchaseOrders } from "./features/purchase-orders/PurchaseOrders.jsx";
import { InTransitImporter } from "./features/importer/InTransitImporter.jsx";
import { useShipments } from "./hooks/useShipments.js";
import { fetchWrite } from "./lib/mondayWrites.js";
import { Sidebar } from "./components/Sidebar.jsx";
import { Topbar } from "./components/Topbar.jsx";
import { Toast, useToast } from "./components/Toast.jsx";
import { AllocationMatrix } from "./features/allocation-matrix/AllocationMatrix.jsx";
import { useMatrixData } from "./hooks/useMatrixData.js";
import { useStoredState } from "./hooks/useStoredState.js";
import { BOARDS } from "./lib/monday.js";
import { OPEN_ORDER_GROUPS } from "./lib/engine.js";
import { isUsImport } from "./lib/importer.js";
import { AppActions } from "./lib/appActions.js";
import { findRecord } from "./lib/search.js";
import { SCREEN_PARTS } from "./lib/screenParts.js";
import { AuthGate } from "./components/AuthGate.jsx";
import { UsersAccess } from "./features/users/UsersAccess.jsx";

// Side nav badges, as in the mockup: SKUs that cannot be covered (alert on Control center), the orders listed
// on Wholesale Allocation (US: Orders, Pending and Fulfilled), containers in transit, the US purchase orders, the
// US packing list uploads, and the Master SKU item count.
function navCounts({ data, model }) {
  if (!data || !model) return {};
  const b = data.boardCounts || {};
  return {
    home: model.shortSkus.length,
    wholesale: (data.orders || []).filter((o) => OPEN_ORDER_GROUPS.has(o.group) && o.region === "US").length
      + (data.fulfilledOrders || []).filter((o) => o.region === "US").length,
    transit: model.containers.length,
    po: (data.pos || []).filter((p) => p.region === "US").length,
    sku: b[BOARDS.warehouse],
    importer: (data.imports || []).filter(isUsImport).length,
  };
}

// Access first (sessionToken + access list); the workspace only mounts for an authorized user.
export default function App() {
  return <AuthGate>{(user) => <Workspace user={user} />}</AuthGate>;
}

function Workspace({ user }) {
  const [collapsed, setCollapsed] = useStoredState("etoile-side-min", false); // §3: the browser remembers it
  const [theme, setTheme] = useStoredState("etoile-theme", null); // null = follow the system
  const isAdmin = user?.role === "admin";
  const [view, setView] = useState("home"); // home (Control center, the first screen) | matrix | wholesale | transit | po | sku | importer | users (admins only)
  const [skuFilter, setSkuFilter] = useState("all"); // Master SKU Inventory Show filter (kept while the app is open)
  const [whFilter, setWhFilter] = useState("all"); // Wholesale Allocation Show filter
  const [trFilter, setTrFilter] = useState("all"); // In-Transit Shipments Show filter
  const [poFilter, setPoFilter] = useState("all"); // Purchase Orders Show filter
  const [impFilter, setImpFilter] = useState("all"); // In-Transit Importer Show filter
  const [search, setSearch] = useState("");
  // The screens filter with the deferred value: typing stays instant while the tables (the hidden matrix included) catch up.
  const deferredSearch = useDeferredValue(search);
  const [userSearch, setUserSearch] = useState("");
  const onUsers = isAdmin && view === "users";
  const matrix = useMatrixData();
  const toast = useToast();
  // Shipments live here: the matrix edits them and the Control center's side panel shows them.
  const shipments = useShipments({ data: matrix.data, model: matrix.model, write: fetchWrite, toast: toast.show, patchData: matrix.patchData });
  // A request for the matrix from the Control center: { n, filter } or { n, orderShipments }.
  const [matrixRequest, setMatrixRequest] = useState(null);
  const goMatrix = (req) => {
    setMatrixRequest((cur) => ({ n: (cur?.n || 0) + 1, ...req }));
    setView("matrix");
  };
  const goSku = (filter) => {
    setSkuFilter(filter || "all");
    setView("sku");
  };
  const goWholesale = (filter) => {
    setWhFilter(filter || "all");
    setView("wholesale");
  };
  const goTransit = (filter) => {
    setTrFilter(filter || "all");
    setView("transit");
  };
  // Header search + Enter (Connections §3.1): the first matching record opens in the open screen's side panel.
  const [panelRequest, setPanelRequest] = useState(null);
  useEffect(() => setPanelRequest(null), [view]); // a screen opened later never replays an old request
  const openSearch = (text) => {
    if (!text.trim()) return;
    if (!matrix.data) return toast.show("Still loading the data from Monday — try again in a moment.");
    const r = findRecord(text, matrix.data, matrix.model);
    if (!r) return toast.show(`Nothing in Monday matches “${text.trim()}”.`);
    setPanelRequest((cur) => ({ n: (cur?.n || 0) + 1, type: r.type, id: r.id }));
    if (r.more > 0) toast.show(`Opened ${r.label} · ${r.more} more ${r.more === 1 ? "record matches" : "records match"} — keep typing to narrow it.`);
  };
  const current = onUsers ? "users" : ["home", "wholesale", "transit", "po", "sku", "importer"].includes(view) ? view : "matrix";
  const TITLES = { home: "Control center", matrix: "Allocation matrix", wholesale: "Wholesale Allocation", transit: "In-Transit Shipments", po: "Purchase Orders", sku: "Master SKU Inventory", importer: "In-Transit Importer" };

  useEffect(() => {
    if (theme) document.documentElement.setAttribute("data-theme", theme);
    else document.documentElement.removeAttribute("data-theme");
  }, [theme]);

  // The theme in use: the one chosen with the Theme button, else the system's (followed while nothing is chosen).
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const dark = theme ? theme === "dark" : systemDark;
  const toggleTheme = () => setTheme(dark ? "light" : "dark");

  // A screen's Refresh reads that screen's boards again from monday (SCREEN_PARTS); the rest stays as cached.
  const refreshFor = (key) => async () => {
    if (await matrix.reload(SCREEN_PARTS[key])) toast.show("Figures recalculated with fresh data from Monday.");
  };

  return (
    <AppActions.Provider value={{ toast: toast.show, refresh: matrix.reload }}>
    <div className={`app ${collapsed ? "min" : ""}`}>
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} onToggleTheme={toggleTheme} dark={dark}
        counts={navCounts(matrix)} loadedAt={matrix.data?.loadedAt} view={current} onView={setView} isAdmin={isAdmin} />
      <main className="main">
        {onUsers ? (
          <Topbar search={userSearch} onSearch={setUserSearch} user={user} title="Users & access" placeholder="Search a user by name or email…" />
        ) : (
          <Topbar search={search} onSearch={setSearch} onSubmit={openSearch} user={user} title={TITLES[current]} />
        )}
        {current === "home" && (
          <div className="view">
            <ControlCenter {...matrix} search={deferredSearch} onRefresh={refreshFor("home")} shipments={shipments}
              onGoMatrix={(filter) => goMatrix({ filter })} onGoSku={goSku} onGoWholesale={goWholesale} onGoTransit={goTransit} onGoShipments={(orderId) => goMatrix({ orderShipments: orderId })} panelRequest={panelRequest} />
          </div>
        )}
        {current === "wholesale" && (
          <div className="view">
            <WholesaleAllocation {...matrix} search={deferredSearch} onRefresh={refreshFor("wholesale")} shipments={shipments} filter={whFilter} onFilter={setWhFilter}
              onGoSku={goSku} onGoShipments={(orderId) => goMatrix({ orderShipments: orderId })} panelRequest={panelRequest} />
          </div>
        )}
        {current === "transit" && (
          <div className="view">
            <InTransitShipments {...matrix} search={deferredSearch} onRefresh={refreshFor("transit")} shipments={shipments} filter={trFilter} onFilter={setTrFilter}
              onGoShipments={(orderId) => goMatrix({ orderShipments: orderId })} panelRequest={panelRequest} />
          </div>
        )}
        {current === "po" && (
          <div className="view">
            <PurchaseOrders {...matrix} search={deferredSearch} onRefresh={refreshFor("po")} shipments={shipments} filter={poFilter} onFilter={setPoFilter}
              onGoShipments={(orderId) => goMatrix({ orderShipments: orderId })} panelRequest={panelRequest} />
          </div>
        )}
        {current === "sku" && (
          <div className="view">
            <SkuInventory {...matrix} search={deferredSearch} onRefresh={refreshFor("sku")} shipments={shipments} filter={skuFilter} onFilter={setSkuFilter}
              onGoShipments={(orderId) => goMatrix({ orderShipments: orderId })} panelRequest={panelRequest} />
          </div>
        )}
        {current === "importer" && (
          <div className="view">
            <InTransitImporter {...matrix} search={deferredSearch} onRefresh={refreshFor("importer")} shipments={shipments} filter={impFilter} onFilter={setImpFilter}
              onGoShipments={(orderId) => goMatrix({ orderShipments: orderId })} panelRequest={panelRequest} />
          </div>
        )}
        {/* The matrix stays mounted on the other screens: its open groups and editor state are kept. */}
        <div className="view" hidden={current !== "matrix"}>
          <AllocationMatrix {...matrix} search={deferredSearch} onRefresh={refreshFor("matrix")} toast={toast.show} shipments={shipments} request={matrixRequest} onGoTransit={goTransit} panelRequest={current === "matrix" ? panelRequest : null} />
        </div>
        {onUsers && (
          <div className="view">
            <UsersAccess search={userSearch} toast={toast.show} />
          </div>
        )}
      </main>
      <Toast {...toast} />
    </div>
    </AppActions.Provider>
  );
}
