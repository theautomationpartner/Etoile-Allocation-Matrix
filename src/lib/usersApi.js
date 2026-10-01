// Browser side of "Users & access" (api/users.js). Same auth as every call: the monday sessionToken.
import { authHeaders, reportDenied } from "./auth.js";

async function call(method, body) {
  const headers = { ...(await authHeaders()), ...(body ? { "Content-Type": "application/json" } : {}) };
  const res = await fetch("/api/users", { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) {
    reportDenied();
    throw new Error("Not authorized.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The server answered ${res.status}.`);
  return data;
}

export const loadUsers = () => call("GET"); // { rows, account, me }
export const addUser = (userId, role) => call("POST", { action: "add", userId, role });
export const inviteUser = (email, name, role) => call("POST", { action: "invite", email, name, role });
export const setRole = (itemId, role) => call("POST", { action: "role", itemId, role });
export const setStatus = (itemId, status) => call("POST", { action: "status", itemId, status });
