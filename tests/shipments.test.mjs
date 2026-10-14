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

test("today is the local date, not the UTC one", async () => {
  const { localToday } = await import("../src/lib/shipments.js");
  const lateEvening = new Date(2026, 9, 1, 23, 30); // 1 Oct 2026, 23:30 local time
  assert.equal(localToday(lateEvening), "2026-10-01");
});

test("saving is blocked when other saved shipments already use the allocation (concurrency)", async () => {
  const { overShipped } = await import("../src/lib/shipments.js");
  const mine = { mondayId: "A", skus: ["EC0450"], qty: { EC0450: 200 } };
  const saved = [{ mondayId: "A", qty: { EC0450: 50 } }, { mondayId: "B", qty: { EC0450: 150 } }];
  assert.deepEqual(overShipped(saved, mine, () => 300), [{ sku: "EC0450", others: 150, mine: 200, allocated: 300 }]);
  assert.deepEqual(overShipped(saved, mine, () => 400), []);
});

// ── Fulfilled shipments (client, 2026-10-14): a shipment stays, with what already left ──
test("what left: Cin7's fulfilled since the shipment line was created, to the shipments in creation order", async () => {
  const { attributeShipped, shipStatus, sentUnits, pendingOf } = await import("../src/lib/shipments.js");
  const s1 = { id: "S1", skus: ["A"], qty: { A: 200 }, base: { A: 0 } };
  const at = (f, ships = [s1]) => attributeShipped(ships, () => f);
  assert.equal(shipStatus(at(0)[0]), "Draft");
  const half = at(150)[0];
  assert.deepEqual([shipStatus(half), sentUnits(half), pendingOf(half, "A")], ["Partially fulfilled", 150, 50]);
  assert.equal(shipStatus(at(200)[0]), "Fulfilled");
  // Units fulfilled before the shipment existed don't count (base = 100 when it was created).
  assert.equal(sentUnits(attributeShipped([{ ...s1, base: { A: 100 } }], () => 100)[0]), 0);
  // Two shipments: the first one leaves first; a line created later only takes what was fulfilled after it.
  const s2 = { id: "S2", skus: ["A"], qty: { A: 100 }, base: { A: 200 } };
  assert.deepEqual(at(250, [s1, s2]).map(sentUnits), [200, 50]);
  // A new, unsaved shipment (base = fulfilled now) takes nothing.
  assert.deepEqual(at(250, [s1, { id: "N", skus: ["A"], qty: { A: 30 }, base: { A: 250 } }]).map(sentUnits), [200, 0]);
  // No base at all (nothing known): nothing left.
  assert.equal(sentUnits(attributeShipped([{ id: "X", skus: ["A"], qty: { A: 5 } }], () => 9)[0]), 0);
});

test("a fulfilled shipment is never trimmed; figures count only the units still to leave", async () => {
  const { attributeShipped, trimShips, maxFor, leftToShip, overShipped } = await import("../src/lib/shipments.js");
  // The line is fully fulfilled: nothing allocated any more, the shipment keeps its 200 (before: cut to 0).
  const full = attributeShipped([{ id: "S1", skus: ["A"], qty: { A: 200 }, base: { A: 0 } }], () => 200);
  assert.deepEqual(trimShips(full, "A", 0), { ships: full, cut: 0 });
  // Partially fulfilled (150 of 200 left), allocation now 30 → only the unsent part goes down: 200 → 180.
  const part = attributeShipped([{ id: "S1", skus: ["A"], qty: { A: 200 }, base: { A: 0 } }], () => 150);
  const t = trimShips(part, "A", 30);
  assert.equal(t.cut, 20);
  assert.equal(t.ships[0].qty.A, 180);
  // Max of the shipment: what left + allocation not in other shipments; nothing left to copy.
  assert.equal(maxFor(part, part[0], "A", 50), 200);
  assert.equal(leftToShip(part, "A", 50), 0);
  // Concurrency check ignores what already left.
  assert.deepEqual(overShipped([{ ...part[0], mondayId: "B" }], { ...part[0], mondayId: "A" }, () => 100), []);
});
