import { useEffect, useState } from "react";
import { ControlCenter } from "./features/control-center/ControlCenter.jsx";
import { SkuInventory } from "./features/sku-inventory/SkuInventory.jsx";
import { WholesaleAllocation } from "./features/wholesale/WholesaleAllocation.jsx";
import { InTransitShipments } from "./features/in-transit/InTransitShipments.jsx";
import { PurchaseOrders } from "./features/purchase-orders/PurchaseOrders.jsx";
import { useShipments } from "./hooks/useShipments.js";
import { fetchWrite } from "./lib/mondayWrites.js";
import { Sidebar } from "./components/Sidebar.jsx";
import { Topbar } from "./components/Topbar.jsx";
import { Toast, useToast } from "./components/Toast.jsx";
import { AllocationMatrix } from "./features/allocation-matrix/AllocationMatrix.jsx";
import { useMatrixData } from "./hooks/useMatrixData.js";
import { useStoredState } from "./hooks/useStoredState.js";
import { BOARDS, IMPORTER_BOARD } from "./lib/monday.js";
import { OPEN_ORDER_GROUPS } from "./lib/engine.js";
import { AuthGate } from "./components/AuthGate.jsx";
import { UsersAccess } from "./features/users/UsersAccess.jsx";

// Side nav badges, as in the mockup: SKUs that cannot be covered (alert on Control center), the orders listed
// on Wholesale Allocation (US: Orders, Pending and Fulfilled), containers in transit, the US purchase orders, and
// each board's item count.
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
    importer: b[IMPORTER_BOARD],
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
  const [view, setView] = useState("home"); // home (Control center, the first screen) | matrix | wholesale | transit | po | sku | users (admins only)
  const [skuFilter, setSkuFilter] = useState("all"); // Master SKU Inventory Show filter (kept while the app is open)
  const [whFilter, setWhFilter] = useState("all"); // Wholesale Allocation Show filter
  const [trFilter, setTrFilter] = useState("all"); // In-Transit Shipments Show filter
  const [poFilter, setPoFilter] = useState("all"); // Purchase Orders Show filter
  const [search, setSearch] = useState("");
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
  const current = onUsers ? "users" : ["home", "wholesale", "transit", "po", "sku"].includes(view) ? view : "matrix";
  const TITLES = { home: "Control center", matrix: "Allocation matrix", wholesale: "Wholesale Allocation", transit: "In-Transit Shipments", po: "Purchase Orders", sku: "Master SKU Inventory" };

  useEffect(() => {
    if (theme) document.documentElement.setAttribute("data-theme", theme);
    else document.documentElement.removeAttribute("data-theme");
  }, [theme]);

  const toggleTheme = () => {
    const dark = theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    setTheme(dark ? "light" : "dark");
  };

  const refresh = async () => {
    if (await matrix.reload()) toast.show("Figures recalculated with fresh data from Monday.");
  };

  return (
    <div className={`app ${collapsed ? "min" : ""}`}>
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} onToggleTheme={toggleTheme}
        counts={navCounts(matrix)} loadedAt={matrix.data?.loadedAt} view={current} onView={setView} isAdmin={isAdmin} />
      <main className="main">
        {onUsers ? (
          <Topbar search={userSearch} onSearch={setUserSearch} user={user} title="Users & access" placeholder="Search a user by name or email…" />
        ) : (
          <Topbar search={search} onSearch={setSearch} user={user} title={TITLES[current]} />
        )}
        {current === "home" && (
          <div className="view">
            <ControlCenter {...matrix} search={search} onRefresh={refresh} shipments={shipments}
              onGoMatrix={(filter) => goMatrix({ filter })} onGoSku={goSku} onGoWholesale={goWholesale} onGoTransit={goTransit} onGoShipments={(orderId) => goMatrix({ orderShipments: orderId })} />
          </div>
        )}
        {current === "wholesale" && (
          <div className="view">
            <WholesaleAllocation {...matrix} search={search} onRefresh={refresh} shipments={shipments} filter={whFilter} onFilter={setWhFilter}
              onGoSku={goSku} onGoShipments={(orderId) => goMatrix({ orderShipments: orderId })} />
          </div>
        )}
        {current === "transit" && (
          <div className="view">
            <InTransitShipments {...matrix} search={search} onRefresh={refresh} shipments={shipments} filter={trFilter} onFilter={setTrFilter}
              onGoShipments={(orderId) => goMatrix({ orderShipments: orderId })} />
          </div>
        )}
        {current === "po" && (
          <div className="view">
            <PurchaseOrders {...matrix} search={search} onRefresh={refresh} shipments={shipments} filter={poFilter} onFilter={setPoFilter}
              onGoShipments={(orderId) => goMatrix({ orderShipments: orderId })} />
          </div>
        )}
        {current === "sku" && (
          <div className="view">
            <SkuInventory {...matrix} search={search} onRefresh={refresh} shipments={shipments} filter={skuFilter} onFilter={setSkuFilter}
              onGoShipments={(orderId) => goMatrix({ orderShipments: orderId })} />
          </div>
        )}
        {/* The matrix stays mounted on the other screens: its open groups and editor state are kept. */}
        <div className="view" hidden={current !== "matrix"}>
          <AllocationMatrix {...matrix} search={search} onRefresh={refresh} toast={toast.show} shipments={shipments} request={matrixRequest} onGoTransit={goTransit} />
        </div>
        {onUsers && (
          <div className="view">
            <UsersAccess search={userSearch} toast={toast.show} />
          </div>
        )}
      </main>
      <Toast {...toast} />
    </div>
  );
}
