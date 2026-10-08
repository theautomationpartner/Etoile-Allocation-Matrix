import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel, SOURCE } from "../src/lib/engine.js";
import { mockupData } from "./fixtures/mockup-data.mjs";

test("metrics reproduce the approved mockup (Allocation matrix cards)", () => {
  const { metrics } = buildModel(mockupData());
  assert.equal(metrics.unitsToAllocate, 1645);
  assert.equal(metrics.linesWithLeft, 8);
  assert.equal(metrics.impossible, 864);
  assert.equal(metrics.shortSkuCount, 2);
  // Free inventory: the mockup's 3,020 is warehouse + in transit; POs are now added on top (client decision).
  assert.equal(metrics.freeSplit.onHand + metrics.freeSplit.inTransit, 3020);
  assert.equal(metrics.freeInventory, 3020 + metrics.freeSplit.onOrder);
  assert.equal(metrics.alreadyAllocated, 12254);
  assert.deepEqual(metrics.allocatedSplit, { onHand: 464, inTransit: 7801, onOrder: 3989 });
});

test("free PO units never repeat units already on a container", () => {
  const m = buildModel(mockupData());
  // PO-00441 EC0387: 1,400 outstanding − 301 − 331 on containers − 600 reserved by EIVR118 = 168 free
  const po = m.sourcesFor("EC0387").find((s) => s.source === SOURCE.PO && s.sourceId === "PO-00441");
  assert.equal(po.total, 768);
  assert.equal(po.free, 168);
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

test("drafts use the warehouse only when it covers at least half of the line", () => {
  const m = buildModel(mockupData());
  for (const l of m.lines) {
    const parts = m.drafts.byLine.get(l.lineId) || [];
    const wh = parts.find((p) => p.source === SOURCE.WAREHOUSE);
    if (wh) assert.ok(wh.qty >= 0.5 * l.left, `${l.orderId} ${l.sku}`);
  }
});

// Client rules (2026-10-07): a container's reservation becomes warehouse stock when its PO confirms the arrival.
// EIVR124 EC0395: 800 reserved on FLEX-4084548, whose line is 800 of PO-00432 (960 ordered).
const landedWith = ({ packing = "Done", group = "group_mm19tfx0", poLink = true, arrived = 0, status = "In Transit" } = {}) => {
  const data = mockupData();
  const c = data.containers.find((x) => x.id === "US / FLEX-4084548 / 40HC");
  c.packingList = packing;
  c.group = group;
  for (const l of c.lines) l.poId = poLink ? "PO-00432" : null;
  const pl = data.pos.find((p) => p.id === "PO-00432").lines.find((l) => l.sku === "EC0395");
  Object.assign(pl, { qtyArrived: arrived, status, qtyOutstanding: pl.qtyOrdered - arrived });
  return data;
};
const ec0395 = (m) => m.lines.find((x) => x.orderId === "EIVR124" && x.sku === "EC0395");

test("Done container, PO not arrived yet: the reservation stays In-Transit (arrived, pending receiving)", () => {
  const base = buildModel(mockupData());
  const m = buildModel(landedWith({ arrived: 0 }));
  const l = ec0395(m);
  assert.equal(l.allocated, 800);
  assert.ok(l.entries.every((e) => e.stage === SOURCE.IN_TRANSIT && e.landed && e.arrival === "arrived"));
  assert.ok(!m.containers.some((c) => c.id === "US / FLEX-4084548 / 40HC"), "landed container is not in-transit supply");
  assert.deepEqual(m.metrics.allocatedSplit, base.metrics.allocatedSplit);
});

test("Done container, PO line Fully Arrived: warehouse stock that never uses the Master SKU US qty", () => {
  const m = buildModel(landedWith({ arrived: 800, status: "Fully Arrived" }));
  const l = ec0395(m);
  assert.equal(l.allocated, 800);
  assert.ok(l.entries.every((e) => e.stage === SOURCE.WAREHOUSE && e.source === SOURCE.IN_TRANSIT && e.arrival === "received"));
  const wh = m.sourcesFor("EC0395").find((s) => s.source === SOURCE.WAREHOUSE);
  assert.equal(wh.free, 86); // US qty 86, untouched: the 800 are backed by the container
  assert.equal(wh.total, 86 + 800);
});

test("Done container, PO Partially Arrived: warehouse from 50% of the container line, In-Transit below", () => {
  const half = ec0395(buildModel(landedWith({ arrived: 400, status: "Partially Arrived" })));
  assert.ok(half.entries.every((e) => e.stage === SOURCE.WAREHOUSE && e.arrival === "partial"));
  const less = ec0395(buildModel(landedWith({ arrived: 399, status: "Partially Arrived" })));
  assert.ok(less.entries.every((e) => e.stage === SOURCE.IN_TRANSIT && e.arrival === "arrived"));
});

test("Done container in Archive with no PO connected: taken as arrived (warehouse stock)", () => {
  const l = ec0395(buildModel(landedWith({ poLink: false })));
  assert.ok(l.entries.every((e) => e.stage === SOURCE.WAREHOUSE && e.arrival === "received"));
});

test("Draft never matches the PO; Final with the units arrived counts, with the 'not marked Done' notice", () => {
  const draft = ec0395(buildModel(landedWith({ packing: "Draft", group: "topics", arrived: 800, status: "Fully Arrived" })));
  assert.ok(draft.entries.every((e) => e.stage === SOURCE.IN_TRANSIT && e.arrival === "pending"));
  const fin = ec0395(buildModel(landedWith({ packing: "Final", group: "topics", arrived: 800, status: "Fully Arrived" })));
  assert.ok(fin.entries.every((e) => e.stage === SOURCE.WAREHOUSE && e.notDone));
});

test("a PO reservation follows its units onto the container (and only into units nobody holds)", () => {
  const data = mockupData();
  // EIVR118 EC0450: 200 reserved on PO-00458. All 800 of PO-00458 EC0450 are now loaded: 350 on FLEX-4170234
  // (ETA 6 Oct) and 450 on FLEX-4188610 (ETA 27 Oct, which already had 250 of it).
  const f86 = data.containers.find((c) => c.id === "US / FLEX-4188610 / 40HC");
  f86.lines.find((l) => l.sku === "EC0450" && l.poRef === "PO-00458").qty = 450;
  const m = buildModel(data);
  const l = m.lines.find((x) => x.orderId === "EIVR118" && x.sku === "EC0450");
  // FLEX-4170234 EC0450: 550 on board, 550 already reserved (EIVR132) → no room; FLEX-4188610: 750 on board,
  // 330 reserved (EIVR121 150 + EIVR124 180) → the 200 go there.
  assert.equal(l.allocated, 200);
  assert.ok(l.followed);
  assert.deepEqual(l.entries.map((e) => [e.source, e.sourceId, e.qty, e.followedFrom]), [["intransit", "US / FLEX-4188610 / 40HC", 200, "PO-00458"]]);
});

// Client rule (2026-10-06): a cell can never show more than its source has of that SKU (e.g. 1,100/600).
test("a source never gives more units of a SKU than it has; earliest cancel date keeps them", () => {
  const data = mockupData();
  const f70 = "US / FLEX-4170234 / 40HC"; // EC0451: 400 on board, all of it EIVR132's (cancel 20 Nov)
  // EIVR129 (cancel 5 Dec) also claims 300 of EC0451 on that container: only 0 are left for it.
  data.orders.find((o) => o.id === "EIVR129").lines.push({ id: "EIVR129-EC0451", sku: "EC0451", outstanding: 300, entries: [{ source: "intransit", sourceId: f70, qty: 300 }] });
  // EIVR132 EC0452 claims 500 from the warehouse, which has 45 of it.
  data.orders.find((o) => o.id === "EIVR132").lines.find((l) => l.sku === "EC0452").entries[0].qty = 500;
  const m = buildModel(data);
  const line = (o, sku) => m.lines.find((l) => l.orderId === o && l.sku === sku);
  assert.equal(line("EIVR132", "EC0451").allocated, 400);
  assert.equal(line("EIVR129", "EC0451").allocated, 0);
  assert.equal(line("EIVR129", "EC0451").left, 300);
  assert.equal(line("EIVR129", "EC0451").overSource, 300);
  const wh = line("EIVR132", "EC0452").entries.find((e) => e.stage === "warehouse");
  assert.deepEqual([wh.qty, wh.reserved], [45, 500]);
  assert.equal(m.freeOf("warehouse", null, "EC0452"), 0);
  assert.equal(m.freeOf("intransit", f70, "EC0451"), 0);
});

test("units of a PO already shipped on a container cannot stay reserved on the PO", () => {
  const data = mockupData();
  // PO-00450 EC0451: 400 ordered, all 400 already on FLEX-4170234 → the PO itself has 0 left.
  data.orders.find((o) => o.id === "EIVR127").lines.find((l) => l.sku === "EC0451").entries = [{ source: "po", sourceId: "PO-00450", qty: 150 }];
  const l = buildModel(data).lines.find((x) => x.orderId === "EIVR127" && x.sku === "EC0451");
  assert.equal(l.allocated, 0);
  assert.equal(l.left, 150);
});

// Real case (2026-10-08, FLEX-4084548): what arrived on the PO line is first the units of its Done containers.
test("PO arrivals that belong to an earlier Done container never confirm a container still travelling", () => {
  const data = mockupData();
  const f48 = data.containers.find((c) => c.id === "US / FLEX-4084548 / 40HC"); // Final, 800 of EC0395 (PO-00432)
  for (const l of f48.lines) l.poId = "PO-00432";
  data.containers.push({ id: "US / FLEX-OLD / 40HC", name: "US / FLEX-OLD / 40HC", group: "group_mm19tfx0", location: "US", eta: "2026-08-01", packingList: "Done",
    lines: [{ id: "old-1", sku: "EC0395", qty: 160, poRef: "PO-00432", poId: "PO-00432" }] });
  const pl = data.pos.find((p) => p.id === "PO-00432").lines.find((l) => l.sku === "EC0395");
  Object.assign(pl, { qtyArrived: 160, status: "Partially Arrived" }); // exactly what FLEX-OLD brought
  let l = buildModel(data).lines.find((x) => x.orderId === "EIVR124" && x.sku === "EC0395");
  assert.ok(l.entries.every((e) => e.stage === SOURCE.IN_TRANSIT && e.arrival === "pending" && !e.notDone));
  pl.qtyArrived = 160 + 400; // now half of FLEX-4084548's line arrived too
  l = buildModel(data).lines.find((x) => x.orderId === "EIVR124" && x.sku === "EC0395");
  assert.ok(l.entries.every((e) => e.stage === SOURCE.WAREHOUSE && e.arrival === "partial" && e.notDone));
});
