import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel } from "../src/lib/engine.js";
import { buildTransit } from "../src/lib/transit.js";
import { mockupData } from "./fixtures/mockup-data.mjs";

const TODAY = "2026-09-16"; // the mockup's today
const setup = (data = mockupData()) => buildTransit(buildModel(data), data, { today: TODAY });
const row = (t, code) => t.rows.find((r) => r.code === code);
const cols = (r) => [r.days, r.packingList, r.total, r.committed, r.free, r.pct, r.pos.map((p) => `${p.name}·${p.qty}`).join(" ")];

test("cards and Show filter counts reproduce the mockup's In-Transit Shipments", () => {
  const t = setup();
  assert.deepEqual(t.cards, {
    water: { shipments: 5, units: 7952 }, soon: { shipments: 2, promised: 4502 },
    free: { units: 2367, shipments: 5 }, draft: { shipments: 1, promised: 100 },
  });
  assert.deepEqual(t.counts, { all: 6, notarrived: 5, soon: 2, free: 5, committed: 6, draft: 1 });
});

test("rows: soonest ETA first, on board / committed / free / claimed and the POs on board", () => {
  const t = setup();
  assert.deepEqual(t.rows.map((r) => r.code), ["FLEX-4084548", "FLEX-4119719", "FLEX-4170234", "FLEX-4132795", "FLEX-4188610", "FLEX-4151882"]);
  assert.deepEqual(cols(row(t, "FLEX-4084548")), [-13, "Final", 2216, 1758, 458, 79, "PO-00432·2216"]);
  assert.deepEqual(cols(row(t, "FLEX-4119719")), [12, "Final", 3910, 3372, 538, 86, "PO-00432·3609 PO-00441·301"]);
  assert.deepEqual(cols(row(t, "FLEX-4170234")), [20, "Final", 1130, 1130, 0, 100, "PO-00450·780 PO-00458·350"]);
  assert.deepEqual(cols(row(t, "FLEX-4151882")), [53, "Draft", 920, 100, 820, 11, "PO-00432·100 PO-00441·820"]);
  assert.equal(row(t, "FLEX-4084548").arrived, true); // ETA passed: "landed"
});

test("Committed = what the matrix holds on the container; Free = what it still offers", () => {
  const data = mockupData();
  const model = buildModel(data);
  const t = buildTransit(model, data, { today: TODAY });
  for (const r of t.rows) {
    const c = model.containers.find((x) => String(x.id) === r.id);
    const skus = [...new Set(c.lines.map((l) => l.sku))];
    assert.equal(r.free, skus.reduce((a, s) => a + model.freeOf("intransit", c.id, s), 0), r.code);
    assert.equal(r.committed, skus.reduce((a, s) => a + model.usedOf("intransit", c.id, s), 0), r.code);
    assert.equal(r.committed, r.groups.reduce((a, g) => a + g.committed, 0), r.code);
  }
});

test("subitems: a SKU from two POs gets a total row; reservations fill the earliest PO first", () => {
  const g = row(setup(), "FLEX-4119719").groups.find((x) => x.sku === "EC0387");
  assert.deepEqual([g.onBoard, g.committed, g.free], [1000, 1000, 0]);
  assert.deepEqual(g.subs.map((s) => [s.poName, s.onBoard, s.committed, s.free]), [["PO-00432", 699, 699, 0], ["PO-00441", 301, 301, 0]]);
  assert.deepEqual(g.subs[0].promised.map((p) => [p.number, p.qty]), [["EIVR121", 699]]);
  const free = row(setup(), "FLEX-4119719").groups.find((x) => x.sku === "EC0400");
  assert.deepEqual(free.subs.map((s) => [s.committed, s.free, s.promised.length]), [[0, 300, 0]]); // "free to sell"
});

test("customers waiting: the retailers holding units on the container, once each", () => {
  const data = mockupData();
  for (const o of data.orders) o.retailer = { EIVR121: "Anthropologie", EIVR124: "Macy's", EIVR127: "Macy's" }[o.id] || "Revolve";
  assert.deepEqual(row(setup(data), "FLEX-4119719").customers.slice().sort(), ["ANTHROPOLOGIE", "MACY'S"]);
  assert.deepEqual(row(setup(data), "FLEX-4170234").customers, ["REVOLVE"]); // EIVR132
});

test("requirements §5.2 / §9 example FLEX-4188610: 700 on board, 480 promised, 220 free; EC0450 from 2 POs promised on its total row", () => {
  const data = mockupData();
  for (const o of data.orders) o.retailer = { EIVR121: "Anthropologie", EIVR124: "Macy's" }[o.id] || "Revolve";
  const r = row(setup(data), "FLEX-4188610");
  assert.deepEqual([r.total, r.committed, r.free], [700, 480, 220]);
  assert.deepEqual(r.pos.map((p) => `${p.name}·${p.qty}`), ["PO-00450·300", "PO-00458·400"]); // PO-00458 ships only its own 400
  const g = r.groups.find((x) => x.sku === "EC0450");
  assert.deepEqual([g.onBoard, g.committed, g.free, g.subs.length], [550, 480, 70, 2]);
  assert.deepEqual(g.promised.map((p) => [p.retailerShort, p.qty]).sort(), [["ANTHROPOLOGIE", 150], ["MACY'S", 180], ["REVOLVE", 150]]);
});

test("a container monday is deleting carries its Deletion Status", () => {
  const data = mockupData();
  data.containers.find((c) => c.id === "US / FLEX-4151882 / 40HC").deletionStatus = "Searching Master SKU Records";
  assert.equal(row(setup(data), "FLEX-4151882").deletionStatus, "Searching Master SKU Records");
});
