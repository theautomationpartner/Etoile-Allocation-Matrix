import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel } from "../src/lib/engine.js";
import { editorFor, entriesFrom, ledgerRecord, suggestSplit, validate, clampValue, allocatedMessage } from "../src/lib/allocation.js";
import { saveAllocation, AllocationConflict } from "../src/lib/allocationSync.js";
import { LEDGER, checkWrite } from "../src/lib/mondayWrites.js";
import { unitPaths, pathsFor, sumQ } from "../src/lib/paths.js";
import { mockupData } from "./fixtures/mockup-data.mjs";

const F70 = "US / FLEX-4170234 / 40HC";
const TODAY = "2026-09-16";
const setup = () => {
  const data = mockupData();
  return { data, model: buildModel(data) };
};

test("editor rows: one per source, cap = free + what the line already has (§8.1, §10)", () => {
  const { data, model } = setup();
  const ed = editorFor(model, data, "EIVR132-EC0452", { today: TODAY });
  assert.deepEqual(ed.rows.map((r) => r.id), ["warehouse", F70, "PO-00450"]);
  const [wh, it, po] = ed.rows;
  assert.deepEqual([wh.base, wh.max], [45, 45]); // 45 on hand, all of it already this line's
  assert.deepEqual([it.base, it.max], [180, 180]);
  assert.deepEqual([po.base, po.max], [25, 120]); // 300 ordered − 180 on FLEX-4170234 = 120
  assert.equal(it.meta, "arrives 6 Oct 2026 · packing list Final");
  assert.deepEqual(it.lines, ["180 from PO260620US"]); // supplier reference, not the PO number
  assert.equal(po.meta, "PO260620US · ETA 2 Oct 2026 · supplier has not shipped it yet");
  assert.equal(wh.meta, "physical stock at Red Stag + Boxzooka · ready to ship today");
  assert.deepEqual(ed.values, { warehouse: 45, [F70]: 180, "PO-00450": 25 });
  assert.equal(ed.goal, 250);
  assert.match(ed.title, /^Allocate EC0452 - Oval Toiletry Case: Olive Croc · EIVR132 \/ /);
  assert.match(ed.sub, /cancel date 20 Nov 2026 · 65 days left$/);
});

test("units other orders hold on a source are named in its detail line", () => {
  const { data, model } = setup();
  const ed = editorFor(model, data, "EIVR127-EC0387", { today: TODAY });
  const f32 = ed.rows.find((r) => r.id === "US / FLEX-4132795 / 40HC");
  assert.match(f32.meta, /· 501 already in other orders$/); // EIVR121 21 + EIVR124 480
});

test("a line with a draft opens with base + draft and the draft notice", () => {
  const { data, model } = setup();
  const ed = editorFor(model, data, "EIVR121-EC0400", { today: TODAY });
  const draft = model.drafts.byLine.get("EIVR121-EC0400") || [];
  assert.equal(ed.hasDraft, draft.length > 0);
  assert.equal(Object.values(ed.values).reduce((a, b) => a + b, 0), draft.reduce((a, p) => a + p.qty, 0));
});

test("Suggest a split: warehouse only when it covers at least half, then by ETA (§11.3, client rule)", () => {
  const rows = (wh) => [
    { id: "warehouse", k: "wh", max: wh, supply: true },
    { id: "c1", k: "it", max: 100, supply: true },
    { id: "p1", k: "po", max: 100, supply: true },
    { id: "landed", k: "it", max: 30, supply: false },
  ];
  assert.deepEqual(suggestSplit({ goal: 100, rows: rows(60) }), { warehouse: 60, c1: 40 });
  assert.deepEqual(suggestSplit({ goal: 100, rows: rows(40) }), { c1: 100 });
  assert.deepEqual(suggestSplit({ goal: 150, rows: rows(0) }), { c1: 100, p1: 50 });
});

test("a field never goes over its cap; the total never over To ship (§10)", () => {
  assert.deepEqual(clampValue({ max: 120 }, "500"), { value: 120, capped: true });
  assert.deepEqual(clampValue({ max: 120 }, "-3"), { value: 0, capped: false });
  const { data, model } = setup();
  const ed = editorFor(model, data, "EIVR132-EC0452");
  assert.equal(validate(ed, { warehouse: 45, [F70]: 180, "PO-00450": 25 }), "");
  assert.match(validate(ed, { warehouse: 45, [F70]: 180, "PO-00450": 120 }), /250 at most/);
});

test("entries follow the §14.1 JSON contract and the Ledger record the migration format", () => {
  const { data, model } = setup();
  const ed = editorFor(model, data, "EIVR132-EC0452");
  const entries = entriesFrom(ed, { warehouse: 45, [F70]: 180, "PO-00450": 20 }, data);
  assert.deepEqual(entries, [
    { source: "warehouse", sourceId: "wh-EC0452", ref: "Warehouse Stock", qty: 45 },
    { source: "intransit", sourceId: F70, ref: F70, qty: 180, eta: "2026-10-06", packingDone: false },
    { source: "po", sourceId: "PO-00450", ref: "PO-00450", qty: 20, eta: "2026-10-02" },
  ]);
  const rec = ledgerRecord({ order: ed.order, raw: { ...ed.raw, ordered: 250, fulfilled: 0 }, sku: "EC0452", entries, data });
  const L = LEDGER.col;
  assert.equal(rec.name, "EIVR132 | EC0452");
  assert.deepEqual(rec.itemValues[L.status], { label: "PO + In-Transit + Warehouse" });
  assert.equal(rec.itemValues[L.allocated], "245");
  assert.equal(rec.itemValues[L.whUsed], "45");
  assert.equal(rec.itemValues[L.itRefs], F70);
  assert.equal(rec.itemValues[L.poTotal], "300");
  assert.deepEqual(rec.itemValues[L.earliestEta], { date: "2026-10-02" });
  assert.equal(JSON.parse(rec.itemValues[L.json].text).length, 3);
  assert.equal(rec.subitems.length, 3);
  assert.deepEqual(rec.subitems[1].values[LEDGER.subCol.packingDone], { checked: "false" });
  assert.doesNotThrow(() => checkWrite("updateLedgerItem", { i: "1", v: JSON.stringify(rec.itemValues) }));

  const released = ledgerRecord({ order: ed.order, raw: ed.raw, sku: "EC0452", entries: [], data });
  assert.deepEqual(released.itemValues[L.status], { label: "Released" });
  assert.equal(released.itemValues[L.allocated], "0");
  assert.deepEqual(released.itemValues[L.itRel], { item_ids: [] });
  assert.equal(released.itemValues[L.earliestEta], "");
  assert.deepEqual(released.itemValues[L.json], { text: "" });
  assert.equal(released.subitems.length, 0);
});

test("lowering the warehouse row keeps a landed container's record first", () => {
  const { data, model } = setup();
  const ed = editorFor(model, data, "EIVR132-EC0452");
  ed.line.entries = [
    { source: "intransit", sourceId: "C-LANDED", ref: "US / FLEX-1 / 40HC", qty: 30, stage: "warehouse", landed: true },
    { source: "warehouse", sourceId: "wh-EC0452", ref: "Warehouse Stock", qty: 15, stage: "warehouse" },
  ];
  const out = entriesFrom(ed, { warehouse: 40 }, data);
  assert.deepEqual(out.map((e) => [e.source, e.qty]), [["intransit", 30], ["warehouse", 10]]);
});

test("Ledger writes are limited to their boards, groups and columns", () => {
  assert.throws(() => checkWrite("moveLedgerItem", { i: "1", g: "group_mm76zg9t" }), /not allowed/); // Fulfilled
  assert.doesNotThrow(() => checkWrite("moveLedgerItem", { i: "1", g: LEDGER.groups.released }));
  assert.throws(() => checkWrite("updateLedgerItem", { i: "1", v: JSON.stringify({ formula_mm76rzb0: "1" }) }), /cannot write/);
  assert.throws(() => checkWrite("linkLines", { entries: [{ target: "ledgerLine", i: "1", v: JSON.stringify({ long_text_mm4kee9f: "" }) }] }), /cannot write/);
  assert.doesNotThrow(() => checkWrite("linkLines", { entries: [{ target: "ledgerLine", i: "1", v: JSON.stringify({ [LEDGER.link.col]: { item_ids: [5] } }) }] }));
  assert.equal(allocatedMessage({ sku: "EC0452", number: "EIVR132", allocated: 200, toShip: 250 }), "Allocated · EC0452 for EIVR132: 200 of 250 units. 50 still unallocated.");
});

// ── saving, with a fake monday ──
function fakeMonday(data, { item } = {}) {
  const calls = [];
  const byKey = new Map();
  for (const o of data.orders) for (const l of o.lines) if (l.entries.length) byKey.set(String(l.id), { itemId: `L-${l.id}`, entries: l.entries });
  let n = 0;
  const write = async (op, v) => {
    checkWrite(op, v);
    calls.push([op, v]);
    if (op === "createLedgerItem") return { create_item: { id: "901" } };
    if (op === "createLedgerSubitems") return Object.fromEntries(v.entries.map((_, k) => [`e${k}`, { id: `s${++n}` }]));
    return {};
  };
  const api = { loadLedger: async () => ({ byId: new Map(), byKey }), findLedgerItem: async () => item };
  return { write, api, calls };
}

test("Allocate rewrites the line's Ledger item: old sources out, new in, columns, link", async () => {
  const { data } = setup();
  const { write, api, calls } = fakeMonday(data, { item: { id: "900", group: LEDGER.groups.active, subitemIds: ["a", "b", "c"] } });
  const res = await saveAllocation(write, api, { data, lineId: "EIVR132-EC0452", values: { warehouse: 45, [F70]: 150 } });
  assert.deepEqual(calls.map((c) => c[0]), ["deleteLedgerSubitems", "createLedgerSubitems", "updateLedgerItem", "linkLines"]);
  assert.deepEqual(calls[0][1].entries, [{ i: "a" }, { i: "b" }, { i: "c" }]);
  assert.equal(calls[1][1].p, "900");
  assert.equal(res.allocated, 195);
  const line = res.data.orders.find((o) => o.id === "EIVR132").lines.find((l) => l.sku === "EC0452");
  assert.equal(line.ledgerItemId, "900");
  assert.equal(buildModel(res.data).lines.find((l) => l.lineId === "EIVR132-EC0452").allocated, 195);
});

test("all zero releases the Ledger item; allocating again brings it back to Active (§9 transition 4)", async () => {
  const { data } = setup();
  const rel = fakeMonday(data, { item: { id: "900", group: LEDGER.groups.active, subitemIds: ["a"] } });
  await saveAllocation(rel.write, rel.api, { data, lineId: "EIVR132-EC0452", values: {} });
  assert.deepEqual(rel.calls.map((c) => c[0]), ["deleteLedgerSubitems", "updateLedgerItem", "moveLedgerItem", "linkLines"]);
  assert.match(rel.calls[1][1].v, /"label":"Released"/);
  assert.equal(rel.calls[2][1].g, LEDGER.groups.released);

  const back = fakeMonday(data, { item: { id: "900", group: LEDGER.groups.released, subitemIds: [] } });
  await saveAllocation(back.write, back.api, { data, lineId: "EIVR127-EC0451", values: { "PO-00458": 10 } });
  assert.deepEqual(back.calls.map((c) => c[0]), ["createLedgerSubitems", "updateLedgerItem", "moveLedgerItem", "linkLines"]);
  assert.equal(back.calls[2][1].g, LEDGER.groups.active);
});

test("a Ledger item in Fulfilled stays where it is, linked to its line, and is rewritten in place", async () => {
  const { data } = setup();
  const f = fakeMonday(data, { item: { id: "900", group: "group_mm76zg9t", subitemIds: ["a"] } });
  await saveAllocation(f.write, f.api, { data, lineId: "EIVR132-EC0452", values: { warehouse: 45, [F70]: 180 } });
  assert.deepEqual(f.calls.map((c) => c[0]), ["deleteLedgerSubitems", "createLedgerSubitems", "updateLedgerItem", "linkLines"]);
  const z = fakeMonday(data, { item: { id: "900", group: "group_mm76zg9t", subitemIds: ["a"] } });
  await saveAllocation(z.write, z.api, { data, lineId: "EIVR132-EC0452", values: {} });
  assert.ok(!z.calls.some((c) => c[0] === "moveLedgerItem"));
});

test("a line with no Ledger item gets one in Active, linked from its Wholesale subitem", async () => {
  const { data } = setup();
  const { write, api, calls } = fakeMonday(data, { item: null });
  await saveAllocation(write, api, { data, lineId: "EIVR127-EC0451", values: { "PO-00458": 10 } });
  assert.deepEqual(calls.map((c) => c[0]), ["createLedgerItem", "createLedgerSubitems", "linkLines"]);
  assert.deepEqual(JSON.parse(calls[2][1].entries[0].v), { [LEDGER.link.col]: { item_ids: [901] } });
  assert.equal(calls[2][1].entries[0].target, "ledgerLine");
});

test("concurrency: units confirmed by someone else since the load block the write (§10)", async () => {
  const { data } = setup();
  // Someone gave 100 units of PO-00450 / EC0452 to another line meanwhile: only 25 left for this one.
  data.orders.find((o) => o.id === "EIVR127").lines.push({ id: "EIVR127-EC0452", sku: "EC0452", outstanding: 100, entries: [] });
  const { write, api, calls } = fakeMonday(data, { item: null });
  const ledger = await api.loadLedger();
  ledger.byKey.set("EIVR127-EC0452", { itemId: "L-x", entries: [{ source: "po", sourceId: "PO-00450", qty: 100 }] });
  api.loadLedger = async () => ledger;
  await assert.rejects(
    saveAllocation(write, api, { data, lineId: "EIVR132-EC0452", values: { warehouse: 45, [F70]: 180, "PO-00450": 25 + 20 } }),
    (e) => e instanceof AllocationConflict && /Only 25 units of EC0452 are available in PO-00450 now/.test(e.message) && Boolean(e.fresh),
  );
  assert.equal(calls.length, 0);
});

test("side panel paths: every unit counted once, containers split by PO subitem (§8.3)", () => {
  const { data, model } = setup();
  const paths = unitPaths(model, data);
  const f19 = pathsFor(paths, "ship", "US / FLEX-4119719 / 40HC");
  // EIVR121 EC0387: 699 + 301 + (21 on FLEX-4132795) → on FLEX-4119719 split 699 PO-00432 + 301 PO-00441
  const ec0387 = f19.filter((p) => p.sku === "EC0387" && p.order === "EIVR121");
  assert.deepEqual(ec0387.map((p) => [p.po, p.q]), [["PO-00432", 699], ["PO-00441", 301]]);
  // Each container: promised + free = units on board.
  for (const c of model.containers) {
    const onBoard = c.lines.reduce((a, l) => a + l.qty, 0);
    assert.equal(sumQ(pathsFor(paths, "ship", String(c.id)).filter((p) => p.k === "it")), Math.max(onBoard, sumQ(pathsFor(paths, "ship", String(c.id)).filter((p) => p.order))), String(c.id));
  }
  // An order's paths add up to its To ship (allocated + left).
  const lines = model.lines.filter((l) => l.orderId === "EIVR121");
  assert.equal(sumQ(pathsFor(paths, "so", "EIVR121")), lines.reduce((a, l) => a + Math.max(l.toShip, l.entries.reduce((s, e) => s + e.qty, 0)), 0));
});
