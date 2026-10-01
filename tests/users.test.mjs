import { test } from "node:test";
import assert from "node:assert/strict";
import { addProblem, changeProblem, isEmail } from "../src/lib/userAdmin.js";

const ME = "100";
const rows = [
  { itemId: "1", name: "Me", userId: ME, status: "Active", role: "Admin" },
  { itemId: "2", name: "Ann", userId: "200", status: "Active", role: "Member" },
  { itemId: "3", name: "Bo", userId: "300", status: "Inactive", role: "Member" },
];
const change = (list, itemId, field, value) => changeProblem(list, ME, { itemId, field, value });

test("an admin can change other users' role and access", () => {
  assert.equal(change(rows, "2", "role", "Admin"), null);
  assert.equal(change(rows, "2", "status", "Inactive"), null);
  assert.equal(change(rows, "3", "status", "Active"), null);
});

test("nobody removes their own access or Admin role", () => {
  assert.match(change(rows, "1", "status", "Inactive"), /own access/);
  assert.match(change(rows, "1", "role", "Member"), /own Admin role/);
});

test("the list always keeps one active admin", () => {
  const two = rows.map((r) => (r.itemId === "2" ? { ...r, role: "Admin" } : r));
  assert.equal(changeProblem(two, "200", { itemId: "1", field: "role", value: "Member" }), null); // another admin demotes me
  const alone = [{ ...rows[0], userId: "999" }, rows[1]]; // the only admin, changed by someone else
  assert.match(changeProblem(alone, ME, { itemId: "1", field: "status", value: "Inactive" }), /only active admin/);
});

test("unknown rows, fields and values are refused", () => {
  assert.match(change(rows, "9", "role", "Admin"), /no longer in the list/);
  assert.match(change(rows, "2", "role", "Owner"), /Unknown role/);
  assert.match(change(rows, "2", "status", "Paused"), /Unknown status/);
  assert.match(change(rows, "2", "name", "x"), /Unknown change/);
});

test("adding: only enabled, non-guest monday users who are not listed yet", () => {
  assert.equal(addProblem(rows, { id: "400", enabled: true, guest: false }), null);
  assert.match(addProblem(rows, { id: "200", enabled: true }), /already in the list/);
  assert.match(addProblem(rows, { id: "401", enabled: true, guest: true }), /Guests/);
  assert.match(addProblem(rows, { id: "402", enabled: false }), /deactivated/);
  assert.match(addProblem(rows, undefined), /not in the monday account/);
});

test("email check", () => {
  assert.equal(isEmail(" kate@etoile.com "), true);
  assert.equal(isEmail("kate@etoile"), false);
  assert.equal(isEmail(""), false);
});
