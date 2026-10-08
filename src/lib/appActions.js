// What any screen or side panel may ask the app shell for: a toast and a refresh of the monday data.
import { createContext, useContext } from "react";

export const AppActions = createContext({ toast: () => {}, refresh: async () => false });
export const useAppActions = () => useContext(AppActions);

// "Delete this shipment" (requirements "In-Transit" §8): asks the server to start monday's deletion (api/delete-shipment.js).
export async function requestShipmentDeletion(itemId) {
  const { authHeaders, NotAuthorizedError, reportDenied } = await import("./auth.js");
  const res = await fetch("/api/delete-shipment", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ itemId: String(itemId) }),
  });
  if (res.status === 401) {
    reportDenied();
    throw new NotAuthorizedError();
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// "Upload packing list" (requirements "In-Transit" §6): the people that can be picked, and the upload itself
// (api/importer-upload.js creates the Importer item and starts monday's import).
async function apiFetch(url, init = {}) {
  const { authHeaders, NotAuthorizedError, reportDenied } = await import("./auth.js");
  const res = await fetch(url, { ...init, headers: { ...(init.headers || {}), ...(await authHeaders()) } });
  if (res.status === 401) {
    reportDenied();
    throw new NotAuthorizedError();
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
export const importerPeople = () => apiFetch("/api/importer-upload");
export function uploadPackingList({ file, ...fields }) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v ?? "");
  form.append("file", file, file.name);
  return apiFetch("/api/importer-upload", { method: "POST", body: form });
}
