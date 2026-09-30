// Guard used by EVERY /api endpoint (files starting with "_" are not routes on Vercel).
//
// 1. The browser sends the monday sessionToken (Authorization: Bearer <jwt>). monday signs it with the
//    app's secret every time the app loads inside monday; nobody else can forge it.
// 2. We verify the signature (HS256) and the expiry, that it belongs to OUR monday account (and app,
//    when MONDAY_APP_ID is set) and that the user is not a guest.
// 3. The user must be Active in the whitelist board — checked on every request (short cache), so
//    revoking someone takes effect within seconds.
// Opening the Vercel URL outside monday has no sessionToken → always refused.
//
// Env: MONDAY_TOKEN (API token, server only), MONDAY_SIGNING_SECRET and/or MONDAY_CLIENT_SECRET (both are
// tried — monday docs are ambiguous about which one signs), MONDAY_ACCOUNT_ID (required),
// MONDAY_APP_ID (optional). Local only: AUTH_DEV_USER_ID lets `npm run dev` work outside monday; it is
// ignored on Vercel.

import { createHmac, timingSafeEqual } from "node:crypto";
import { ACCESS_LIST, NOT_AUTHORIZED_MESSAGE } from "../src/lib/access.js";

const WHITELIST_TTL_MS = 30 * 1000;
const whitelistCache = new Map(); // userId → { at, user|null }

export class AccessDenied extends Error {}

export const deny = (status = 401) =>
  new Response(JSON.stringify({ error: NOT_AUTHORIZED_MESSAGE, code: "NOT_AUTHORIZED" }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const b64url = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

// HS256 JWT verification without dependencies. Returns the payload, or null if the signature/expiry fail.
export function verifyJwt(token, secret, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || !secret) return null;
  let header, payload;
  try {
    header = JSON.parse(b64url(parts[0]).toString("utf8"));
    payload = JSON.parse(b64url(parts[1]).toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;
  const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
  const given = b64url(parts[2]);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (payload.exp && now >= payload.exp * 1000) return null;
  return payload;
}

// Which secret signed it is logged once, so it can be documented (MONDAY_SIGNING_SECRET vs CLIENT_SECRET).
let loggedSecret = false;
export function verifySessionToken(token, env = process.env, now = Date.now()) {
  const candidates = [["MONDAY_SIGNING_SECRET", env.MONDAY_SIGNING_SECRET], ["MONDAY_CLIENT_SECRET", env.MONDAY_CLIENT_SECRET]].filter(([, v]) => v);
  for (const [name, secret] of candidates) {
    const payload = verifyJwt(token, secret, now);
    if (!payload) continue;
    if (!loggedSecret) {
      console.log(`[auth] sessionToken verified with ${name}`);
      loggedSecret = true;
    }
    const dat = payload.dat || {};
    if (!dat.user_id || !dat.account_id) throw new AccessDenied("incomplete token");
    if (!env.MONDAY_ACCOUNT_ID || String(dat.account_id) !== String(env.MONDAY_ACCOUNT_ID)) throw new AccessDenied("wrong account");
    if (env.MONDAY_APP_ID && String(dat.app_id) !== String(env.MONDAY_APP_ID)) throw new AccessDenied("wrong app");
    if (dat.is_guest) throw new AccessDenied("guest");
    return { userId: String(dat.user_id), accountId: String(dat.account_id), isAdmin: Boolean(dat.is_admin), isViewOnly: Boolean(dat.is_view_only) };
  }
  throw new AccessDenied("bad signature");
}

async function monday(query, variables = {}) {
  const headers = { "Content-Type": "application/json", Authorization: process.env.MONDAY_TOKEN };
  if (process.env.MONDAY_API_VERSION) headers["API-Version"] = process.env.MONDAY_API_VERSION;
  const res = await fetch("https://api.monday.com/v2", { method: "POST", headers, body: JSON.stringify({ query, variables }) });
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join(" | "));
  return body.data;
}

// Looks the user up in the whitelist board by User ID; only Status = Active counts.
export async function whitelistUser(userId) {
  const hit = whitelistCache.get(userId);
  if (hit && Date.now() - hit.at < WHITELIST_TTL_MS) return hit.user;
  const c = ACCESS_LIST.col;
  const d = await monday(
    `query($b:ID!,$v:[String]!){ items_page_by_column_values(board_id:$b, limit:5, columns:[{column_id:"${c.userId}", column_values:$v}]){ items { id name column_values(ids:["${c.status}","${c.role}","${c.email}","${c.userId}"]) { id text } } } }`,
    { b: ACCESS_LIST.board, v: [String(userId)] },
  );
  const item = (d?.items_page_by_column_values?.items || []).find((it) => it.column_values.find((x) => x.id === c.userId)?.text?.trim() === String(userId));
  const text = (id) => item?.column_values.find((x) => x.id === id)?.text || "";
  const user = item && text(c.status) === ACCESS_LIST.ACTIVE
    ? { userId: String(userId), itemId: item.id, name: item.name, email: text(c.email), role: text(c.role) === "Admin" ? "admin" : "member" }
    : null;
  whitelistCache.set(userId, { at: Date.now(), user });
  return user;
}

// Returns { session, user } or throws AccessDenied. Never tells the caller why.
export async function authenticate(request) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  let session;
  if (token) {
    session = verifySessionToken(token);
  } else if (!process.env.VERCEL && process.env.AUTH_DEV_USER_ID) {
    // Local development outside monday only (never on Vercel).
    session = { userId: String(process.env.AUTH_DEV_USER_ID), accountId: String(process.env.MONDAY_ACCOUNT_ID || ""), dev: true };
  } else {
    throw new AccessDenied("no token");
  }
  const user = await whitelistUser(session.userId);
  if (!user) throw new AccessDenied("not on the whitelist");
  return { session, user };
}

// Wrap an endpoint: runs the guard first; unauthorized → the generic 401.
export function guarded(handler) {
  return async (request) => {
    if (!process.env.MONDAY_TOKEN) return new Response(JSON.stringify({ error: "Server not configured." }), { status: 500, headers: { "Content-Type": "application/json" } });
    let ctx;
    try {
      ctx = await authenticate(request);
    } catch (e) {
      if (!(e instanceof AccessDenied)) console.error("[auth] check failed", e);
      else console.warn(`[auth] denied: ${e.message}`);
      return deny(401);
    }
    return handler(request, ctx);
  };
}

export { monday as serverMonday };
