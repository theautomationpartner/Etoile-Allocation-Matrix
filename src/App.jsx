import { useEffect } from "react";
import { Sidebar } from "./components/Sidebar.jsx";
import { Topbar } from "./components/Topbar.jsx";
import { Toast, useToast } from "./components/Toast.jsx";
import { AllocationMatrix } from "./features/allocation-matrix/AllocationMatrix.jsx";
import { useMatrixData } from "./hooks/useMatrixData.js";
import { useStoredState } from "./hooks/useStoredState.js";

export default function App() {
  const [collapsed, setCollapsed] = useStoredState("etoile-side-min", false); // §3: the browser remembers it
  const [theme, setTheme] = useStoredState("etoile-theme", null); // null = follow the system
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
    if (await matrix.reload()) toast.show("Figures refreshed from Monday.");
  };

  return (
    <div className={`app ${collapsed ? "min" : ""}`}>
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} onToggleTheme={toggleTheme} />
      <main className="main">
        <Topbar status={matrix.status} loadedAt={matrix.data?.loadedAt} onRefresh={refresh} />
        <div className="view">
          <AllocationMatrix {...matrix} onRetry={refresh} />
        </div>
      </main>
      <Toast {...toast} />
    </div>
  );
}
