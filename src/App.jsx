import { useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar.jsx";
import { Topbar } from "./components/Topbar.jsx";
import { Toast, useToast } from "./components/Toast.jsx";
import { AllocationMatrix } from "./features/allocation-matrix/AllocationMatrix.jsx";
import { useMatrixData } from "./hooks/useMatrixData.js";
import { useStoredState } from "./hooks/useStoredState.js";
import { BOARDS, IMPORTER_BOARD } from "./lib/monday.js";
import { AuthGate } from "./components/AuthGate.jsx";
import { UsersAccess } from "./features/users/UsersAccess.jsx";

// Side nav badges, as in the mockup: SKUs that cannot be covered (alert on Control center),
// containers in transit, and each board's item count.
function navCounts({ data, model }) {
  if (!data || !model) return {};
  const b = data.boardCounts || {};
  return {
    home: model.shortSkus.length,
    wholesale: b[BOARDS.wholesale],
    transit: model.containers.length,
    po: b[BOARDS.po],
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
  const [view, setView] = useState("matrix"); // matrix | users (admins only)
  const [search, setSearch] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const onUsers = isAdmin && view === "users";
  const matrix = useMatrixData();
  const toast = useToast();

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
        counts={navCounts(matrix)} loadedAt={matrix.data?.loadedAt} view={onUsers ? "users" : "matrix"} onView={setView} isAdmin={isAdmin} />
      <main className="main">
        {onUsers ? (
          <Topbar search={userSearch} onSearch={setUserSearch} user={user} title="Users & access" placeholder="Search a user by name or email…" />
        ) : (
          <Topbar search={search} onSearch={setSearch} user={user} />
        )}
        {/* The matrix stays mounted while Users & access is open: unsaved shipments are kept. */}
        <div className="view" hidden={onUsers}>
          <AllocationMatrix {...matrix} search={search} onRefresh={refresh} toast={toast.show} />
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
