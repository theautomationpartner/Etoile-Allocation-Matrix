import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel } from "../src/lib/engine.js";
import { allocationStatus, releasePlan } from "../src/lib/allocation.js";
import { releaseLine } from "../src/lib/allocationSync.js";
import { buildReview, reviewMail } from "../src/lib/review.js";
import { BASELINE, LEDGER, TRANSIT_LINES, checkWrite } from "../src/lib/mondayWrites.js";
import { mockupData } from "./fixtures/mockup-data.mjs";

const F48 = "US / FLEX-4084548 / 40HC";
// EIVR124 EC0394: 90 warehouse + 550 on FLEX-4084548 (ETA 3 Sep). Cin7 shipped 300 since the last review.
const shipped = ({ arrivedContainer = false } = {}) => {
  const data = mockupData();
  const l = data.orders.find((o) => o.id === "EIVR124").lines.find((x) => x.sku === "EC0394");
  Object.assign(l, { ordered: 640, fulfilled: 300, outstanding: 340, lastProcessed: 0 });
  if (arrivedContainer) {
    const c = data.containers.find((x) => x.id === F48);
    c.packingList = "Done";
    for (const x of c.lines) x.poId = "PO-00432";
    Object.assign(data.pos.find((p) => p.id === "PO-00432").lines.find((x) => x.sku === "EC0394"), { qtyArrived: 700, status: "Fully Arrived" });
  }
  return data;
};
const lineOf = (m) => m.lines.find((l) => l.orderId === "EIVR124" && l.sku === "EC0394");

test("Status Allocation by quantities", () => {
  assert.equal(allocationStatus(0, 100), "Released");
  assert.equal(allocationStatus(60, 100), "Partially Allocated");
  assert.equal(allocationStatus(100, 100), "Allocated");
  assert.equal(allocationStatus(120, 100), "Over Allocated");
});

test("Release takes what already arrived first, then the farthest arrival", () => {
  // Nothing arrived: 640 held, 340 to ship → 300 back: 90 warehouse first (it is on hand), then 210 from FLEX-4084548.
  const l = lineOf(buildModel(shipped()));
  assert.equal(l.shippedSince, 300);
  const plan = releasePlan(l);
  assert.equal(plan.units, 300);
  assert.deepEqual(plan.parts.map((p) => [p.title, p.qty]), [["Warehouse", 90], ["FLEX-4084548", 210]]);
  assert.deepEqual(plan.values, { [F48]: 340 });
  // A line holding no more than it has to ship has nothing to release.
  assert.equal(releasePlan(buildModel(mockupData()).lines.find((x) => x.orderId === "EIVR124" && x.sku === "EC0394")), null);
});

test("review: shipped with none of its sources arrived is said plainly; Release is the only action", () => {
  const data = shipped();
  const items = buildReview(buildModel(data), data, { today: "2026-09-01" });
  const over = items.find((i) => i.type === "over" && i.lineId === "EIVR124-EC0394");
  assert.equal(over.title, "EIVR124 · EC0394");
  assert.match(over.text, /^640 allocated, 340 left to ship\. Cin7 shipped 300 since the last review\./);
  assert.equal(over.action, "Release 300");
  assert.equal(over.detail, "90 from Warehouse · 210 from FLEX-4084548");
  assert.ok(items.filter((i) => i.type !== "over").every((i) => !i.action));
  const mail = reviewMail(items, { appUrl: "https://example.test" });
  assert.match(mail.subject, /^Allocation Matrix · \d+ things? needs? review$/);
  assert.match(mail.text, /EIVR124 · EC0394/);
  assert.match(mail.html, /<b>EIVR124 · EC0394<\/b>/);
});

test("review: a container past its ETA, or arrived in the PO but not Done, is listed", () => {
  const data = mockupData();
  const items = buildReview(buildModel(data), data, { today: "2026-09-20" });
  assert.ok(items.some((i) => i.type === "late" && i.title === "FLEX-4084548")); // ETA 3 Sep, Final
  const c = data.containers.find((x) => x.id === F48);
  for (const x of c.lines) x.poId = "PO-00432";
  Object.assign(data.pos.find((p) => p.id === "PO-00432").lines.find((x) => x.sku === "EC0395"), { qtyArrived: 960, status: "Fully Arrived" });
  const after = buildReview(buildModel(data), data, { today: "2026-09-20" });
  assert.ok(after.some((i) => i.type === "notDone" && i.title === "FLEX-4084548" && /EC0395/.test(i.text)));
  assert.ok(!after.some((i) => i.type === "late" && i.title === "FLEX-4084548"));
});

test("review: more reserved than the warehouse holds is listed with its orders", () => {
  const data = mockupData();
  data.orders.find((o) => o.id === "EIVR132").lines.find((l) => l.sku === "EC0452").entries[0].qty = 100; // 45 on hand
  const items = buildReview(buildModel(data), data, { today: "2026-09-01" });
  const s = items.find((i) => i.type === "source" && i.sku === "EC0452");
  assert.equal(s.title, "EC0452 · Warehouse");
  assert.equal(s.text, "100 reserved, 45 on hand (US qty). Orders: EIVR132.");
});

test("Release writes the line with what stays, and Last Fulfilled Processed = US Qty Fulfilled", async () => {
  const data = shipped();
  const calls = [];
  const write = async (op, v) => {
    checkWrite(op, v);
    calls.push([op, v]);
    if (op === "createLedgerSubitems") return Object.fromEntries(v.entries.map((_, k) => [`e${k}`, { id: `s${k}` }]));
    return {};
  };
  const byKey = new Map();
  for (const o of data.orders) for (const l of o.lines) if (l.entries.length) byKey.set(String(l.id), { itemId: `L-${l.id}`, entries: l.entries });
  const api = { loadLedger: async () => ({ byId: new Map(), byKey }), findLedgerItem: async () => ({ id: "900", group: LEDGER.groups.active, subitemIds: ["a", "b"] }) };
  const res = await releaseLine(write, api, { data, lineId: "EIVR124-EC0394" });
  assert.equal(res.plan.units, 300);
  assert.equal(res.allocated, 340);
  const update = JSON.parse(calls.find((c) => c[0] === "updateLedgerItem")[1].v);
  assert.equal(update[LEDGER.col.allocated], "340");
  assert.deepEqual(update[LEDGER.col.status], { label: "Allocated" });
  const base = calls.find((c) => c[0] === "linkLines" && c[1].entries[0].target === "baseline");
  assert.deepEqual(JSON.parse(base[1].entries[0].v), { [BASELINE.col]: "300" });
  const line = buildModel(res.data).lines.find((l) => l.lineId === "EIVR124-EC0394");
  assert.equal(line.shippedSince, 0);
  assert.equal(releasePlan(line), null);
});

test("Release on an arrived container takes it from there (it is what could have shipped)", () => {
  const l = lineOf(buildModel(shipped({ arrivedContainer: true })));
  const plan = releasePlan(l);
  assert.deepEqual(plan.parts.map((p) => [p.title, p.qty]), [["Warehouse", 90], ["FLEX-4084548", 210]]);
  assert.ok(l.rawEntries.every((e) => e.stage === "warehouse"));
});

test("the new writes are limited to their boards and columns", () => {
  assert.doesNotThrow(() => checkWrite("linkLines", { entries: [{ target: "baseline", i: "1", v: JSON.stringify({ [BASELINE.col]: "5" }) }] }));
  assert.throws(() => checkWrite("linkLines", { entries: [{ target: "baseline", i: "1", v: JSON.stringify({ numeric_mm19rrnv: "5" }) }] }), /cannot write/); // US Qty Fulfilled: Make's
  assert.doesNotThrow(() => checkWrite("setTransitLines", { entries: [{ i: "1", v: JSON.stringify({ [TRANSIT_LINES.col]: { label: "Received" } }) }] }));
  assert.throws(() => checkWrite("setTransitLines", { entries: [{ i: "1", v: JSON.stringify({ numeric_mm3k24ed: "1" }) }] }), /cannot write/);
  assert.doesNotThrow(() => checkWrite("updateLedgerSubitems", { entries: [{ i: "1", v: JSON.stringify({ [LEDGER.subCol.arrival]: { label: "PO - Pending" } }) }] }));
  assert.throws(() => checkWrite("updateLedgerSubitems", { entries: [{ i: "1", v: JSON.stringify({ [LEDGER.subCol.qty]: "1" }) }] }), /cannot write/);
});
