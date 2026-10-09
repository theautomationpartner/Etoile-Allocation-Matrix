import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel } from "../src/lib/engine.js";
import { findRecord } from "../src/lib/search.js";
import { mockupData } from "./fixtures/mockup-data.mjs";

const find = (text, data = mockupData()) => {
  const r = findRecord(text, data, buildModel(data));
  return r && [r.type, r.id, r.label];
};

test("requirements §3.1: priority SKU → PO → container → order", () => {
  assert.deepEqual(find("EC0450"), ["sku", "EC0450", "EC0450"]);
  assert.deepEqual(find("PO-00441"), ["po", "PO-00441", "PO-00441"]);
  assert.deepEqual(find("PO260812US"), ["po", "PO-00441", "PO-00441"]); // by Reference
  assert.deepEqual(find("FLEX-4188610"), ["ship", "US / FLEX-4188610 / 40HC", "FLEX-4188610"]);
  assert.deepEqual(find("EIVR132"), ["so", "EIVR132", "EIVR132"]);
});

test("an exact match wins inside a type; case does not matter; a SKU beats anything else", () => {
  assert.deepEqual(find("ec0387"), ["sku", "EC0387", "EC0387"]);
  assert.deepEqual(find("EC04"), ["sku", "EC0400", "EC0400"]); // first SKU starting with it
  const data = mockupData();
  data.orders.find((o) => o.id === "EIVR124").retailer = "Macy's";
  assert.deepEqual(find("macy", data), ["so", "EIVR124", "EIVR124"]); // retailer
});

test("Fulfilled orders can be found; nothing found → null; the count of other matches is reported", () => {
  assert.deepEqual(find("EIVR117"), ["so", "EIVR117", "EIVR117"]);
  assert.equal(find("zzz-nothing"), null);
  assert.equal(findRecord("", mockupData(), null), null);
  const data = mockupData();
  assert.ok(findRecord("EC03", data, buildModel(data)).more > 0);
});
