// In-Transit Importer screen (mockup vImporter): every packing list uploaded to In-Transit / Wholesale Importer
// (18404604646) for the US, and the shipment it created. Read-only: uploading and deleting stay in monday.
//   US = Location US, or no Location and an item name starting with "US" (the older uploads have no Location) ·
//   Uploaded = the item's creation date · Live = Import Status "Imported" · Reverted = "Deleted in In-Transit
//   Shipments" · Shipment created = the In-Transit item of its "In-Transit Shipment" connection (active or already
//   in Archive) · Units = units on board · Promised = units open orders hold on it (the matrix's reservations).
// Still reversible = live uploads whose shipment is active with a Draft packing list.
import { SOURCE } from "./engine.js";
import { containerCode } from "./matrix.js";
import { localToday } from "./shipments.js";

export const IMPORT_FILTERS = {
  all: { label: "All uploads" },
  imported: { label: "Live shipments" },
  draft: { label: "Draft, reversible" },
  deleted: { label: "Reverted" },
};
export const RECENT_DAYS = 30; // "Uploaded this month": the last 30 days (mockup)
const LIVE = "Imported";
const REVERTED = "Deleted in In-Transit Shipments";

const day = (s) => new Date(`${s}T12:00:00`);
const daysBetween = (from, to) => Math.round((day(to) - day(from)) / 864e5);
const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);

export const isUsImport = (r) => (r.location ? r.location === "US" : /^\s*US\b/i.test(r.name || ""));

export function buildImporter(model, data, { today = localToday() } = {}) {
  const containerById = new Map((data.containers || []).map((c) => [String(c.id), c]));
  const active = new Set(model.containers.map((c) => String(c.id)));

  const rows = (data.imports || []).filter(isUsImport).map((r) => {
    const c = r.shipmentId ? containerById.get(String(r.shipmentId)) : null;
    const skus = c ? [...new Set(c.lines.map((l) => l.sku))] : [];
    const live = r.status === LIVE, reverted = r.status === REVERTED;
    return {
      id: String(r.id), name: r.name, file: r.files[0] || "", files: r.files, uploaded: r.uploaded, type: r.type, importStatus: r.status,
      status: live ? { c: "wh", t: "Live" } : reverted ? { c: "gap", t: "Reverted" } : /error/i.test(r.status) ? { c: "gap", t: "Error" }
        : { c: "po", t: r.status || "Not imported" },
      live, reverted,
      ship: c ? {
        id: String(c.id), code: containerCode(c.name), packingList: c.packingList || "", eta: c.eta || "", active: active.has(String(c.id)),
        units: sum(c.lines, (l) => l.qty), promised: sum(skus, (s) => model.usedOf(SOURCE.IN_TRANSIT, c.id, s)),
      } : null,
      recent: Boolean(r.uploaded) && daysBetween(r.uploaded, today) < RECENT_DAYS,
    };
  }).sort((a, b) => (b.uploaded || "").localeCompare(a.uploaded || "") || b.id.localeCompare(a.id)); // newest first

  const is = {
    all: () => true,
    imported: (r) => r.live,
    draft: (r) => r.live && Boolean(r.ship?.active) && r.ship.packingList === "Draft",
    deleted: (r) => r.reverted,
  };
  const counts = Object.fromEntries(Object.keys(IMPORT_FILTERS).map((k) => [k, rows.filter(is[k]).length]));
  return {
    rows,
    is,
    counts,
    cards: {
      created: { shipments: counts.imported, units: sum(rows.filter(is.imported), (r) => r.ship?.units) },
      draft: counts.draft,
      reverted: counts.deleted,
      recent: rows.filter((r) => r.recent).length,
    },
  };
}
