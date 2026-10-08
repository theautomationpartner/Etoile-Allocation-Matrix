import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel } from "../src/lib/engine.js";
import { buildImporter, isUsImport } from "../src/lib/importer.js";
import { mockupData } from "./fixtures/mockup-data.mjs";

const TODAY = "2026-09-16"; // the mockup's today
const setup = (data = mockupData()) => buildImporter(buildModel(data), data, { today: TODAY });
const row = (t, file) => t.rows.find((r) => r.file === file);

test("cards and Show filter counts reproduce the mockup's In-Transit Importer", () => {
  const t = setup();
  assert.deepEqual(t.cards, { created: { shipments: 6, units: 10168 }, draft: 1, reverted: 2, recent: 5 });
  assert.deepEqual(t.counts, { all: 8, imported: 6, draft: 1, deleted: 2 });
});

test("rows: newest upload first, the shipment it created with its packing list, units and promised", () => {
  const t = setup();
  assert.deepEqual(t.rows.map((r) => r.uploaded), ["2026-09-15", "2026-09-10", "2026-09-04", "2026-09-01", "2026-08-28", "2026-08-11", "2026-06-18", "2026-06-11"]);
  const r = row(t, "FLEX-4119719 final.xlsx");
  assert.equal(r.status.t, "Live");
  assert.deepEqual([r.ship.code, r.ship.packingList, r.ship.eta, r.ship.units, r.ship.promised], ["FLEX-4119719", "Final", "2026-09-28", 3910, 3372]);
  const draft = row(t, "FLEX-4151882 draft.xlsx");
  assert.deepEqual([draft.ship.packingList, draft.ship.units, draft.ship.promised], ["Draft", 920, 100]);
  assert.ok(t.is.draft(draft));
  const gone = row(t, "packing list TBD.xlsx");
  assert.deepEqual([gone.status.t, gone.reverted, gone.ship], ["Reverted", true, null]);
});

test("a live upload whose shipment already landed (Archive, Done) still shows it, never as reversible", () => {
  const data = mockupData();
  data.containers.push({ id: "old", name: "US / FLEX-3855443 / 40GP", group: "group_mm19tfx0", location: "US", eta: "2026-05-01", packingList: "Done", lines: [{ id: "o1", sku: "EC0388", qty: 500, poRef: "PO-00385" }] });
  data.imports.push({ id: "imp-old", name: "US / FLEX-3855443 / 40GP", uploaded: "2026-04-20", files: ["US final PKL-FLEX-3855443.pdf"], type: "In-Transit", status: "Imported", location: "", eta: "", shipmentId: "old" });
  const r = row(setup(data), "US final PKL-FLEX-3855443.pdf");
  assert.deepEqual([r.ship.code, r.ship.packingList, r.ship.active, r.ship.units], ["FLEX-3855443", "Done", false, 500]);
  assert.equal(setup(data).is.draft(r), false);
});

test("US uploads only: Location US, or no Location and a name starting with US", () => {
  assert.equal(isUsImport({ location: "US", name: "TEST 1" }), true);
  assert.equal(isUsImport({ location: "", name: "US / FLEX-3791753 / 40GP" }), true);
  assert.equal(isUsImport({ location: "", name: "AU / EC93 / 20GP" }), false);
  assert.equal(isUsImport({ location: "AU", name: "AU / EC101" }), false);
});
