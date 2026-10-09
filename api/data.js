// The app's monday data, served from the server-side cache (api/_cache.js) — only for authenticated, whitelisted
// users (see _auth.js). Every part (≈ board) is cached on its own for 6 h:
//   GET  /api/data?parts=a,b   → { parts: { part: { at, data } }, store, ttlMs }. Parts missing or older than 6 h are
//                                read from monday first (and cached); the rest comes from the cache, no monday call.
//   POST /api/data { refresh: [parts] } → reads those parts from monday now (a screen's Refresh button), caches
//                                and returns them.
// Parts: see DATA_PARTS in src/lib/monday.js. Writes made by the app drop the parts they touch (invalidateParts),
// so the next load reads them again.

import { guarded, serverMonday } from "./_auth.js";
import { CACHE_STORE, CACHE_TTL_MS, readParts, writeParts } from "./_cache.js";
import { createMondayApi, DATA_PARTS } from "../src/lib/monday.js";

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const api = createMondayApi((query, variables) => serverMonday(query, variables));

// Two loads of the same parts at the same time on this instance share one monday read.
const inFlight = new Map();
async function fromMonday(names) {
  const key = [...names].sort().join(",");
  if (!inFlight.has(key)) {
    inFlight.set(key, (async () => {
      const at = new Date().toISOString();
      const raw = await api.loadParts(names);
      const parts = Object.fromEntries(names.map((n) => [n, { at, data: raw[n] }]));
      await writeParts(parts);
      return parts;
    })().finally(() => inFlight.delete(key)));
  }
  return inFlight.get(key);
}

const pick = (list) => {
  const names = [...new Set(String(list || "").split(",").map((s) => s.trim()).filter(Boolean))];
  const bad = names.filter((n) => !DATA_PARTS.includes(n));
  return { names: names.length ? names : DATA_PARTS, bad };
};

export const GET = guarded(async (request) => {
  const { names, bad } = pick(new URL(request.url).searchParams.get("parts"));
  if (bad.length) return json(400, { error: `Unknown parts: ${bad.join(", ")}.` });
  try {
    const cached = await readParts(names);
    const missing = names.filter((n) => !cached[n]);
    const fresh = missing.length ? await fromMonday(missing) : {};
    return json(200, { parts: { ...cached, ...fresh }, read: missing, store: CACHE_STORE, ttlMs: CACHE_TTL_MS });
  } catch (e) {
    return json(502, { error: e?.message || String(e) });
  }
});

export const POST = guarded(async (request) => {
  let names;
  try {
    names = JSON.parse(await request.text())?.refresh;
  } catch {
    return json(400, { error: "Body must be JSON: { refresh: [parts] }." });
  }
  const { names: list, bad } = pick(Array.isArray(names) ? names.join(",") : "");
  if (bad.length) return json(400, { error: `Unknown parts: ${bad.join(", ")}.` });
  try {
    const parts = await fromMonday(list);
    return json(200, { parts, read: list, store: CACHE_STORE, ttlMs: CACHE_TTL_MS });
  } catch (e) {
    return json(502, { error: e?.message || String(e) });
  }
});
