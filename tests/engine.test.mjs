import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel, SOURCE } from "../src/lib/engine.js";
import { mockupData } from "./fixtures/mockup-data.mjs";

test("metrics reproduce the approved mockup (Allocation matrix cards)", () => {
  const { metrics } = buildModel(mockupData());
  assert.equal(metrics.unitsToAllocate, 1645);
  assert.equal(metrics.linesWithLeft, 8);
  assert.equal(metrics.draftUnits, 1566);
  assert.equal(metrics.impossible, 864);
  assert.equal(metrics.shortSkuCount, 2);
  assert.equal(metrics.freeInventory, 3020);
  assert.equal(metrics.alreadyAllocated, 12254);
  assert.deepEqual(metrics.allocatedSplit, { onHand: 464, inTransit: 7801, onOrder: 3989 });
});

test("Fulfilled orders and non-US demand are excluded", () => {
  const data = mockupData();
  data.orders.push({ id: "AU1", group: "topics", region: "AU", cancelDate: "", lines: [{ id: "x", sku: "EC0387", outstanding: 999, entries: [] }] });
  const { lines } = buildModel(data);
  assert.ok(!lines.some((l) => l.orderId === "EIVR117" || l.orderId === "AU1"));
});

test("orphan reservations do not count as allocated nor block free stock", () => {
  const data = mockupData();
  data.containers = data.containers.filter((c) => c.id !== "US / FLEX-4151882 / 40HC");
  const { lines, orphanUnits } = buildModel(data);
  const l = lines.find((x) => x.orderId === "EIVR121" && x.sku === "EC0401");
  assert.equal(l.allocated, 540);
  assert.equal(l.lostSource, true);
  assert.equal(orphanUnits, 100);
});

test("allocated is capped at To ship and the line is flagged", () => {
  const data = mockupData();
  data.orders[0].lines[0].outstanding = 1000; // EC0433 had 1,224 confirmed
  const l = buildModel(data).lines.find((x) => x.orderId === "EIVR118" && x.sku === "EC0433");
  assert.equal(l.allocated, 1000);
  assert.equal(l.left, 0);
  assert.equal(l.overAllocated, true);
});

test("PO units already on a container are not offered twice", () => {
  const m = buildModel(mockupData());
  const po441 = m.sourcesFor("EC0387").find((s) => s.source === SOURCE.PO && s.sourceId === "PO-00441");
  // 1,400 outstanding − 301 (FLEX-4119719) − 331 (FLEX-4132795) = 768
  assert.equal(po441.total, 768);
});

test("warehouse is proposed only when it covers the whole line", () => {
  const m = buildModel(mockupData());
  for (const [, parts] of m.drafts.byLine) {
    const wh = parts.find((p) => p.source === SOURCE.WAREHOUSE);
    if (wh) assert.equal(parts.length, 1);
  }
});

test("reservations on a landed (Done) container count as warehouse stock, not in transit", () => {
  const data = mockupData();
  const landed = data.containers.find((c) => c.id === "US / FLEX-4084548 / 40HC");
  landed.packingList = "Done";
  landed.group = "group_mm19tfx0"; // moved to Archive
  const base = buildModel(mockupData());
  const m = buildModel(data);
  // EIVR124 EC0395 had 800 from this container → still allocated, now on hand
  const l = m.lines.find((x) => x.orderId === "EIVR124" && x.sku === "EC0395");
  assert.equal(l.allocated, 800);
  assert.equal(l.lostSource, false);
  assert.ok(!m.containers.some((c) => c.id === landed.id), "landed container is not in-transit supply");
  assert.equal(m.metrics.alreadyAllocated, base.metrics.alreadyAllocated);
  const moved = 800 + 550 + 408; // EC0395 + EC0394 + EC0385 reserved on FLEX-4084548
  assert.equal(m.metrics.allocatedSplit.onHand, base.metrics.allocatedSplit.onHand + moved);
  assert.equal(m.metrics.allocatedSplit.inTransit, base.metrics.allocatedSplit.inTransit - moved);
});
