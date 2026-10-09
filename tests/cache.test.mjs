import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleData, ledgerFromList, ledgerToList, withLedger } from "../src/lib/monday.js";
import { CACHE_STORE, CACHE_TTL_MS, invalidateParts, readParts, writeParts } from "../api/_cache.js";

const ledger = () => {
  const a = { itemId: "1", group: "g", sku: "EC1", entries: [{ source: "warehouse", sourceId: "w", qty: 5 }], fulfilled: null, statusLabel: "Allocated" };
  const b = { itemId: "2", group: "g", sku: "EC2", entries: [], fulfilled: 3, statusLabel: "" };
  return { byId: new Map([["1", a], ["2", b]]), byKey: new Map([["L-1", a]]) };
};
const data = () => ({
  orders: [{ id: "o", group: "topics", region: "US", lines: [{ id: "L-1", sku: "EC1", ledgerLinkId: null }, { id: "L-2", sku: "EC2", ledgerLinkId: "2" }] }],
  warehouse: {}, containers: [], pos: [],
});

test("the Ledger survives the JSON of the server cache (its Maps travel as one list)", () => {
  const cached = JSON.parse(JSON.stringify(ledgerToList(ledger())));
  const back = ledgerFromList(cached);
  assert.deepEqual(withLedger(data(), back), withLedger(data(), ledger()));
  assert.deepEqual(assembleData({ ...data(), ledger: cached }).orders, withLedger(data(), ledger()).orders);
});

test("server cache: a part is served until it is 6 h old, and a write drops it", async () => {
  assert.equal(CACHE_STORE, "memory"); // no Redis variables in tests
  const at = new Date().toISOString();
  await writeParts({ pos: { at, data: [{ id: "p" }] }, imports: { at, data: [] } });
  assert.deepEqual(Object.keys(await readParts(["pos", "imports", "ledger"])).sort(), ["imports", "pos"]);
  assert.deepEqual(Object.keys(await readParts(["pos"], Date.now() + CACHE_TTL_MS + 1)), []); // older than 6 h → read monday again
  await invalidateParts(["pos"]);
  assert.deepEqual(Object.keys(await readParts(["pos", "imports"])), ["imports"]);
  assert.equal(CACHE_TTL_MS, 6 * 60 * 60 * 1000);
});
