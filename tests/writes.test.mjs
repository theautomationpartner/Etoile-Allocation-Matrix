import { test } from "node:test";
import assert from "node:assert/strict";
import { WRITE_OPS, checkWrite, batchIds, chunks, BATCH_SIZE, NS } from "../src/lib/mondayWrites.js";
import { orderParts } from "../src/lib/matrix.js";

test("line creates go in one request with aliased mutations", () => {
  const entries = [{ n: "EC1 - A", v: "{}" }, { n: "EC2 - B", v: "{}" }, { n: "EC3 - C", v: "{}" }];
  const { query, variables } = WRITE_OPS.createShipmentLines.build({ p: "99", entries });
  assert.equal((query.match(/create_subitem\(/g) || []).length, 3);
  assert.match(query, /^mutation\(\$p:ID!, \$n0:String!, \$v0:JSON!, \$n1:String!/);
  assert.deepEqual(Object.keys(variables), ["p", "n0", "v0", "n1", "v1", "n2", "v2"]);
  assert.deepEqual(batchIds({ e0: { id: 1 }, e1: { id: 2 }, e2: null }, 3), ["1", "2", null]);
});

test("batches are limited to 50 and split in chunks", () => {
  const many = Array.from({ length: 51 }, (_, k) => ({ i: String(k) }));
  assert.throws(() => checkWrite("deleteShipmentItems", { entries: many }), /at most 50/);
  assert.deepEqual(chunks(many).map((c) => c.length), [BATCH_SIZE, 1]);
});

test("each entry may only write its own columns", () => {
  assert.throws(() => checkWrite("updateShipmentLines", { entries: [{ i: "1", v: JSON.stringify({ numeric_mm19gkqq: "0" }) }] }), /cannot write/);
  assert.throws(() => checkWrite("linkLines", { entries: [{ target: "line", i: "1", v: JSON.stringify({ board_relation_mm7p81dk: {} }) }] }), /cannot write/);
  assert.throws(() => checkWrite("linkLines", { entries: [{ target: "orders", i: "1", v: "{}" }] }));
  assert.doesNotThrow(() => checkWrite("updateShipmentLines", { entries: [{ i: "1", v: JSON.stringify({ [NS.subCol.qty]: "5" }) }] }));
  assert.throws(() => checkWrite("dropBoard", {}), /Unknown/);
});

test("an order without a number shows its SO", () => {
  assert.equal(orderParts("- SO-176618").number, "SO-176618");
  assert.equal(orderParts("EIVR118 - SO-201939").number, "EIVR118");
  assert.equal(orderParts("").number, "(no number)");
});
