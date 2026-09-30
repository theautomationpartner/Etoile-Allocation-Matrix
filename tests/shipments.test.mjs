import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel } from "../src/lib/engine.js";
import { colIdOf, inShipments, lateUnits, leftToShip, maxFor, nextShip, remainingAfter, shipSplit, trimShips } from "../src/lib/shipments.js";
import { mockupData } from "./fixtures/mockup-data.mjs";

// The mockup's walkthrough case: EIVR132 with three shipments.
const TODAY = "2026-09-16";
function setup() {
  const data = mockupData();
  const model = buildModel(data);
  const etaOf = new Map([["warehouse", TODAY], ...data.containers.map((c) => [String(c.id), c.eta]), ...data.pos.map((p) => [String(p.id), p.eta])]);
  const srcDate = (k) => etaOf.get(k) || TODAY;
  const line = (sku) => model.lines.find((l) => l.orderId === "EIVR132" && l.sku === sku);
  const ships = [
    { id: "S1", name: "Shipment 1", target: "2026-09-25", skus: ["EC0452"], qty: { EC0452: 45 } },
    { id: "S2", name: "Shipment 2", target: "2026-10-12", skus: ["EC0450", "EC0451", "EC0452"], qty: { EC0450: 550, EC0451: 400, EC0452: 180 } },
    { id: "S3", name: "Shipment 3", target: "2026-11-02", skus: ["EC0450", "EC0452"], qty: { EC0450: 150, EC0452: 25 } },
  ];
  return { model, srcDate, line, ships };
}

test("units split across shipments in source order, never twice (§16.2)", () => {
  const { srcDate, line, ships } = setup();
  const split = shipSplit(ships, line("EC0452").entries, "EC0452", srcDate);
  // EC0452 allocated: 45 warehouse + 180 FLEX-4170234 + 25 PO-00450
  assert.deepEqual(split.S1, { warehouse: 45 });
  assert.deepEqual(split.S2, { "US / FLEX-4170234 / 40HC": 180 });
  assert.deepEqual(split.S3, { "PO-00450": 25 });
});

test("remaining, max and copy-remaining figures (§16.2)", () => {
  const { line, ships } = setup();
  const a = line("EC0450").allocated; // 700
  assert.equal(inShipments(ships, "EC0450"), 700);
  assert.equal(leftToShip(ships, "EC0450", a), 0);
  assert.equal(remainingAfter(ships, ships[1], "EC0450", a), 150);
  assert.equal(maxFor(ships, ships[1], "EC0450", a), 550);
});

test("late units: a source landing after the ship date (§16.3)", () => {
  const { srcDate, line, ships } = setup();
  const early = { ...ships[1], target: "2026-10-01" }; // FLEX-4170234 arrives 6 Oct
  const split = shipSplit([ships[0], early, ships[2]], line("EC0452").entries, "EC0452", srcDate);
  assert.equal(lateUnits(early, split[early.id], srcDate), 180);
});

test("trim takes units back from the last shipment first (§16.4)", () => {
  const { ships } = setup();
  const { ships: out, cut } = trimShips(ships, "EC0450", 600);
  assert.equal(cut, 100);
  assert.equal(out[2].qty.EC0450, 50);
  assert.equal(out[1].qty.EC0450, 550);
  assert.equal(ships[2].qty.EC0450, 150, "input not mutated");
});

test("next shipment number and column ids", () => {
  const { ships } = setup();
  assert.equal(nextShip(ships, "EIVR132").name, "Shipment 4");
  assert.equal(colIdOf({ stage: "warehouse", sourceId: "x" }), "warehouse");
  assert.equal(colIdOf({ stage: "po", sourceId: 12 }), "12");
});
