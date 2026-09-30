import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyJwt, verifySessionToken, AccessDenied } from "../api/_auth.js";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(payload, secret, header = { alg: "HS256", typ: "JWT" }) {
  const head = `${b64(header)}.${b64(payload)}`;
  return `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`;
}
const NOW = 1_800_000_000_000;
const dat = { user_id: 100657040, account_id: 30507720, app_id: 12165031, is_guest: false, is_admin: true };
const token = (over = {}, secret = "signing") => sign({ dat: { ...dat, ...over }, exp: NOW / 1000 + 3600, iat: NOW / 1000 }, secret);
const ENV = { MONDAY_SIGNING_SECRET: "signing", MONDAY_CLIENT_SECRET: "client", MONDAY_ACCOUNT_ID: "30507720" };

test("a token signed with the signing secret is accepted", () => {
  assert.equal(verifySessionToken(token(), ENV, NOW).userId, "100657040");
});

test("a token signed with the client secret is accepted too (both are tried)", () => {
  assert.equal(verifySessionToken(token({}, "client"), ENV, NOW).userId, "100657040");
});

test("forged, expired, other-account, other-app and guest tokens are refused", () => {
  assert.throws(() => verifySessionToken(token({}, "attacker"), ENV, NOW), AccessDenied);
  assert.throws(() => verifySessionToken(token(), ENV, NOW + 2 * 3600 * 1000), AccessDenied);
  assert.throws(() => verifySessionToken(token({ account_id: 1 }), ENV, NOW), AccessDenied);
  assert.throws(() => verifySessionToken(token(), { ...ENV, MONDAY_APP_ID: "999" }, NOW), AccessDenied);
  assert.throws(() => verifySessionToken(token({ is_guest: true }), ENV, NOW), AccessDenied);
  assert.throws(() => verifySessionToken(token(), { ...ENV, MONDAY_ACCOUNT_ID: "" }, NOW), AccessDenied); // fails closed
});

test("only HS256 with a valid signature passes", () => {
  const none = `${b64({ alg: "none" })}.${b64({ dat })}.`;
  assert.equal(verifyJwt(none, "signing", NOW), null);
  assert.equal(verifyJwt("not.a.jwt", "signing", NOW), null);
  const t = token();
  assert.equal(verifyJwt(t.slice(0, -2) + "xx", "signing", NOW), null);
});
