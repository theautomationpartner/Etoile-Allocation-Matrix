import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel } from "../src/lib/engine.js";
import { buildSkuInventory } from "../src/lib/skuInventory.js";
import { mockupData } from "./fixtures/mockup-data.mjs";

const setup = (data = mockupData()) => buildSkuInventory(buildModel(data), data);
const row = (inv, sku) => inv.rows.find((r) => r.sku === sku);
const cols = (r) => [r.onHand, r.inTransit, r.onOrder, r.sold, r.need, r.free, r.cover, r.status.t];

test("rows reproduce the mockup's Master SKU Inventory", () => {
  const inv = setup();
  assert.deepEqual(cols(row(inv, "EC0388")), [57, 0, 0, 600, 543, 0, 10, "Short 543"]);
  assert.deepEqual(cols(row(inv, "EC0384")), [79, 0, 0, 400, 400, 79, 20, "Short 321"]);
  assert.deepEqual(cols(row(inv, "EC0400")), [8, 700, 980, 520, 520, 708, 100, "Needs assigning"]);
  assert.deepEqual(cols(row(inv, "EC0401")), [0, 1060, 1440, 1060, 420, 420, 100, "Needs assigning"]);
  assert.deepEqual(cols(row(inv, "EC0387")), [120, 1832, 2600, 2521, 300, 331, 100, "Needs assigning"]);
  assert.deepEqual(cols(row(inv, "EC0398")), [12, 752, 900, 900, 148, 12, 100, "Needs assigning"]);
  // Order: largest shortfall, then most unassigned.
  assert.deepEqual(inv.rows.slice(0, 4).map((r) => r.sku), ["EC0388", "EC0384", "EC0400", "EC0401"]);
});

test("cards and Show filter counts reproduce the mockup", () => {
  const inv = setup();
  assert.deepEqual(inv.cards.short, { skus: 2, units: 864 });
  assert.equal(inv.cards.oos, 7);
  assert.deepEqual(inv.cards.sellable, { now: 653, soon: 2367 });
  assert.deepEqual(inv.cards.committed, { units: 12254, unassignedSkus: 8 });
  assert.deepEqual(inv.counts, { all: 21, short: 2, oos: 7, unalloc: 8, free: 13, idle: 2 });
});

test("incoming records: US subitems grouped per PurchaseID, with their containers", () => {
  const data = mockupData();
  data.warehouse.EC0398.incoming = [
    { id: "s1", name: "PO260716US - Duo Vanity Case: Noir Croc", poId: "PO-00432", region: "US", eta: "2026-09-28", arrival: "Confirmed", inTransit: 752, outstanding: 900, onOrder: 900, purchaseId: "p432|EC0398", transitLineId: "US / FLEX-4119719 / 40HC-3" },
    { id: "s2", name: "PO260731AU - Duo Vanity Case: Noir Croc", poId: null, region: "AU", eta: "2026-10-16", arrival: "Confirmed", inTransit: 0, outstanding: 0, onOrder: 0, purchaseId: "pau|EC0398", transitLineId: "" },
    { id: "s3", name: "PO260826US - Duo Vanity Case: Noir Croc", poId: null, region: "US", eta: "2026-12-04", arrival: "Estimated", inTransit: 0, outstanding: 608, onOrder: 608, purchaseId: "p826|EC0398", transitLineId: "" },
  ];
  const r = row(setup(data), "EC0398");
  assert.equal(r.incoming.length, 2); // the AU record is left out
  const [a, b] = r.incoming;
  assert.deepEqual([a.poName, a.arrival, a.travelling, a.toShip, a.ships.map((s) => [s.code, s.qty, s.packingList])], ["PO-00432", "Confirmed", 752, 148, [["FLEX-4119719", 752, "Final"]]]);
  assert.deepEqual([b.arrival, b.travelling, b.toShip, b.ships.length], ["Estimated", 0, 608, 0]);
});
