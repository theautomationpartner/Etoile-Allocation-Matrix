import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel } from "../src/lib/engine.js";
import { buildPurchaseOrders } from "../src/lib/purchaseOrders.js";
import { mockupData } from "./fixtures/mockup-data.mjs";

const TODAY = "2026-09-16"; // the mockup's today
const setup = (data = mockupData()) => buildPurchaseOrders(buildModel(data), data, { today: TODAY });
const row = (t, name) => t.rows.find((r) => r.name === name);
const cols = (r) => [r.ord, r.arr, r.it, r.remaining, r.moving, r.ships.map((s) => `${s.code}·${s.qty}`).join(" ")];
const line = (r, sku) => r.lines.find((l) => l.sku === sku);
const lcols = (l) => [l.status, l.ordered, l.arrived, l.shipped, l.toShip, l.reserved, l.soldTo.reduce((a, s) => a + s.qty, 0)];

test("cards and Show filter counts reproduce the mockup's Purchase Orders", () => {
  const t = setup();
  assert.deepEqual(t.cards, { open: { pos: 5, toShip: 6922 }, untouched: 1, promised: 5, late: 0 });
  assert.deepEqual(t.counts, { all: 6, open: 5, untouched: 1, partial: 4, promised: 5, late: 0 });
});

test("rows: ordered, arrived, shipped, still to ship, % on the move and the containers carrying the PO", () => {
  const t = setup();
  assert.deepEqual(cols(row(t, "PO-00385")), [7069, 7069, 0, 0, 100, ""]);
  assert.deepEqual(cols(row(t, "PO-00432")), [7490, 0, 6586, 904, 88, "FLEX-4084548·2216 FLEX-4119719·3609 FLEX-4132795·661 FLEX-4151882·100"]);
  assert.deepEqual(cols(row(t, "PO-00441")), [3700, 0, 1752, 1948, 47, "FLEX-4119719·301 FLEX-4132795·631 FLEX-4151882·820"]);
  assert.deepEqual(cols(row(t, "PO-00445")), [3600, 0, 0, 3600, 0, ""]);
  assert.equal(row(t, "PO-00432").days, 12);
  assert.equal(row(t, "PO-00385").days < 0, true); // "past ETA"
});

test("line items reproduce the mockup: status, reserved on the PO and sold to (direct + via containers)", () => {
  const t = setup();
  assert.deepEqual(lcols(line(row(t, "PO-00385"), "EC0388")), ["Fully Arrived", 2000, 2000, 0, 0, 0, 0]);
  assert.deepEqual(lcols(line(row(t, "PO-00432"), "EC0387")), ["Ordered", 1200, 0, 1200, 0, 0, 1200]);
  assert.deepEqual(lcols(line(row(t, "PO-00441"), "EC0387")), ["Ordered", 1400, 0, 632, 768, 600, 901]);
  assert.deepEqual(lcols(line(row(t, "PO-00445"), "EC0433")), ["Ordered", 1400, 0, 0, 1400, 1224, 1224]);
  assert.deepEqual(lcols(line(row(t, "PO-00450"), "EC0452")), ["Ordered", 300, 0, 180, 120, 25, 205]);
  assert.deepEqual(lcols(line(row(t, "PO-00458"), "EC0450")), ["Ordered", 800, 0, 600, 200, 200, 730]);
  assert.deepEqual(line(row(t, "PO-00441"), "EC0387").soldTo.map((s) => [s.number, s.qty]), [["EIVR118", 600], ["EIVR121", 301]]);
});

test("only US purchase orders; Arrived is monday's Qty Arrived, even above Qty Ordered", () => {
  const data = mockupData();
  data.pos.push({ id: "AU1", name: "PO-AU", region: "AU", eta: "2026-10-01", lines: [{ id: "x", sku: "EC0388", qtyOrdered: 10, qtyOutstanding: 10, qtyArrived: 0 }] });
  data.pos.find((p) => p.id === "PO-00385").lines[0].qtyArrived = 860; // over-delivered
  const t = setup(data);
  assert.equal(t.counts.all, 6);
  assert.equal(line(row(t, "PO-00385"), "EC0384").arrived, 860);
  assert.equal(row(t, "PO-00385").moving, 100);
});

test("a reservation on a PO that lands after the order's cancel date is flagged", () => {
  const data = mockupData();
  data.orders.find((o) => o.id === "EIVR118").cancelDate = "2026-12-01"; // PO-00445 lands 18 Dec
  const t = setup(data);
  assert.deepEqual(t.rows.filter(t.is.late).map((r) => r.name), ["PO-00445"]);
  assert.equal(t.cards.late, 1);
});
