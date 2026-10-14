// Server-side writes to monday.com, only for authenticated, whitelisted users (see _auth.js).
// Only the operations in src/lib/mondayWrites.js are accepted, only on their boards and columns;
// every item to update or delete is checked (one query per request) to belong to the allowed board.
// The signed-in user (verified, never taken from the browser) is recorded as who saved:
//   · each SKU line of the shipment → "Owner" (person) on the New Shipments subitem
//   · the sale line connected to its shipments → "People" on the Wholesale subitem
// Several people can be listed; whoever was already there is kept.
//
// Body: { op, variables } (one operation) or { steps: [[{ op, variables }, …], …] } (see runSteps): the steps run
// one after the other and stop at the first failure; the changes of a step are sent to monday at the same time
// (WRITE_CONCURRENCY at most). The answer of { steps } is { data: [[data of each operation]] } (+ errors).
//
// Read back (2026-10-14): after the steps, the records they changed (and body.read: { lines: [Wholesale subitem
// ids] } more to read, e.g. the lines of the order) are read again from monday in ONE request, answered as
// { data, read } and patched into the server's cache (instead of dropping whole parts), so the change shows at once
// everywhere without reading whole boards again (see readTargets).

import { guarded, serverMonday } from "./_auth.js";
import { invalidateParts, patchCachedParts } from "./_cache.js";
import { NS, TRANSIT_LINES, WRITE_CONCURRENCY, WRITE_OPS, checkSteps } from "../src/lib/mondayWrites.js";
import { LINE_PEOPLE_COLUMN } from "../src/lib/access.js";
import { createMondayApi, readIntoParts } from "../src/lib/monday.js";

const mondayRead = createMondayApi((query, variables) => serverMonday(query, variables));

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
  deleteLedgerSubitems: ["ledger"], rewriteLedgerSubitems: ["ledger"], setLedgerStatus: ["ledger"], updateLedgerSubitems: ["ledger"],
  setTransitLines: ["containers"],
  linkLines: ["orders", "ledger", "shipments"], // Wholesale subitem links (Ledger, shipments, Last Fulfilled Processed)
};

// The records each operation changes in the cached parts, to read again after the writes (found: the items looked
// up before writing, with their parent, so a subitem's change is read on its item). → { lines, ledger, shipments }
// (ids), transit ([{ id, status }]: the In-Transit Status just written — exact, nothing to read), blind (parts
// changed in a way that can't be read back: dropped as before).
// The shipment links of linkLines ("line", "ledger": Wholesale subitem / Ledger item → shipments, and who saved)
// change no cached part: no loader reads those columns (monday.js loadOrders, LEDGER_FIELDS).
export function readTargets(list, found) {
  const lines = new Set(), ledger = new Set(), shipments = new Set(), transit = [], blind = new Set();
  const parentOf = (id) => found.get(String(id))?.parent_item?.id;
  const onParent = (id, set, part) => { const p = parentOf(id); if (p) set.add(String(p)); else blind.add(part); };
  for (const { op, variables: v } of list) {
    const entries = v.entries || [];
    if (op === "linkLines") entries.forEach((e) => { if (e.target === "ledgerLine" || e.target === "baseline") lines.add(String(e.i)); });
    else if (op === "updateLedgerItem" || op === "moveLedgerItem") ledger.add(String(v.i));
    else if (op === "setLedgerStatus") entries.forEach((e) => ledger.add(String(e.i)));
    else if (op === "createLedgerSubitems") ledger.add(String(v.p));
    else if (["deleteLedgerSubitems", "rewriteLedgerSubitems", "updateLedgerSubitems"].includes(op)) entries.forEach((e) => onParent(e.i, ledger, "ledger"));
    else if (op === "updateShipment") shipments.add(String(v.i));
    else if (op === "createShipmentLines") shipments.add(String(v.p));
    else if (op === "updateShipmentLines") entries.forEach((e) => onParent(e.i, shipments, "shipments"));
    else if (op === "deleteShipmentItems") entries.forEach((e) => shipments.add(String(parentOf(e.i) || e.i))); // a line, or the shipment itself
    else if (op === "setTransitLines") entries.forEach((e) => transit.push({ id: String(e.i), status: JSON.parse(e.v)?.[TRANSIT_LINES.col]?.label ?? "" }));
    else for (const n of PARTS_OF_OP[op] || ["orders", "ledger", "shipments", "containers"]) blind.add(n); // e.g. a create: its id is only known after
  }
  return { lines: [...lines], ledger: [...ledger], shipments: [...shipments], transit, blind: [...blind] };
}
const PATCHED = { lines: "orders", ledger: "ledger", shipments: "shipments", transit: "containers" };
// body.read.lines: Wholesale subitem ids (numbers), at most 200.
const extraLines = (read) => (Array.isArray(read?.lines) ? read.lines.map(String).filter((id) => /^\d{1,20}$/.test(id)).slice(0, 200) : []);

// Items touched by an operation and the board each one must be on.
function checksOf(op, variables) {
  const def = WRITE_OPS[op];
  const checks = def.batch
    ? (def.itemBoards ? variables.entries.map((e) => ({ id: String(e.i), boards: def.itemBoards(e) })) : [])
    : def.itemBoards ? [{ id: String(variables.i), boards: def.itemBoards() }] : [];
  if (def.parentBoards) checks.push({ id: String(variables.p), boards: def.parentBoards });
  return checks;
}

// One query (100 ids at a time) for every item of every operation: board, state and the people columns.
async function lookItems(ids) {
  const found = new Map();
  const parts = [];
  for (let k = 0; k < ids.length; k += 100) parts.push(ids.slice(k, k + 100));
  const results = await Promise.all(parts.map((part) => serverMonday(
    `query($i:[ID!]){ items(ids:$i, limit:100){ id state board { id } parent_item { id } column_values(ids:["${LINE_PEOPLE_COLUMN}","${NS.subOwner}"]) { id value } } }`,
    { i: part },
  ).catch(() => null)));
  for (const d of results) for (const it of d?.items || []) found.set(String(it.id), it);
  return found;
}

const mondayWrite = async ({ query, variables }) => {
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: process.env.MONDAY_TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
};

// Runs jobs (functions returning promises) with at most `limit` at the same time; results in order.
async function pool(jobs, limit) {
  const out = new Array(jobs.length);
  let next = 0;
  const worker = async () => { while (next < jobs.length) { const k = next++; out[k] = await jobs[k](); } };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return out;
}

// One step: every change of every operation sent to monday at the same time (a batch operation is sent entry by
// entry). → { data: [data of each operation, shaped as if sent alone], errors: [] }
async function runStep(step) {
  const jobs = [], where = [];
  step.forEach(({ op, variables }, n) => {
    if (WRITE_OPS[op].batch) {
      variables.entries.forEach((e, k) => { jobs.push(() => mondayWrite(WRITE_OPS[op].build({ ...variables, entries: [e] }))); where.push({ n, k }); });
    } else {
      jobs.push(() => mondayWrite(WRITE_OPS[op].build(variables)));
      where.push({ n });
    }
  });
  const bodies = await pool(jobs, WRITE_CONCURRENCY);
  const data = step.map(() => ({}));
  const errors = [];
  bodies.forEach((b, j) => {
    const { n, k } = where[j];
    if (b?.errors?.length || b?.error_message) errors.push(...(b.errors || [{ message: b.error_message }]));
    if (k === undefined) Object.assign(data[n], b?.data || {});
    else if (b?.data?.e0 !== undefined) data[n][`e${k}`] = b.data.e0;
    // A create with no id back failed too, even without an error: what follows must not run.
    if (step[n].op.startsWith("create") && !(k === undefined ? Object.values(b?.data || {})[0]?.id : b?.data?.e0?.id)) {
      errors.push({ message: `Monday did not create one of the records (${step[n].op}).` });
    }
  });
  return { data, errors };
}

export const POST = guarded(async (request, { user }) => {
  let payload;
  try {
    payload = JSON.parse(await request.text());
  } catch {
    return json(400, { error: "Body must be JSON: { op, variables } or { steps }." });
  }
  const many = Array.isArray(payload?.steps);
  const steps = many
    ? payload.steps.map((st) => (Array.isArray(st) ? st : []).map((o) => ({ op: o?.op, variables: o?.variables || {} })))
    : [[{ op: payload?.op, variables: payload?.variables || {} }]];
  try {
    checkSteps(steps);
  } catch (e) {
    return json(400, { error: e.message });
  }
  const list = steps.flat();

  const checks = list.flatMap(({ op, variables }) => checksOf(op, variables));
  const found = checks.length ? await lookItems([...new Set(checks.map((c) => c.id))]) : new Map();
  for (const [n, { op, variables }] of list.entries()) {
    for (const c of checksOf(op, variables)) {
      const it = found.get(c.id);
      const gone = !it || it.state === "deleted";
      if (gone && WRITE_OPS[op].skipGone) continue; // already deleted by someone else: nothing to do
      if (gone) return json(409, { error: `Item ${c.id} no longer exists in Monday. Refresh and try again.`, op: n });
      if (!c.boards.includes(String(it.board?.id))) return json(403, { error: `Item ${c.id} is not on an allowed board for ${op}.`, op: n });
    }
  }
  const valueOf = (id, columnId) => found.get(String(id))?.column_values?.find((c) => c.id === columnId)?.value;

  // Who saved, added by the server; items already deleted are left out.
  const prepare = ({ op, variables }) => {
    const def = WRITE_OPS[op];
    if (!def.batch) return { op, variables };
    let entries = variables.entries.map((e) => ({ ...e }));
    if (op === "createShipmentLines") entries = entries.map((e) => ({ ...e, v: addColumn(e.v, NS.subOwner, peopleWith(null, user.userId)) }));
    if (op === "updateShipmentLines") entries = entries.map((e) => ({ ...e, v: addColumn(e.v, NS.subOwner, peopleWith(valueOf(e.i, NS.subOwner), user.userId)) }));
    if (op === "linkLines") entries = entries.map((e) => (e.target === "line" ? { ...e, v: addColumn(e.v, LINE_PEOPLE_COLUMN, peopleWith(valueOf(e.i, LINE_PEOPLE_COLUMN), user.userId)) } : e));
    if (def.skipGone) entries = entries.filter((e) => found.get(String(e.i)) && found.get(String(e.i)).state !== "deleted");
    return entries.length ? { op, variables: { ...variables, entries } } : null; // nothing left to do
  };
  const touched = [...new Set(list.flatMap(({ op }) => PARTS_OF_OP[op] || ["orders", "ledger", "shipments", "containers"]))];

  if (!many) {
    const ready = prepare(list[0]);
    if (!ready) return json(200, { data: {} });
    try {
      const body = await mondayWrite(WRITE_OPS[ready.op].build(ready.variables));
      await invalidateParts(touched);
      return json(200, body);
    } catch (error) {
      return json(502, { error: `Could not reach monday.com: ${error?.message || error}` });
    }
  }

  // Steps, one after the other; stop at the first one with an error (what follows depends on it).
  const data = steps.map((st) => st.map(() => ({})));
  try {
    for (const [i, st] of steps.entries()) {
      const ready = st.map(prepare);
      const send = ready.filter(Boolean);
      if (!send.length) continue;
      const out = await runStep(send);
      let k = 0;
      ready.forEach((r, j) => { if (r) data[i][j] = out.data[k++]; });
      if (out.errors.length) {
        await invalidateParts(touched);
        return json(200, { data, errors: out.errors, step: i });
      }
    }
    // Every step was written: the records they changed, read again, go into the cache and back to the browser.
    const t = readTargets(list, found);
    let read = null;
    try {
      read = { ...(await mondayRead.readBack({ lines: [...new Set([...t.lines, ...extraLines(payload.read)])], ledger: t.ledger, shipments: t.shipments })), transit: t.transit };
    } catch (e) {
      console.error("[monday-write] read back failed: the parts are read again on the next load", e);
    }
    // Without the read: every part touched is dropped, as before. With it: the parts of the records read are patched,
    // and only what couldn't be read back is dropped.
    const patch = read ? Object.entries(PATCHED).filter(([k, n]) => read[k].length && !t.blind.includes(n)).map(([, n]) => n) : [];
    const [cache] = await Promise.all([patchCachedParts(patch, (parts) => readIntoParts(parts, read)), invalidateParts(read ? t.blind : touched)]);
    return json(200, { data, read, cache: { ...cache, dropped: [...cache.dropped, ...(read ? t.blind : touched)] } }); // cache: to check it (Network tab)
  } catch (error) {
    await invalidateParts(touched).catch(() => {});
    return json(502, { error: `Could not reach monday.com: ${error?.message || error}` });
  }
});

export function GET() {
  return json(405, { error: "Use POST." });
}
