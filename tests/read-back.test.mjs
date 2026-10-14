import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleData, ledgerReadOf, readIntoParts } from "../src/lib/monday.js";
import { LEDGER, TRANSIT_LINES, checkSteps, runSteps } from "../src/lib/mondayWrites.js";
import { readTargets } from "../api/monday-write.js";
import { patchCachedParts, readParts, writeParts } from "../api/_cache.js";
import { saveAllocation } from "../src/lib/allocationSync.js";
import { mockupData } from "./fixtures/mockup-data.mjs";

// Parts as the loaders return them (raw): two orders, the Ledger as a list, shipments, one container.
const line = (id, sku, more = {}) => ({ id, name: id, sku, ordered: 10, fulfilled: 0, outstanding: 10, lastProcessed: null, entries: [], ledgerItemId: null, ...more });
const parts = () => ({
  orders: [
    { id: "o1", name: "#1", lines: [line("l1", "EC1", { ledgerItemId: "g1" }), line("l2", "EC2")] },
    { id: "o2", name: "#2", lines: [line("l3", "EC1")] },
  ],
  ledger: [
    { itemId: "g1", group: "group_mm76c2zx", sku: "EC1", entries: [{ source: "warehouse", sourceId: "warehouse", qty: 4 }], fulfilled: 0, statusLabel: "", key: "l1" },
    { itemId: "g3", group: "group_mm76c2zx", sku: "EC1", entries: [{ source: "warehouse", sourceId: "warehouse", qty: 2 }], fulfilled: 0, statusLabel: "", key: "l3" },
  ],
  shipments: [
    { mondayId: "s1", orderId: "o1", name: "Shipment 1", createdAt: "2026-10-01T00:00:00Z", lines: [{ subId: "x", sku: "EC1", qty: 4 }] },
    { mondayId: "s2", orderId: "o2", name: "Shipment 1", createdAt: "2026-10-03T00:00:00Z", lines: [] },
  ],
  containers: [{ id: "c1", name: "C1", lines: [{ id: "t1", sku: "EC1", status: "" }, { id: "t2", sku: "EC2", status: "" }] }],
});

test("read back: the records read again replace, add or take out just those records of each part", () => {
  const p = parts();
  const out = readIntoParts(p, {
    lines: [{ id: "l1", orderId: "o1", line: line("l1", "EC1", { fulfilled: 3, lastProcessed: 3, ledgerItemId: "g1" }) }, { id: "l2", orderId: "o1", line: null }],
    ledger: [
      { itemId: "g1", record: { ...p.ledger[0], entries: [{ source: "warehouse", sourceId: "warehouse", qty: 7 }] } },
      { itemId: "g3", record: null }, // Released: the loader would no longer list it
      { itemId: "g9", record: { itemId: "g9", group: "group_mm76c2zx", sku: "EC2", entries: [], fulfilled: 0, statusLabel: "", key: "l2" } },
    ],
    shipments: [{ mondayId: "s0", ship: { mondayId: "s0", orderId: "o1", name: "Shipment 0", createdAt: "2026-09-30T00:00:00Z", lines: [] } }, { mondayId: "s2", ship: null }],
    transit: [{ id: "t1", status: "Received" }],
  });
  assert.deepEqual(Object.keys(out).sort(), ["containers", "ledger", "orders", "shipments"]);
  assert.deepEqual(out.orders[0].lines.map((l) => [l.id, l.fulfilled]), [["l1", 3]], "l1 fresh, l2 gone");
  assert.equal(out.orders[1], p.orders[1], "an order not touched is the same object");
  assert.deepEqual(out.ledger.map((r) => [r.itemId, r.entries[0]?.qty ?? 0]), [["g1", 7], ["g9", 0]]);
  assert.deepEqual(out.shipments.map((s) => s.mondayId), ["s0", "s1"], "in creation order, s2 taken out");
  assert.deepEqual(out.containers[0].lines.map((l) => l.status), ["Received", ""]);
  assert.deepEqual(p, parts(), "the parts given are not changed");
  assert.deepEqual(readIntoParts({ orders: p.orders }, { ledger: [{ itemId: "g1", record: null }] }), {}, "a part not held is left alone");
});

test("read back: assembled again, the line shows its new allocation and quantities", () => {
  const p = parts();
  const before = assembleData(p);
  assert.equal(before.orders[0].lines[0].entries[0].qty, 4);
  const next = assembleData({ ...p, ...readIntoParts(p, {
    lines: [{ id: "l1", orderId: "o1", line: line("l1", "EC1", { fulfilled: 2, ledgerItemId: "g1" }) }],
    ledger: [{ itemId: "g1", record: { ...p.ledger[0], entries: [{ source: "warehouse", sourceId: "warehouse", qty: 9 }] } }],
  }) });
  assert.equal(next.orders[0].lines[0].entries[0].qty, 9);
  assert.equal(next.orders[0].lines[0].fulfilled, 2);
  assert.equal(next.orders[1].lines[0].entries[0].qty, 2, "the other line keeps its record");
});

test("read back: the Ledger items Allocate read before writing count as a read (open groups only)", () => {
  const item = (id, group) => ({ id, group: { id: group }, column_values: [{ id: "text_mm76g12x", text: `line-${id}` }], subitems: [] });
  const r = ledgerReadOf([item("1", LEDGER.groups.active), item("2", LEDGER.groups.released)]);
  assert.deepEqual(r.ledger.map((x) => [x.itemId, x.record?.key ?? null]), [["1", "line-1"], ["2", null]]);
});

test("read back: what each write changes, by part — subitems on their item, the shipment links on nothing", () => {
  const found = new Map([["ls1", { parent_item: { id: "g1" } }], ["ss1", { parent_item: { id: "s1" } }], ["s2", { parent_item: null }]]);
  const t = readTargets([
    { op: "rewriteLedgerSubitems", variables: { entries: [{ i: "ls1", v: "{}" }] } },
    { op: "createLedgerSubitems", variables: { p: "g2", entries: [] } },
    { op: "updateLedgerItem", variables: { i: "g1", v: "{}" } },
    { op: "linkLines", variables: { entries: [{ target: "baseline", i: "l1" }, { target: "ledgerLine", i: "l2" }, { target: "line", i: "l3" }, { target: "ledger", i: "g1" }] } },
    { op: "setTransitLines", variables: { entries: [{ i: "t1", v: JSON.stringify({ [TRANSIT_LINES.col]: { label: "Received" } }) }] } },
    { op: "updateShipmentLines", variables: { entries: [{ i: "ss1", v: "{}" }] } },
    { op: "deleteShipmentItems", variables: { entries: [{ i: "s2" }] } },
  ], found);
  assert.deepEqual(t.lines, ["l1", "l2"]);
  assert.deepEqual(t.ledger.sort(), ["g1", "g2"]);
  assert.deepEqual(t.shipments.sort(), ["s1", "s2"]);
  assert.deepEqual(t.transit, [{ id: "t1", status: "Received" }]);
  assert.deepEqual(t.blind, []);
  // A subitem whose item is unknown, and a create (its id comes later): those parts are dropped as before.
  const u = readTargets([{ op: "deleteLedgerSubitems", variables: { entries: [{ i: "zz" }] } }, { op: "createShipment", variables: {} }], new Map());
  assert.deepEqual(u.blind.sort(), ["ledger", "shipments"]);
});

test("server cache: a write patches the cached part in place, keeps its read time, and an older read never overwrites it", async () => {
  const at = new Date(Date.now() - 1000).toISOString();
  await writeParts({ orders: { at, data: parts().orders } });
  await patchCachedParts(["orders", "ledger"], (cur) => readIntoParts(cur, { lines: [{ id: "l2", orderId: "o1", line: line("l2", "EC2", { fulfilled: 5 }) }] }));
  const got = await readParts(["orders", "ledger"]);
  assert.equal(got.orders.at, at, "same read time");
  assert.equal(got.orders.data[0].lines[1].fulfilled, 5);
  assert.equal(got.ledger, undefined, "a part not cached stays not cached");
  await writeParts({ orders: { at, data: parts().orders } }); // a read of monday that started before the write
  assert.equal((await readParts(["orders"])).orders.data[0].lines[1].fulfilled, 5);
});

test("runSteps: the reads the server answers reach onRead; none (one at a time, or not answered) → null", async () => {
  const steps = [[{ op: "updateLedgerItem", variables: { i: "900", v: "{}" } }]];
  const seen = [];
  const many = async () => ({});
  many.many = async (st, { read, onRead }) => { checkSteps(st); seen.push(read); onRead({ lines: [], ledger: [{ itemId: "900", record: null }] }); return st.map((x) => x.map(() => ({}))); };
  let got;
  await runSteps(many, steps, { read: { lines: ["l1"] }, onRead: (r) => { got = r; } });
  assert.deepEqual(seen, [{ lines: ["l1"] }]);
  assert.deepEqual(got, [{ lines: [], ledger: [{ itemId: "900", record: null }] }]);

  const silent = async () => ({});
  silent.many = async (st) => st.map((x) => x.map(() => ({})));
  await runSteps(silent, steps, { onRead: (r) => { got = r; } });
  assert.equal(got, null);
  await runSteps(async () => ({}), steps, { onRead: (r) => { got = r; } });
  assert.equal(got, null);

  // Split in two requests: the extra ids go with the last one; both reads come back, in order.
  seen.length = 0;
  const big = [Array.from({ length: 4 }, (_, k) => ({ op: "deleteLedgerSubitems", variables: { entries: Array.from({ length: 50 }, (_, j) => ({ i: `${k}-${j}` })) } }))];
  await runSteps(many, big, { read: { lines: ["l1"] }, onRead: (r) => { got = r; } });
  assert.deepEqual(seen, [undefined, { lines: ["l1"] }]);
  assert.equal(got.length, 2);
});

test("Allocate: the Ledger records read before and what monday has after come back as read; the line is read again too", async () => {
  const data = mockupData();
  const target = data.orders.flatMap((o) => o.lines).find((l) => l.id === "EIVR132-EC0452");
  const items = [{ id: "900", state: "active", board: { id: LEDGER.board }, group: { id: LEDGER.groups.active }, column_values: [{ id: "text_mm76g12x", text: target.id }], subitems: [] }];
  const api = { loadLedgerFor: async () => ({ ledger: { byId: new Map(), byKey: new Map() }, items }) };
  const asked = [];
  const after = { lines: [{ id: target.id, orderId: "x", line: null }], ledger: [], shipments: [], transit: [] };
  const write = async () => ({});
  write.many = async (st, { read, onRead }) => {
    asked.push(read);
    onRead(after);
    return st.map((x) => x.map((o) => (o.op.startsWith("create") ? Object.fromEntries(o.variables.entries.map((_, k) => [`e${k}`, { id: `n${k}` }])) : {})));
  };
  const res = await saveAllocation(write, api, { data, lineId: target.id, values: { warehouse: 10 } });
  assert.deepEqual(asked, [{ lines: [target.id] }]);
  assert.equal(res.read.length, 2);
  assert.deepEqual(res.read[0].ledger.map((r) => r.itemId), ["900"], "first the records read before writing");
  assert.equal(res.read[1], after, "then what monday has after");
});
