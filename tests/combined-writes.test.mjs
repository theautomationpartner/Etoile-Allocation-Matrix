import { test } from "node:test";
import assert from "node:assert/strict";
import { LEDGER, MAX_STEP_CHANGES, WRITE_OPS, checkSteps, checkWrite, runSteps } from "../src/lib/mondayWrites.js";
import { saveAllocation } from "../src/lib/allocationSync.js";
import { saveShipment, linkOps } from "../src/lib/shipmentsSync.js";
import { ledgerItemOf, withLedger, withLedgerFor } from "../src/lib/monday.js";
import { buildModel } from "../src/lib/engine.js";
import { mockupData } from "./fixtures/mockup-data.mjs";

const F70 = "US / FLEX-4170234 / 40HC";

test("runSteps: one request with every step when the transport can, else one operation at a time; same shape back", async () => {
  const steps = [[{ op: "deleteLedgerSubitems", variables: { entries: [{ i: "a" }] } }, null], [], [{ op: "updateLedgerItem", variables: { i: "900", v: "{}" } }]];
  const single = [];
  const one = async (op) => { single.push(op); return { op }; };
  assert.deepEqual(await runSteps(one, steps), [[{ op: "deleteLedgerSubitems" }, undefined], [], [{ op: "updateLedgerItem" }]]);
  assert.deepEqual(single, ["deleteLedgerSubitems", "updateLedgerItem"]);

  const requests = [];
  const many = async () => {};
  many.many = async (st) => { checkSteps(st); requests.push(st.map((x) => x.map((o) => o.op))); return st.map((x) => x.map((o) => ({ op: o.op }))); };
  assert.deepEqual(await runSteps(many, steps), [[{ op: "deleteLedgerSubitems" }, undefined], [], [{ op: "updateLedgerItem" }]]);
  assert.deepEqual(requests, [[["deleteLedgerSubitems"], ["updateLedgerItem"]]]);

  // More than MAX_STEP_CHANGES changes: further requests, order kept.
  requests.length = 0;
  const big = [Array.from({ length: 4 }, (_, k) => ({ op: "deleteLedgerSubitems", variables: { entries: Array.from({ length: 50 }, (_, j) => ({ i: `${k}-${j}` })) } }))];
  const out = await runSteps(many, big);
  assert.equal(MAX_STEP_CHANGES, 150);
  assert.deepEqual(requests.map((r) => r.flat().length), [3, 1]);
  assert.equal(out[0].length, 4);
});

// A transport that sends steps in one request: records them, answers like monday.
function combining() {
  const requests = [];
  let n = 0;
  const reply = (op, v) => {
    checkWrite(op, v);
    if (op === "createLedgerItem") return { create_item: { id: "901" } };
    if (op === "createShipment") return { create_item: { id: "777" } };
    if (WRITE_OPS[op].batch && op.startsWith("create")) return Object.fromEntries(v.entries.map((_, k) => [`e${k}`, { id: `s${++n}` }]));
    return {};
  };
  const write = async (op, v) => { requests.push([[op]]); return reply(op, v); };
  write.many = async (steps) => { checkSteps(steps); requests.push(steps.map((st) => st.map((o) => o.op))); return steps.map((st) => st.map((o) => reply(o.op, o.variables))); };
  return { write, requests };
}

// The line's current source records, as loadLedgerFor gives them (subs).
const lineOf = (data, id) => data.orders.flatMap((o) => o.lines).find((l) => String(l.id) === id);
const subsOf = (line) => line.entries.map((e, k) => ({ id: `old-${k}`, source: e.source, sourceId: String(e.sourceId), qty: e.qty }));

test("Allocate keeps the source records that stay and rewrites them: ONE request, no delete-and-create", async () => {
  const data = mockupData();
  const line = lineOf(data, "EIVR132-EC0452");
  assert.ok(line.entries.length >= 2);
  const { write, requests } = combining();
  const api = { loadLedger: async () => ({ byId: new Map(), byKey: new Map() }), findLedgerItem: async () => ({ id: "900", group: LEDGER.groups.active, subitemIds: subsOf(line).map((s) => s.id), subs: subsOf(line) }) };
  const res = await saveAllocation(write, api, { data, lineId: "EIVR132-EC0452", values: { warehouse: 45, [F70]: 150 } });
  // warehouse 45 → 45 and FLEX 180 → 150 (fewer or the same): rewritten; the PO is no longer used: deleted.
  // Nothing goes up, so the empty step is not sent.
  assert.deepEqual(requests, [[["deleteLedgerSubitems", "rewriteLedgerSubitems"], ["updateLedgerItem", "linkLines", "linkLines", "setTransitLines"]]]);
  assert.equal(res.allocated, 195);
});

test("Allocate: a source with more units is rewritten after what goes down; a new source is created in the same step", async () => {
  const data = mockupData();
  const line = lineOf(data, "EIVR132-EC0452");
  const subs = subsOf(line).filter((s) => s.source !== "po"); // the PO is new this time
  const { write, requests } = combining();
  const lower = subs.map((s) => ({ ...s, qty: 1 })); // every kept source goes up
  const api = { loadLedger: async () => ({ byId: new Map(), byKey: new Map() }), findLedgerItem: async () => ({ id: "900", group: LEDGER.groups.active, subitemIds: lower.map((s) => s.id), subs: lower }) };
  await saveAllocation(write, api, { data, lineId: "EIVR132-EC0452", values: { warehouse: 45, [F70]: 180, "PO-00450": 25 } });
  // Nothing goes down (that step is not sent): kept sources rewritten and the PO created together, then the columns.
  assert.deepEqual(requests, [[["rewriteLedgerSubitems", "createLedgerSubitems"], ["updateLedgerItem", "linkLines", "linkLines", "setTransitLines"]]]);
});

test("without the records' details (daily check, older callers): delete, create, then the columns — order kept", async () => {
  const data = mockupData();
  const { write, requests } = combining();
  const api = { loadLedger: async () => ({ byId: new Map(), byKey: new Map() }), findLedgerItem: async () => ({ id: "900", group: LEDGER.groups.active, subitemIds: ["a", "b", "c"] }) };
  await saveAllocation(write, api, { data, lineId: "EIVR132-EC0452", values: { warehouse: 45, [F70]: 150 } });
  assert.deepEqual(requests, [[["deleteLedgerSubitems"], ["createLedgerSubitems"], ["updateLedgerItem", "linkLines", "linkLines", "setTransitLines"]]]);
});

test("Allocate on a new line: the item first, then its records and the links in one request", async () => {
  const data = mockupData();
  const { write, requests } = combining();
  const api = { loadLedger: async () => ({ byId: new Map(), byKey: new Map() }), findLedgerItem: async () => null };
  await saveAllocation(write, api, { data, lineId: "EIVR127-EC0451", values: { "PO-00458": 10 } });
  assert.deepEqual(requests, [[["createLedgerItem"]], [["createLedgerSubitems"], ["linkLines", "linkLines"]]]);
});

test("a record monday did not create is reported (the server stops before the columns)", async () => {
  const data = mockupData();
  const write = async () => ({});
  write.many = async (steps) => steps.map((st) => st.map(() => ({}))); // no ids back
  const api = { loadLedger: async () => ({ byId: new Map(), byKey: new Map() }), findLedgerItem: async () => ({ id: "900", group: LEDGER.groups.active, subitemIds: ["a"] }) };
  await assert.rejects(saveAllocation(write, api, { data, lineId: "EIVR132-EC0452", values: { warehouse: 45, [F70]: 150 } }), /did not create every source record/);
});

test("Save of a saved shipment: the shipment, its lines and the sale-line links in ONE request, one step", async () => {
  const { write, requests } = combining();
  const ship = { name: "Shipment 1", target: "", skus: ["EC1", "EC2"], qty: { EC1: 5, EC2: 3, EC3: 0 }, mondayId: "500", subIds: { EC1: "s-1", EC3: "s-3" } };
  const line = (sku) => ({ lineId: `L-${sku}`, ledgerItemId: `LG-${sku}`, allocated: 10, productName: sku });
  const ctx = { order: { id: "1", number: "EIVR1", toShip: 20 }, lineOf: line, remaining: () => 0, splitText: () => "" };
  const res = await saveShipment(write, ship, ctx, { after: (id) => linkOps([{ ...ship, mondayId: id }], ship.skus, line) });
  assert.deepEqual(requests, [[["updateShipment", "updateShipmentLines", "createShipmentLines", "deleteShipmentItems", "linkLines"]]]);
  assert.deepEqual(res.subIds, { EC1: "s-1", EC2: "s1" });

  const fresh = combining();
  const res2 = await saveShipment(fresh.write, { ...ship, mondayId: null, subIds: {} }, ctx, { after: (id) => linkOps([{ ...ship, mondayId: id }], ship.skus, line) });
  assert.deepEqual(fresh.requests, [[["createShipment"]], [["createShipmentLines", "linkLines"]]]);
  assert.equal(res2.mondayId, "777");
});

test("Allocate reads only the Ledger records of the SKU: same figures as reading the whole Ledger", () => {
  const data = mockupData();
  const sku = "EC0452";
  const all = { byId: new Map(), byKey: new Map() };
  for (const o of data.orders) for (const l of o.lines) if (l.entries.length) all.byKey.set(String(l.id), { itemId: `L-${l.id}`, entries: l.entries });
  const only = { byId: new Map(), byKey: new Map([...all.byKey].filter(([id]) => lineOf(data, id)?.sku === sku)) };
  const pick = (m) => m.lines.filter((l) => l.sku === sku).map((l) => [l.lineId, l.allocated, l.left]);
  assert.deepEqual(pick(buildModel(withLedgerFor(data, only, sku))), pick(buildModel(withLedger(data, all))));
  assert.ok(pick(buildModel(withLedger(data, all))).length > 0);
});

test("the line's Ledger item from what was already read: linked first, else by key (Active before Released), with its records", () => {
  const sub = (id, type, src, qty) => ({ id, column_values: [{ id: LEDGER.subCol.type, text: type }, { id: LEDGER.subCol.sourceId, text: src }, { id: LEDGER.subCol.qty, text: String(qty) }] });
  const it = (id, group, key, state = "active") => ({ id, state, group: { id: group }, board: { id: LEDGER.board }, subitems: [sub(`${id}-s`, "In-Transit", "C1", 5)], column_values: [{ id: "text_mm76g12x", text: key }] });
  const items = [it("1", LEDGER.groups.released, "L1"), it("2", LEDGER.groups.active, "L1"), it("3", LEDGER.groups.active, "L2"), it("4", LEDGER.groups.active, "L3", "deleted")];
  assert.equal(ledgerItemOf(items, "L1", null).id, "2");
  assert.equal(ledgerItemOf(items, "L1", "3").id, "3");
  assert.deepEqual(ledgerItemOf(items, "L2", null), { id: "3", group: LEDGER.groups.active, subitemIds: ["3-s"], subs: [{ id: "3-s", source: "intransit", sourceId: "C1", qty: 5 }] });
  assert.equal(ledgerItemOf(items, "L3", null), null);
});
