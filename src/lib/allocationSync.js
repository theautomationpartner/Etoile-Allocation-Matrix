// Step 3 — saving the allocation of one sale line to 🔗 Allocation Ledger - Monday Vibe (PDF §10, §14).
// write(op, variables) runs one operation of mondayWrites.js; api is createMondayApi(...).
//
//   1. Concurrency (§10): the Ledger is read again and the caps are checked with those figures.
//   2. The line's Ledger item (linked from the Wholesale subitem, or found by Allocation Key) is rewritten:
//      its subitems are replaced and its columns updated. Without one, an item is created in Active and
//      linked from the Wholesale subitem (board_relation_mm7pqf7j).
//   3. All zero: the item keeps no subitems, Status "Released", and moves to the Released group.
//      Allocating that line again moves it back to Active. An item in any other group (e.g. Fulfilled)
//      is rewritten where it is and stays linked to its line, as the Allocation Queue does.
//   4. Review (2026-10-07): the Wholesale subitem's "Last Fulfilled Processed" takes the current US Qty Fulfilled
//      (what Cin7 shipped is reviewed), and the container lines used get their In-Transit Status.
// Order of writes: old subitems out, new subitems in, then the columns (the JSON copy last), so a failure
// half-way never shows more units than were confirmed.
//
// Speed (2026-10-13): Allocate used to read the whole Ledger, look for the line's item, then delete every source
// record and create them again, one request per write (7–15 s; monday takes ~2.3 s per delete, ~1.4 s per create).
// Now it reads only the Ledger records of the lines of the SKU being allocated (the only ones a source's free units
// depend on) together with the line's item; a source record that stays is rewritten in place (~0.7 s); and every
// write goes in ONE request as steps (runSteps), whose changes monday gets at the same time. A line without a
// Ledger item needs one more request (the item must exist before its subitems).
//
// Read back (2026-10-14): the Ledger records read before writing and the records monday has right after the write
// (the line's Ledger item and Wholesale subitem, read again by the server in the same request) come back as `read`:
// [reads for readIntoParts], so the app replaces just those records (useMatrixData applyRead) and every screen shows
// the new quantities at once. read is null when the write went one operation at a time or the read failed.
import { buildModel } from "./engine.js";
import { ledgerItemOf, ledgerReadOf, withLedger, withLedgerFor } from "./monday.js";
import { BASELINE, LEDGER, TRANSIT_LINES, batchIds, chunks, runSteps } from "./mondayWrites.js";
import { editorFor, entriesFrom, ledgerRecord, releasePlan } from "./allocation.js";
import { arrivalIndex, transitLineLabel } from "./arrival.js";
import { fmt } from "./format.js";

export class AllocationConflict extends Error {}

// The data with the Ledger read again, and the Ledger item of the line: only the SKU's records when the api can
// (loadLedgerFor), else the whole Ledger and a separate lookup. before: those records as a read (loadLedgerFor only).
async function freshFor(api, data, lineId) {
  const line = data.orders.flatMap((o) => o.lines).find((l) => String(l.id) === String(lineId));
  if (line && typeof api.loadLedgerFor === "function") {
    const lines = data.orders.flatMap((o) => o.lines).filter((l) => l.sku === line.sku);
    const { ledger, items } = await api.loadLedgerFor(lines.map((l) => ({ id: l.id, ledgerLinkId: l.ledgerLinkId })));
    return { fresh: withLedgerFor(data, ledger, line.sku), item: ledgerItemOf(items, lineId, line.ledgerLinkId), before: ledgerReadOf(items) };
  }
  const [ledger, item] = await Promise.all([api.loadLedger(), line ? api.findLedgerItem(lineId, line.ledgerLinkId) : null]);
  return { fresh: withLedger(data, ledger), item: line ? item : undefined, before: null };
}
// The reads to apply after a write: the records read before it, then what monday has after it (null if either is missing).
const readsOf = (before, after) => (before && after ? [before, ...after] : null);

// values: { rowId: qty }. Returns { data, entries, allocated, read } — data is the matrix data with the fresh Ledger
// and this line's new entries (the caller keeps its loadedAt); read: see above. A conflict carries fresh and read too.
export async function saveAllocation(write, api, { data, lineId, values }) {
  const { fresh, item, before } = await freshFor(api, data, lineId);
  return saveWith(write, api, fresh, lineId, values, item, before);
}

// Review — "Release": the extra units of a line go back to their sources (releasePlan), with the figures read
// just now. Returns what saveAllocation returns, plus plan.
export async function releaseLine(write, api, { data, lineId }) {
  const { fresh, item, before } = await freshFor(api, data, lineId);
  const model = buildModel(fresh);
  const line = model.lines.find((l) => String(l.lineId) === String(lineId)) || model.heldLines.find((l) => String(l.lineId) === String(lineId));
  const plan = line && releasePlan(line);
  if (!plan) {
    const err = new AllocationConflict("This line has nothing extra to release any more. The figures were updated.");
    err.fresh = fresh;
    err.read = before && [before];
    throw err;
  }
  if (!line.held) return { ...(await saveWith(write, api, fresh, lineId, plan.values, item, before)), plan };

  // Fully shipped line (nothing left to ship): everything goes back; the record becomes Released.
  const rec = ledgerRecord({ order: line.order, raw: line.raw, sku: line.sku, entries: [], data: fresh });
  const fulfilled = Number(line.raw.fulfilled) || 0;
  let after = null;
  await writeLedgerLine(write, api, { lineId, linkId: line.raw.ledgerLinkId, rec, empty: true, item, after: [baselineOp(line.raw, lineId)], onRead: (r) => { after = r; } });
  const next = {
    ...fresh,
    orders: fresh.orders.map((o) => ({
      ...o,
      lines: o.lines.map((l) => (String(l.id) === String(lineId) ? { ...l, entries: [], ledgerItemId: null, lastProcessed: fulfilled, ledgerFulfilled: fulfilled } : l)),
    })),
  };
  return { data: next, entries: [], allocated: 0, plan, read: readsOf(before, after) };
}

async function saveWith(write, api, fresh, lineId, values, item, before = null) {
  // 1 — fresh confirmed entries of every line, and the caps with them.
  const model = buildModel(fresh);
  const ed = editorFor(model, fresh, lineId);
  if (!ed) throw new AllocationConflict("This line has nothing left to ship any more. Refresh to see the current figures.");
  const conflict = (message) => Object.assign(new AllocationConflict(message), { fresh, read: before && [before] });
  for (const r of ed.rows) {
    const v = values[r.id] || 0;
    if (v > r.max) throw conflict(`Only ${fmt(r.max)} units of ${ed.sku} are available in ${r.title} now: someone else allocated some since the figures were loaded. The editor shows the current figures — check them and click Allocate again.`);
  }
  for (const id of Object.keys(values)) {
    if ((values[id] || 0) > 0 && !ed.rows.some((r) => r.id === id)) throw conflict(`One of the sources of this line is no longer available. The editor shows the current figures — check them and click Allocate again.`);
  }
  const total = Object.values(values).reduce((a, b) => a + (b || 0), 0);
  if (total > ed.goal) throw new AllocationConflict(`This line has ${fmt(ed.goal)} units to ship now: the total can be ${fmt(ed.goal)} at most.`);

  const entries = entriesFrom(ed, values, fresh);
  const rec = ledgerRecord({ order: ed.order, raw: ed.raw, sku: ed.sku, entries, data: fresh });
  // 4 — US Qty Fulfilled reviewed, and the In-Transit Status of the container lines this line uses: sent with the
  // last request of the Ledger record.
  const fulfilled = Number(ed.raw.fulfilled) || 0;
  const statuses = transitUpdates(fresh, entries.filter((e) => e.source === "intransit").map((e) => ({ sourceId: e.sourceId, sku: ed.sku })));
  let after = null;
  const itemId = await writeLedgerLine(write, api, { lineId, linkId: ed.raw.ledgerLinkId, rec, empty: !entries.length, item,
    after: [baselineOp(ed.raw, lineId), ...transitOps(statuses)], onRead: (r) => { after = r; } });

  const label = new Map(statuses.map((s) => [s.id, s.label]));
  const next = {
    ...fresh,
    containers: statuses.length ? fresh.containers.map((c) => ({ ...c, lines: c.lines.map((l) => (label.has(String(l.id)) ? { ...l, status: label.get(String(l.id)) } : l)) })) : fresh.containers,
    orders: fresh.orders.map((o) => ({
      ...o,
      lines: o.lines.map((l) => (String(l.id) === String(lineId)
        ? { ...l, entries, ledgerLinkId: itemId || l.ledgerLinkId, ledgerItemId: entries.length ? itemId : null, lastProcessed: fulfilled, ledgerFulfilled: fulfilled }
        : l)),
    })),
  };
  return { data: next, entries, allocated: Math.min(total, ed.goal), read: readsOf(before, after) };
}

// The Wholesale subitem's Last Fulfilled Processed = its US Qty Fulfilled, when it changes (else null).
function baselineOp(raw, lineId) {
  const fulfilled = Number(raw.fulfilled) || 0;
  return raw.lastProcessed !== fulfilled
    ? { op: "linkLines", variables: { entries: [{ target: "baseline", i: String(lineId), v: JSON.stringify({ [BASELINE.col]: String(fulfilled) }) }] } }
    : null;
}

// Rewrites the Ledger record of one sale line (rec = ledgerRecord(...)). Returns the Ledger item id (or null).
// item: the line's Ledger item when the caller already has it (undefined → looked up here; null → none).
// after: more operations sent with the last step (Last Fulfilled Processed, In-Transit Status).
// Steps, so a failure half-way never shows more units than were confirmed:
//   1. what goes down: source records no longer used out, records kept with fewer units rewritten
//   2. what goes up: records kept with more units rewritten, new sources in
//   3. the item's columns, its group, the Wholesale link, after — only once every record exists
// A source record is kept when the new allocation uses the same source (item.subs tells what each one holds; without
// it, every record goes and the new ones are created). A new item is created first, in its own request.
// onRead(reads | null): the records monday has after the write — the line's Ledger item and its Wholesale subitem
// (always read again: its US Qty Fulfilled may have changed in Cin7 meanwhile). See runSteps.
export async function writeLedgerLine(write, api, { lineId, linkId, rec, empty, item, after = [], onRead }) {
  const readBack = { read: { lines: [String(lineId)] }, onRead };
  // 2 — the line's Ledger item, in any group.
  if (item === undefined) item = await api.findLedgerItem(lineId, linkId);
  let itemId = item?.id || null;
  const linkOp = (id) => (id && String(linkId || "") !== id
    ? { op: "linkLines", variables: { entries: [{ target: "ledgerLine", i: String(lineId), v: JSON.stringify({ [LEDGER.link.col]: { item_ids: [Number(id)] } }) }] } }
    : null); // the Wholesale subitem points to its Ledger item

  if (!itemId && empty) {
    await runSteps(write, [after], readBack);
    return null;
  }
  if (!itemId) {
    itemId = String((await write("createLedgerItem", { n: rec.name, v: JSON.stringify(rec.itemValues) })).create_item.id);
    const creates = createOps(itemId, rec.subitems);
    const res = await runSteps(write, [creates, [linkOp(itemId), ...after]], readBack);
    checkCreated(creates, res[0]);
    return itemId;
  }

  const plan = empty ? { remove: item.subitemIds || [], down: [], up: [], add: [] } : reusePlan(item, rec.subitems);
  const creates = createOps(itemId, plan.add);
  const last = [
    { op: "updateLedgerItem", variables: { i: itemId, v: JSON.stringify(rec.itemValues) } },
    empty && item.group === LEDGER.groups.active ? { op: "moveLedgerItem", variables: { i: itemId, g: LEDGER.groups.released } } : null,
    !empty && item.group === LEDGER.groups.released ? { op: "moveLedgerItem", variables: { i: itemId, g: LEDGER.groups.active } } : null,
    linkOp(itemId), ...after,
  ];
  const steps = [[...deleteOps(plan.remove), ...rewriteOps(plan.down)], [...rewriteOps(plan.up), ...creates], last];
  if (typeof write.many !== "function") {
    // One operation at a time: the last step only once the new records exist (as before).
    const res = await runSteps(write, steps.slice(0, 2));
    checkCreated(creates, res[1].slice(-creates.length || Infinity));
    await runSteps(write, [last], readBack);
  } else {
    // One request; the server stops before the columns if a record could not be written.
    const res = await runSteps(write, steps, readBack);
    checkCreated(creates, res[1].slice(-creates.length || Infinity));
  }
  return itemId;
}

// Which source records of the line stay (same source), and what each one becomes.
// → { remove: [subitem ids], down: [{ id, s }] (fewer or same units), up: [{ id, s }] (more units), add: [s] }
function reusePlan(item, subitems) {
  if (!item.subs) return { remove: item.subitemIds || [], down: [], up: [], add: subitems };
  const left = [...item.subs];
  const down = [], up = [], add = [];
  for (const s of subitems) {
    const k = left.findIndex((o) => o.source === s.source && o.sourceId === String(s.sourceId));
    if (k < 0) { add.push(s); continue; }
    const [o] = left.splice(k, 1);
    (s.qty <= o.qty ? down : up).push({ id: o.id, s });
  }
  return { remove: left.map((o) => o.id), down, up, add };
}

const deleteOps = (ids) => chunks(ids || []).map((part) => ({ op: "deleteLedgerSubitems", variables: { entries: part.map((i) => ({ i })) } }));
const createOps = (parentId, subitems) => chunks(subitems).map((part) => ({ op: "createLedgerSubitems", variables: { p: parentId, entries: part.map((s) => ({ n: s.name, v: JSON.stringify(s.values) })) } }));
// A kept record gets every column written: what the new allocation doesn't set (Total, ETA) is cleared.
const LS = LEDGER.subCol;
const rewriteOps = (list) => chunks(list).map((part) => ({ op: "rewriteLedgerSubitems", variables: { entries: part.map(({ id, s }) => ({ i: id, v: JSON.stringify({ name: s.name, [LS.total]: "", [LS.eta]: "", ...s.values }) })) } }));
const transitOps = (updates) => chunks(updates).map((part) => ({ op: "setTransitLines", variables: { entries: part.map((u) => ({ i: u.id, v: JSON.stringify({ [TRANSIT_LINES.col]: { label: u.label } }) })) } }));
function checkCreated(creates, results) {
  creates.forEach((c, k) => {
    if (batchIds(results[k], c.variables.entries.length).some((x) => !x)) throw new Error("Monday did not create every source record of this allocation. Click Allocate again.");
  });
}

// In-Transit Status of the lines of these containers for these SKUs, only where it changes:
// [{ id (In-Transit subitem), label }].
export function transitUpdates(data, used) {
  const ix = arrivalIndex(data.containers, data.pos);
  const byId = new Map((data.containers || []).map((c) => [String(c.id), c]));
  const out = new Map();
  for (const { sourceId, sku } of used) {
    const c = byId.get(String(sourceId));
    for (const l of c?.lines || []) {
      if (l.sku !== sku) continue;
      const label = transitLineLabel(c, l, ix);
      if (l.status !== label) out.set(String(l.id), label);
    }
  }
  return [...out].map(([id, label]) => ({ id, label }));
}

export async function writeTransitLines(write, updates) {
  await runSteps(write, [transitOps(updates)]);
}

export async function createSubitems(write, parentId, subitems) {
  const creates = createOps(parentId, subitems);
  checkCreated(creates, (await runSteps(write, [creates]))[0]);
}
