// Server-side cache of the monday data, one entry per part (≈ board), so app loads don't hit monday every time.
// Store: Redis over REST (Upstash — Vercel Marketplace; env KV_REST_API_URL + KV_REST_API_TOKEN, or
// UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN) shared by every server instance. Without those variables it
// falls back to this instance's memory: still fewer monday calls, but each cold start / instance has its own copy.
// Entry: { at: ISO date read from monday, data }. Entries expire after CACHE_TTL_MS (6 h, client decision).

export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PREFIX = "etoile:data:v2:"; // bump when the shape of a part changes (v2: Ledger as a list)
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
export const CACHE_STORE = url && token ? "redis" : "memory";

const memory = globalThis.__etoileDataCache || (globalThis.__etoileDataCache = new Map());

async function redis(command) {
  const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(command) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(`cache store: ${body.error || `HTTP ${res.status}`}`);
  return body.result;
}

// → { part: { at, data } } for the parts found and not expired.
export async function readParts(names, now = Date.now()) {
  let raw;
  if (CACHE_STORE === "redis") {
    try {
      raw = await redis(["MGET", ...names.map((n) => PREFIX + n)]);
    } catch (e) {
      console.error("[cache] read failed, reading monday instead", e);
      return {};
    }
  } else raw = names.map((n) => memory.get(PREFIX + n) ?? null);
  const out = {};
  names.forEach((n, i) => {
    const v = raw?.[i];
    if (!v) return;
    try {
      const entry = typeof v === "string" ? JSON.parse(v) : v;
      if (entry?.at && now - Date.parse(entry.at) < CACHE_TTL_MS) out[n] = entry;
    } catch { /* unreadable entry: read monday again */ }
  });
  return out;
}

// parts: { part: { at, data } }
export async function writeParts(parts) {
  const entries = Object.entries(parts);
  if (!entries.length) return;
  if (CACHE_STORE === "memory") {
    for (const [n, e] of entries) memory.set(PREFIX + n, JSON.stringify(e));
    return;
  }
  try {
    // PX: Redis drops the entry itself once it is older than the TTL.
    await Promise.all(entries.map(([n, e]) => redis(["SET", PREFIX + n, JSON.stringify(e), "PX", String(CACHE_TTL_MS)])));
  } catch (e) {
    console.error("[cache] write failed (the app keeps working, reading monday)", e);
  }
}

// After a write to monday: the parts it touched are read again on the next load.
export async function invalidateParts(names) {
  if (!names?.length) return;
  if (CACHE_STORE === "memory") {
    for (const n of names) memory.delete(PREFIX + n);
    return;
  }
  try {
    await redis(["DEL", ...names.map((n) => PREFIX + n)]);
  } catch (e) {
    console.error("[cache] invalidate failed", e);
  }
}
