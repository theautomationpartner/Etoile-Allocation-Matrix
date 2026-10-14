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

// When each part was last invalidated by a write (key "inv:<part>"): a read of monday that started before it may
// not contain that write, so it must not go back into the cache (2026-10-14: a shipment saved while a load was
// reading monday disappeared from the app until the next 6 h refresh).
const INV = (n) => `${PREFIX}inv:${n}`;
async function invalidatedAt(names) {
  if (CACHE_STORE === "memory") return names.map((n) => Number(memory.get(INV(n)) || 0));
  const raw = await redis(["MGET", ...names.map(INV)]);
  return names.map((_, i) => Number(raw?.[i] || 0));
}

// parts: { part: { at, data } } — at: when the read of monday started. A part invalidated after that is skipped.
export async function writeParts(parts) {
  let entries = Object.entries(parts);
  if (!entries.length) return;
  try {
    const inv = await invalidatedAt(entries.map(([n]) => n));
    entries = entries.filter(([, e], i) => Date.parse(e.at) >= inv[i]);
  } catch (e) {
    console.error("[cache] could not check invalidations: not caching this read", e);
    return;
  }
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

// After a write whose records were read again (api/monday-write.js, 2026-10-14): those records replace their old
// versions in the cached parts, instead of dropping the parts — the next load gets them from the cache, with the
// write, and no one has to wait for whole boards to be read again. patch({ part: data }) → { part: new data }.
// A read of monday that started before the write is still never cached (marker), and a part that is not patched
// cleanly — locked by another write patching it, invalidated meanwhile, or any error — is dropped as before.
// → { patched, dropped } (part names; a part not in the cache is in neither).
export async function patchCachedParts(names, patch) {
  const done = { patched: [], dropped: [] };
  if (!names?.length) return done;
  const mark = `${Date.now()}.${String(Math.random()).slice(2, 8)}`; // unique: tells this write's marker apart
  if (CACHE_STORE === "memory") {
    const cur = {};
    for (const n of names) {
      memory.set(INV(n), mark);
      const v = memory.get(PREFIX + n);
      if (v) cur[n] = JSON.parse(v);
    }
    const next = patch(Object.fromEntries(Object.entries(cur).map(([n, e]) => [n, e.data])));
    for (const [n, data] of Object.entries(next)) if (cur[n]) { memory.set(PREFIX + n, JSON.stringify({ ...cur[n], data })); done.patched.push(n); }
    return done;
  }
  const lock = (n) => `${PREFIX}lock:${n}`;
  let held = [];
  try {
    await Promise.all(names.map((n) => redis(["SET", INV(n), mark, "PX", String(CACHE_TTL_MS)])));
    const got = await Promise.all(names.map((n) => redis(["SET", lock(n), mark, "NX", "PX", "15000"])));
    held = names.filter((_, i) => got[i] === "OK");
    const busy = names.filter((n) => !held.includes(n));
    if (busy.length) { await redis(["DEL", ...busy.map((n) => PREFIX + n)]); done.dropped.push(...busy); } // another write is patching it
    if (!held.length) return done;
    const raw = await redis(["MGET", ...held.map((n) => PREFIX + n)]);
    const cur = {};
    held.forEach((n, i) => { if (raw?.[i]) cur[n] = typeof raw[i] === "string" ? JSON.parse(raw[i]) : raw[i]; });
    const next = patch(Object.fromEntries(Object.entries(cur).map(([n, e]) => [n, e.data])));
    // Written only if no other write invalidated the part since this one marked it (else dropped); same expiry.
    await Promise.all(Object.entries(next).filter(([n]) => cur[n]).map(async ([n, data]) => {
      const left = CACHE_TTL_MS - (Date.now() - Date.parse(cur[n].at));
      const ok = left > 1000 && Number(await redis(["EVAL", SET_IF_MARK, "2", PREFIX + n, INV(n), JSON.stringify({ ...cur[n], data }), mark, String(left)])) === 1;
      if (!ok) await redis(["DEL", PREFIX + n]);
      done[ok ? "patched" : "dropped"].push(n);
    }));
    return done;
  } catch (e) {
    console.error("[cache] patch failed: dropping those parts", e);
    await redis(["DEL", ...names.map((n) => PREFIX + n)]).catch(() => {});
    return { patched: [], dropped: names };
  } finally {
    await Promise.all(held.map((n) => redis(["EVAL", DEL_IF_MARK, "1", lock(n), mark]).catch(() => {})));
  }
}
const SET_IF_MARK = "if redis.call('GET', KEYS[2]) == ARGV[2] then redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[3]) return 1 else redis.call('DEL', KEYS[1]) return 0 end";
const DEL_IF_MARK = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

// After a write to monday: the parts it touched are read again on the next load.
export async function invalidateParts(names) {
  if (!names?.length) return;
  const now = String(Date.now());
  if (CACHE_STORE === "memory") {
    for (const n of names) { memory.delete(PREFIX + n); memory.set(INV(n), now); }
    return;
  }
  try {
    await redis(["DEL", ...names.map((n) => PREFIX + n)]);
    await Promise.all(names.map((n) => redis(["SET", INV(n), now, "PX", String(CACHE_TTL_MS)])));
  } catch (e) {
    console.error("[cache] invalidate failed", e);
  }
}
