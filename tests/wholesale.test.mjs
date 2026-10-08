import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel } from "../src/lib/engine.js";
import { buildWholesale } from "../src/lib/wholesale.js";
import { mockupData } from "./fixtures/mockup-data.mjs";

const TODAY = "2026-09-16"; // the mockup's today
const setup = (data = mockupData()) => buildWholesale(buildModel(data), data, { today: TODAY });
const row = (w, number) => w.rows.find((r) => r.number === number);
const cols = (r) => [r.status.t, r.ord, r.ful, r.al, r.rem, r.gap, r.pct, r.coveredBy.map((k) => k.k).join(",")];

test("cards and Show filter counts reproduce the mockup's Wholesale Allocation", () => {
  const w = setup();
  assert.deepEqual(w.cards, { blocked: { orders: 2, units: 864 }, waiting: { units: 2509, orders: 4 }, blockingSkus: ["EC0388", "EC0384"], urgent: 1 });
  assert.deepEqual(w.counts, { all: 7, unallocated: 4, blocked: 2, urgent: 1, allocated: 2 });
});

test("order rows: status, quantities, % covered and sources", () => {
  const w = setup();
  assert.deepEqual(cols(row(w, "EIVR118")), ["Ready to ship", 3964, 0, 3964, 0, 0, 100, "po"]);
  assert.deepEqual(cols(row(w, "EIVR121")), ["Partially allocated", 2631, 0, 2111, 520, 0, 80, "wh,it"]);
  assert.deepEqual(cols(row(w, "EIVR127")), ["Cannot be covered", 2110, 0, 1089, 1021, 543, 51, "wh,it"]);
  assert.deepEqual(cols(row(w, "EIVR129")), ["Cannot be covered", 1708, 0, 888, 820, 321, 51, "wh,it"]);
  assert.deepEqual(cols(row(w, "EIVR132")), ["Ready to ship", 1350, 0, 1350, 0, 0, 100, "wh,it,po"]);
  assert.equal(row(w, "EIVR121").days, 45);
  assert.equal(row(w, "EIVR121").group, "group_mm1730xq");
});

test("fulfilled orders are listed as Shipped and never count as demand", () => {
  const w = setup();
  const r = row(w, "EIVR117");
  assert.deepEqual(cols(r), ["Shipped", 140, 140, 0, 0, 0, 100, ""]);
  assert.equal(r.open, false);
  assert.equal(r.lines[0].source, "Shipped");
  assert.ok(!w.is.unallocated(r) && !w.is.allocated(r) && w.is.all(r));
});

test("line items: source label and where the units come from", () => {
  const lines = row(setup(), "EIVR121").lines;
  const by = (sku) => lines.find((l) => l.sku === sku);
  assert.equal(by("EC0400").source, "Unallocated");
  assert.equal(by("EC0400").left, 520);
  assert.equal(by("EC0383").source, "Mixed");
  assert.equal(by("EC0401").source, "In-Transit");
  assert.deepEqual(by("EC0401").from.map((f) => [f.kind, f.label, f.qty]), [["it", "FLEX-4119719", 540], ["it", "FLEX-4151882", 100]]);
});

test("a reservation on a container that no longer exists shows as orphaned", () => {
  const data = mockupData();
  data.orders.find((o) => o.id === "EIVR124").lines.find((l) => l.sku === "EC0398").entries.push({ source: "intransit", sourceId: "gone", ref: "US / FLEX-0000001 / 40HC", qty: 30 });
  const l = row(setup(data), "EIVR124").lines.find((x) => x.sku === "EC0398");
  assert.deepEqual(l.from.filter((f) => f.dead).map((f) => [f.kind, f.label, f.qty]), [["gap", "FLEX-0000001", 30]]);
});

test("only US orders, and the urgent filter needs units still unallocated", () => {
  const data = mockupData();
  data.orders.push({ id: "AU1", name: "AU1", group: "topics", region: "AU", cancelDate: "2026-09-20", lines: [] });
  data.fulfilledOrders.push({ id: "AU2", name: "AU2", group: "group_mm17q5pm", region: "AU", lines: [] });
  const w = setup(data);
  assert.equal(w.counts.all, 7);
  assert.deepEqual(w.rows.filter(w.is.urgent).map((r) => r.number), ["EIVR121"]);
});
