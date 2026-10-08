import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildModel } from "../lib/engine.js";
import { allocationSource, mondayApi } from "../config.js";

// Every figure is computed in the browser from the raw monday data; only that raw data is cached.
// Opening the page within CACHE_TTL_MS shows the cached data instantly; after that, or when the
// user clicks Refresh, everything is read again from monday.com.
const CACHE_KEY = "etoile-matrix-cache-v9"; // v9: PO Date (raised)
export const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours (client decision); Refresh always reads fresh data

function readCache() {
  try {
    const saved = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (!saved?.data || saved.allocationSource !== allocationSource) return null;
    return { ...saved.data, loadedAt: new Date(saved.savedAt) };
  } catch {
    return null;
  }
}
function writeCache(data) {
  try {
    const { loadedAt, ...raw } = data;
    localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: loadedAt.getTime(), allocationSource, data: raw }));
  } catch {
    /* storage full or unavailable: keep working without cache */
  }
}

// A failed refresh keeps the last good figures and says from when they are (§15.3).
export function useMatrixData() {
  const [data, setData] = useState(readCache);
  const [status, setStatus] = useState(() => (data ? "ready" : "loading")); // loading | refreshing | ready | error
  const [error, setError] = useState("");
  const dataRef = useRef(data);

  // One load at a time: a second call while one is running reuses it (no duplicate monday reads, and a
  // late duplicate response can never overwrite what the user did meanwhile).
  const inFlight = useRef(null);
  const load = useCallback(() => {
    if (!inFlight.current) inFlight.current = runLoad().finally(() => { inFlight.current = null; });
    return inFlight.current;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const runLoad = async () => {
    setStatus(dataRef.current ? "refreshing" : "loading");
    setError("");
    try {
      const next = await mondayApi.loadMatrixData({ allocationSource });
      dataRef.current = next;
      setData(next);
      writeCache(next);
      setStatus("ready");
      return true;
    } catch (e) {
      console.error("[matrix] load failed", e);
      setError(e?.message || String(e));
      setStatus(dataRef.current ? "ready" : "error");
      return false;
    }
  };

  useEffect(() => {
    const cached = dataRef.current;
    if (!cached || Date.now() - cached.loadedAt.getTime() > CACHE_TTL_MS) load();
  }, [load]);

  // Apply a local change already written to monday (e.g. a saved shipment) without reloading everything.
  const patchData = useCallback((fn) => {
    setData((cur) => {
      if (!cur) return cur;
      const next = fn(cur);
      dataRef.current = next;
      writeCache(next);
      return next;
    });
  }, []);

  const model = useMemo(() => (data ? buildModel(data) : null), [data]);
  return { data, model, status, error, reload: load, patchData };
}
