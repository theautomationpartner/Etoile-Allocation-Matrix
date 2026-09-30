import { useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar.jsx";
import { Topbar } from "./components/Topbar.jsx";
import { Toast, useToast } from "./components/Toast.jsx";
import { AllocationMatrix } from "./features/allocation-matrix/AllocationMatrix.jsx";
import { useMatrixData } from "./hooks/useMatrixData.js";
import { useStoredState } from "./hooks/useStoredState.js";
import { BOARDS, IMPORTER_BOARD } from "./lib/monday.js";

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

export default function App() {
  const [collapsed, setCollapsed] = useStoredState("etoile-side-min", false); // §3: the browser remembers it
  const [theme, setTheme] = useStoredState("etoile-theme", null); // null = follow the system
  const [search, setSearch] = useState("");
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
        counts={navCounts(matrix)} loadedAt={matrix.data?.loadedAt} />
      <main className="main">
        <Topbar search={search} onSearch={setSearch} />
        <div className="view">
          <AllocationMatrix {...matrix} search={search} onRefresh={refresh} toast={toast.show} />
        </div>
      </main>
      <Toast {...toast} />
    </div>
  );
}
