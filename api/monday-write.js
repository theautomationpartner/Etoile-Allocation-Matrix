// Server-side writes to monday.com, only for authenticated, whitelisted users (see _auth.js).
// Only the operations in src/lib/mondayWrites.js are accepted, only on their boards and columns;
// every item to update or delete is checked (one query per request) to belong to the allowed board.
// The signed-in user (verified, never taken from the browser) is recorded as who saved:
//   · each SKU line of the shipment → "Owner" (person) on the New Shipments subitem
//   · the sale line connected to its shipments → "People" on the Wholesale subitem
// Several people can be listed; whoever was already there is kept.

import { guarded, serverMonday } from "./_auth.js";
import { invalidateParts } from "./_cache.js";
import { NS, WRITE_OPS, checkWrite } from "../src/lib/mondayWrites.js";
import { LINE_PEOPLE_COLUMN } from "../src/lib/access.js";

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const peopleWith = (existingValue, userId) => {
  let people = [];
  try {
    people = JSON.parse(existingValue || "{}")?.personsAndTeams || [];
  } catch {
    people = [];
  }
  if (!people.some((p) => p.kind === "person" && String(p.id) === userId)) people.push({ id: Number(userId), kind: "person" });
  return { personsAndTeams: people };
};
const addColumn = (v, columnId, value) => JSON.stringify({ ...JSON.parse(v), [columnId]: value });

// The cached data parts (api/_cache.js) each write touches: they are read from monday again on the next load, so no
// one keeps seeing the data from before the write.
const PARTS_OF_OP = {
  createShipment: ["shipments"], updateShipment: ["shipments"], createShipmentLines: ["shipments"], updateShipmentLines: ["shipments"],
  deleteShipmentItems: ["shipments"],
  createLedgerItem: ["ledger"], updateLedgerItem: ["ledger"], moveLedgerItem: ["ledger"], createLedgerSubitems: ["ledger"],
  deleteLedgerSubitems: ["ledger"], setLedgerStatus: ["ledger"], updateLedgerSubitems: ["ledger"],
  setTransitLines: ["containers"],
  linkLines: ["orders", "ledger", "shipments"], // Wholesale subitem links (Ledger, shipments, Last Fulfilled Processed)
};

export const POST = guarded(async (request, { user }) => {
  let payload;
  try {
    payload = JSON.parse(await request.text());
  } catch {
    return json(400, { error: "Body must be JSON: { op, variables }." });
  }
  const { op } = payload || {};
  const variables = payload?.variables || {};
  let def;
  try {
    def = checkWrite(op, variables);
  } catch (e) {
    return json(400, { error: e.message });
  }

  // Items touched by this request and the board each one must be on.
  let entries = def.batch ? variables.entries.map((e) => ({ ...e })) : null;
  const checks = def.batch
    ? (def.itemBoards ? entries.map((e) => ({ id: String(e.i), boards: def.itemBoards(e) })) : [])
    : def.itemBoards ? [{ id: String(variables.i), boards: def.itemBoards() }] : [];
  if (def.parentBoards) checks.push({ id: String(variables.p), boards: def.parentBoards });

  let found = new Map();
  if (checks.length) {
    const ids = [...new Set(checks.map((c) => c.id))];
    const d = await serverMonday(
      `query($i:[ID!]){ items(ids:$i, limit:100){ id state board { id } column_values(ids:["${LINE_PEOPLE_COLUMN}","${NS.subOwner}"]) { id value } } }`,
      { i: ids },
    ).catch(() => null);
    found = new Map((d?.items || []).map((it) => [String(it.id), it]));
    for (const c of checks) {
      const it = found.get(c.id);
      const gone = !it || it.state === "deleted";
      if (gone && def.skipGone) continue; // already deleted by someone else: nothing to do
      if (gone) return json(409, { error: `Item ${c.id} no longer exists in Monday. Refresh and try again.` });
      if (!c.boards.includes(String(it.board?.id))) return json(403, { error: `Item ${c.id} is not on an allowed board for ${op}.` });
    }
  }
  const valueOf = (id, columnId) => found.get(String(id))?.column_values?.find((c) => c.id === columnId)?.value;

  // Who saved, added by the server.
  if (op === "createShipmentLines") entries = entries.map((e) => ({ ...e, v: addColumn(e.v, NS.subOwner, peopleWith(null, user.userId)) }));
  if (op === "updateShipmentLines") entries = entries.map((e) => ({ ...e, v: addColumn(e.v, NS.subOwner, peopleWith(valueOf(e.i, NS.subOwner), user.userId)) }));
  if (op === "linkLines") entries = entries.map((e) => (e.target === "line" ? { ...e, v: addColumn(e.v, LINE_PEOPLE_COLUMN, peopleWith(valueOf(e.i, LINE_PEOPLE_COLUMN), user.userId)) } : e));
  if (def.skipGone) {
    entries = entries.filter((e) => found.get(String(e.i)) && found.get(String(e.i)).state !== "deleted");
    if (!entries.length) return json(200, { data: {} });
  }

  const { query, variables: vars } = WRITE_OPS[op].build(def.batch ? { ...variables, entries } : variables);
  try {
    const res = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: process.env.MONDAY_TOKEN },
      body: JSON.stringify({ query, variables: vars }),
    });
    const body = await res.json();
    await invalidateParts(PARTS_OF_OP[op] || ["orders", "ledger", "shipments", "containers"]);
    return json(200, body);
  } catch (error) {
    return json(502, { error: `Could not reach monday.com: ${error?.message || error}` });
  }
});

export function GET() {
  return json(405, { error: "Use POST." });
}
