import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildModel } from "../lib/engine.js";
import { allocationSource } from "../config.js";
import { assembleData, DATA_PARTS } from "../lib/monday.js";

// The monday data comes from the server-side cache (api/data.js): each part (≈ board) is read from monday at most
// once every 6 h for everybody, or when someone clicks a screen's Refresh (that screen's boards only). Every figure
// is computed in the browser from those raw parts. The browser keeps the last parts too, to paint instantly while
// the server answers.
const CACHE_KEY = "etoile-parts-cache-v2"; // v2: Ledger as a list
// Parts a local write already changed (patchData): any later refresh reads them again too, so re-assembling the
// data from the parts never brings back what was there before the write.
const WRITE_PARTS = ["orders", "ledger", "shipments"];

function readCache() {
  try {
    const saved = JSON.parse(localStorage.getItem(CACHE_KEY));
    return saved?.allocationSource === allocationSource && saved.parts ? saved.parts : null;
  } catch {
    return null;
  }
}
function writeCache(parts) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ allocationSource, parts }));
  } catch {
    /* storage full or unavailable: keep working without it */
  }
}

// parts { part: { at, data } } → the app's data; partsAt: when each part was read from monday; loadedAt: the oldest.
function toData(parts) {
  const raw = Object.fromEntries(Object.entries(parts).map(([n, e]) => [n, e.data]));
  const partsAt = Object.fromEntries(Object.entries(parts).map(([n, e]) => [n, new Date(e.at)]));
  const times = Object.values(partsAt).map((d) => d.getTime());
  const data = assembleData(raw, allocationSource, new Date(times.length ? Math.min(...times) : Date.now()));
  return { ...data, partsAt };
}

async function fetchParts(refresh) {
  const { authHeaders, NotAuthorizedError, reportDenied } = await import("../lib/auth.js");
  const res = refresh
    ? await fetch("/api/data", { method: "POST", headers: { "Content-Type": "application/json", ...(await authHeaders()) }, body: JSON.stringify({ refresh }) })
    : await fetch(`/api/data?parts=${DATA_PARTS.join(",")}`, { headers: { ...(await authHeaders()) } });
  if (res.status === 401) {
    reportDenied();
    throw new NotAuthorizedError();
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`);
  return body.parts;
}

// When a part was read from monday (the oldest of the given parts) — for a screen's "read at" line.
export function readAt(data, parts) {
  const times = (parts || DATA_PARTS).map((n) => data?.partsAt?.[n]?.getTime()).filter(Boolean);
  return times.length ? new Date(Math.min(...times)) : data?.loadedAt;
}

// A failed refresh keeps the last good figures and says from when they are (§15.3).
export function useMatrixData() {
  const partsRef = useRef(readCache());
  const [data, setData] = useState(() => (partsRef.current && DATA_PARTS.every((n) => partsRef.current[n]) ? toData(partsRef.current) : null));
  const [status, setStatus] = useState(() => (data ? "ready" : "loading")); // loading | refreshing | ready | error
  const [error, setError] = useState("");
  const dataRef = useRef(data);
  const dirty = useRef(new Set());

  // One load at a time: a second call while one is running reuses it (no duplicate reads, and a late duplicate
  // response can never overwrite what the user did meanwhile).
  const inFlight = useRef(null);
  // reload() → the cached parts (monday only for parts older than 6 h); reload(parts) → those parts from monday now.
  const load = useCallback((refresh) => {
    if (!inFlight.current) inFlight.current = runLoad(refresh).finally(() => { inFlight.current = null; });
    return inFlight.current;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const runLoad = async (refresh) => {
    setStatus(dataRef.current ? "refreshing" : "loading");
    setError("");
    try {
      const ask = refresh ? [...new Set([...refresh, ...dirty.current])] : dirty.current.size ? [...dirty.current] : null;
      let got = await fetchParts(ask);
      if (!refresh && ask) got = { ...(await fetchParts(null)), ...got }; // first load after a write: everything + the written parts fresh
      dirty.current.clear();
      const parts = { ...(partsRef.current || {}), ...got };
      partsRef.current = parts;
      writeCache(parts);
      const next = toData(parts);
      dataRef.current = next;
      setData(next);
      setStatus("ready");
      return true;
    } catch (e) {
      console.error("[matrix] load failed", e);
      setError(e?.message || String(e));
      setStatus(dataRef.current ? "ready" : "error");
      return false;
    }
  };

  // Opening the app always asks the server: it answers from its cache (no monday call) unless a part is older than 6 h.
  useEffect(() => { load(); }, [load]);

  // Apply a local change already written to monday (e.g. a saved shipment) without reloading everything.
  const patchData = useCallback((fn) => {
    for (const n of WRITE_PARTS) dirty.current.add(n);
    setData((cur) => {
      if (!cur) return cur;
      const next = fn(cur);
      dataRef.current = next;
      return next;
    });
  }, []);

  const model = useMemo(() => (data ? buildModel(data) : null), [data]);
  return { data, model, status, error, reload: load, patchData };
}
