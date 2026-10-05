import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel } from "../src/lib/engine.js";
import { buildOrderMatrix, containerCode, orderParts } from "../src/lib/matrix.js";
import { mockupData } from "./fixtures/mockup-data.mjs";

const matrixOf = (opts) => {
  const data = mockupData();
  return buildOrderMatrix(buildModel(data), data, opts);
};
const rollByLabel = (m, key) => {
  const g = m.groups.find((x) => x.key === key);
  return Object.fromEntries(m.cols.map((c, i) => [c.label, g.roll[i]]).filter(([, v]) => v));
};

test("columns: warehouse, containers by ETA, then POs by ETA (§5.3)", () => {
  const m = matrixOf();
  assert.deepEqual(m.cols.slice(0, 7).map((c) => c.label),
    ["Warehouse", "FLEX-4084548", "FLEX-4119719", "FLEX-4170234", "FLEX-4132795", "FLEX-4188610", "FLEX-4151882"]);
  assert.equal(m.cols[7].label, "PO-00432");
});

test("group numbers and column subtotals match the approved mockup", () => {
  const m = matrixOf();
  const g = (k) => m.groups.find((x) => x.key === k).nums;
  assert.deepEqual(g("EIVR118"), [3964, 3964, 0]);
  assert.deepEqual(g("EIVR121"), [2631, 2111, 520]);
  assert.deepEqual(g("EIVR124"), [3000, 2852, 148]);
  assert.deepEqual(g("EIVR127"), [2110, 1089, 1021]);
  assert.deepEqual(rollByLabel(m, "EIVR121"), { Warehouse: 24, "FLEX-4119719": 1816, "FLEX-4132795": 21, "FLEX-4188610": 150, "FLEX-4151882": 100 });
  assert.deepEqual(rollByLabel(m, "EIVR124"), { Warehouse: 90, "FLEX-4084548": 1350, "FLEX-4119719": 752, "FLEX-4132795": 480, "FLEX-4188610": 180 });
  assert.deepEqual(rollByLabel(m, "EIVR127"), { Warehouse: 125, "FLEX-4119719": 804, "FLEX-4132795": 160 });
  assert.equal(m.groups.find((x) => x.key === "EIVR127").end > 0, true); // Left in red: shortfall
});

test("Cannot be covered keeps only rows with a shortfall and hides empty groups", () => {
  const m = matrixOf({ filter: "blocked" });
  assert.deepEqual(m.groups.map((g) => g.key), ["EIVR127", "EIVR129"]);
  assert.ok(m.groups.every((g) => g.rows.every((r) => r.end > 0)));
});

test("a container cell shows X/Y and marks two POs on board", () => {
  const m = matrixOf();
  const row = m.groups.find((g) => g.key === "EIVR121").rows.find((r) => r.line.sku === "EC0387");
  const i = m.cols.findIndex((c) => c.label === "FLEX-4119719");
  assert.equal(row.cells[i].a, 1000);
  assert.equal(row.cells[i].tot, 1000);
  assert.equal(row.cells[i].split, "699 from PO260716US + 301 from PO260812US");
});

test("name helpers", () => {
  assert.equal(containerCode("US / FLEX-4119719 / 40HC"), "FLEX-4119719");
  assert.equal(containerCode("US / FLEX - 3951417 / 40HC"), "FLEX-3951417");
  assert.equal(containerCode("US / Harrods"), "Harrods");
  assert.deepEqual(orderParts("EIVR118 - SO-201939"), { number: "EIVR118", so: "SO-201939" });
});

test("legend totals add up what the matrix shows", () => {
  const data = mockupData();
  const model = buildModel(data);
  const m = buildOrderMatrix(model, data);
  assert.deepEqual({ wh: m.legend.wh, it: m.legend.it, po: m.legend.po }, { wh: 464, it: 7801, po: 3989 });
  assert.equal(m.legend.draft, model.metrics.draftUnits);
});

test("rows show only the product: no red notices for lost sources or over-reservations (client decision)", () => {
  const data = mockupData();
  data.orders[0].lines[0].outstanding = 1000; // EIVR118 EC0433: 1,224 reserved
  data.containers = data.containers.filter((c) => c.id !== "US / FLEX-4151882 / 40HC"); // EIVR121 EC0401 loses 100
  const m = buildOrderMatrix(buildModel(data), data);
  const row = (o, sku) => m.groups.find((g) => g.key === o).rows.find((r) => r.line.sku === sku);
  assert.equal(row("EIVR118", "EC0433").warnings, undefined);
  assert.equal(row("EIVR121", "EC0401").warnings, undefined);
  assert.equal(m.groups.find((g) => g.key === "EIVR121").review, undefined);
  assert.equal(row("EIVR121", "EC0401").line.left, row("EIVR121", "EC0401").line.toShip - row("EIVR121", "EC0401").line.allocated); // the lost units are back in Left
});

test("a closed order's subtotal knows which SKU lines it is made of", () => {
  const m = matrixOf();
  const g = m.groups.find((x) => x.key === "EIVR121");
  const i = m.cols.findIndex((c) => c.label === "FLEX-4119719");
  assert.equal(g.roll[i], 1816);
  assert.deepEqual(g.rollDetail[i].map((d) => [d.title.split(" - ")[0], d.qty]), [["EC0387", 1000], ["EC0401", 540], ["EC0383", 276]]);
});
