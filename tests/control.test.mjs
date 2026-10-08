import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel } from "../src/lib/engine.js";
import { buildControl, WAITING_ROWS } from "../src/lib/control.js";
import { mockupData } from "./fixtures/mockup-data.mjs";

const TODAY = "2026-09-16"; // the mockup's "today"
const setup = () => { const data = mockupData(); const model = buildModel(data); return { data, model, cc: buildControl(model, data, { today: TODAY }) }; };

test("cards reproduce the mockup and match the matrix", () => {
  const { model, cc } = setup();
  assert.deepEqual(cc.cards.atRisk, { units: 864, skus: 2 }); // = Impossible to cover
  assert.equal(cc.cards.waiting.units, 1645); // = Units to allocate
  assert.equal(cc.cards.waiting.units, model.metrics.unitsToAllocate);
  assert.equal(cc.cards.waiting.lines, 8);
  assert.deepEqual([cc.cards.committed.total, cc.cards.committed.onHand, cc.cards.committed.inTransit, cc.cards.committed.onOrder], [12254, 464, 7801, 3989]);
  assert.equal(cc.cards.committed.total, model.metrics.alreadyAllocated);
});

test("Needs a buying decision: every short SKU, largest shortfall first (mockup rows)", () => {
  const { cc } = setup();
  assert.deepEqual(cc.short.map((s) => [s.sku, s.need, s.available, s.gap]), [["EC0388", 543, 0, 543], ["EC0384", 400, 79, 321]]);
  assert.equal(cc.short.length, setup().model.shortSkus.length); // = side nav badge
});

test("Waiting on an allocation: lines with stock behind them, soonest cancel date first, 6 rows", () => {
  const { model, cc } = setup();
  assert.deepEqual(cc.waiting.slice(0, 3).map((w) => [w.sku, w.number, w.left]), [["EC0400", "EIVR121", 520], ["EC0398", "EIVR124", 148], ["EC0386", "EIVR127", 28]]);
  assert.equal(cc.waiting[0].daysLeft, 45); // cancel date 31 Oct 2026 · 45 days left
  assert.ok(cc.waiting.length <= WAITING_ROWS);
  for (const w of cc.waiting) assert.ok(!(model.impossibleBySku.get(w.sku) > 0), `${w.sku} is short: it belongs to Needs a buying decision`);
  const all = model.lines.filter((l) => l.left > 0 && !(model.impossibleBySku.get(l.sku) > 0)).length;
  assert.equal(cc.waiting.length + cc.waitingMore, all);
});

test("Draft packing lists and What is coming in", () => {
  const { cc } = setup();
  assert.deepEqual(cc.drafts.map((d) => d.code), ["FLEX-4151882"]);
  assert.ok(cc.coming.every((a, i) => i === 0 || (cc.coming[i - 1].date || "9999") <= (a.date || "9999")), "sorted by date");
  const f19 = cc.coming.find((a) => a.title === "FLEX-4119719");
  assert.deepEqual([f19.days, f19.units], [12, 3910]); // 28 Sep 2026 · in 12 days · 3,910 units (mockup)
  assert.ok(cc.coming.some((a) => a.kind === "po" && a.title === "PO-00432" && a.reference === "PO260716US"));
});

test("Landing in 30 days: active containers arriving from tomorrow to +30 days", () => {
  const { cc } = setup();
  // FLEX-4119719 (28 Sep) and FLEX-4170234 (6 Oct); FLEX-4084548 (3 Sep) already passed its ETA.
  assert.deepEqual(cc.cards.landing, { shipments: 2, units: 5040, free: 538 }); // mockup: 5,040 · 2 shipments · 538 unclaimed
});
