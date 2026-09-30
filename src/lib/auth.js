// Browser side of access control. Inside monday, the app asks the monday SDK for a sessionToken
// (signed by monday) and sends it on every call to our API. Outside monday there is no token, so
// the server refuses every call and the app shows only the "not authorized" screen.

let sdk = null;
let cached = null; // { token, exp }

export class NotAuthorizedError extends Error {}

// Any call refused mid-session (e.g. the user was set Inactive) locks the whole app at once.
export const DENIED_EVENT = "etoile:not-authorized";
export function reportDenied() {
  try {
    window.dispatchEvent(new Event(DENIED_EVENT));
  } catch {
    /* not in a browser */
  }
}

// The app runs inside monday as an iframe.
export function inMonday() {
  try {
    return window.self !== window.top;
  } catch {
    return true; // cross-origin parent → framed
  }
}

async function mondaySdk() {
  if (!sdk) sdk = (await import("monday-sdk-js")).default();
  return sdk;
}

const decode = (token) => JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));

// Renewed one minute before it expires.
export async function getSessionToken() {
  if (!inMonday()) return null;
  if (cached && Date.now() < cached.exp - 60_000) return cached.token;
  const monday = await mondaySdk();
  const res = await Promise.race([monday.get("sessionToken"), new Promise((_, rej) => setTimeout(() => rej(new Error("monday did not answer")), 8000))]);
  const token = res?.data;
  if (!token || typeof token !== "string") throw new NotAuthorizedError("No session token");
  cached = { token, exp: (decode(token).exp || 0) * 1000 };
  return token;
}

export async function authHeaders() {
  const token = await getSessionToken().catch(() => null);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Who is signed in (whitelist entry). Throws NotAuthorizedError when access is refused.
export async function fetchMe() {
  const res = await fetch("/api/me", { headers: await authHeaders() });
  if (res.status === 401) throw new NotAuthorizedError();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
