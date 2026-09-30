import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildModel } from "../lib/engine.js";
import { allocationSource, mondayApi } from "../config.js";

// Loads the boards and builds the model. A failed refresh keeps the last good figures
// and says from when they are (§15.3, same rule as Attention by SKU).
export function useMatrixData() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | refreshing | ready | error
  const [error, setError] = useState("");
  const hasData = useRef(false);

  const load = useCallback(async () => {
    setStatus(hasData.current ? "refreshing" : "loading");
    setError("");
    try {
      const next = await mondayApi.loadMatrixData({ allocationSource });
      hasData.current = true;
      setData(next);
      setStatus("ready");
      return true;
    } catch (e) {
      console.error("[matrix] load failed", e);
      setError(e?.message || String(e));
      setStatus(hasData.current ? "ready" : "error");
      return false;
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const model = useMemo(() => (data ? buildModel(data) : null), [data]);
  return { data, model, status, error, reload: load };
}
