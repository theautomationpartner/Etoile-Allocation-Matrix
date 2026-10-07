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
import { buildModel } from "./engine.js";
import { withLedger } from "./monday.js";
import { BASELINE, LEDGER, TRANSIT_LINES, batchIds, chunks } from "./mondayWrites.js";
import { editorFor, entriesFrom, ledgerRecord, releasePlan } from "./allocation.js";
import { transitLineLabel } from "./arrival.js";
import { fmt } from "./format.js";

export class AllocationConflict extends Error {}

// values: { rowId: qty }. Returns { data, entries, allocated } — data is the matrix data with the fresh Ledger
// and this line's new entries (the caller keeps its loadedAt).
export async function saveAllocation(write, api, { data, lineId, values }) {
  const fresh = withLedger(data, await api.loadLedger());
  return saveWith(write, api, fresh, lineId, values);
}

// Review — "Release": the extra units of a line go back to their sources (releasePlan), with the figures read
// just now. Returns what saveAllocation returns, plus plan.
export async function releaseLine(write, api, { data, lineId }) {
  const fresh = withLedger(data, await api.loadLedger());
  const line = buildModel(fresh).lines.find((l) => String(l.lineId) === String(lineId));
  const plan = line && releasePlan(line);
  if (!plan) {
    const err = new AllocationConflict("This line has nothing extra to release any more. The figures were updated.");
    err.fresh = fresh;
    throw err;
  }
  return { ...(await saveWith(write, api, fresh, lineId, plan.values)), plan };
}

async function saveWith(write, api, fresh, lineId, values) {
  // 1 — fresh confirmed entries of every line, and the caps with them.
  const model = buildModel(fresh);
  const ed = editorFor(model, fresh, lineId);
  if (!ed) throw new AllocationConflict("This line has nothing left to ship any more. Refresh to see the current figures.");
  for (const r of ed.rows) {
    const v = values[r.id] || 0;
    if (v > r.max) {
      const err = new AllocationConflict(`Only ${fmt(r.max)} units of ${ed.sku} are available in ${r.title} now: someone else allocated some since the figures were loaded. The editor shows the current figures — check them and click Allocate again.`);
      err.fresh = fresh;
      throw err;
    }
  }
  for (const id of Object.keys(values)) {
    if ((values[id] || 0) > 0 && !ed.rows.some((r) => r.id === id)) {
      const err = new AllocationConflict(`One of the sources of this line is no longer available. The editor shows the current figures — check them and click Allocate again.`);
      err.fresh = fresh;
      throw err;
    }
  }
  const total = Object.values(values).reduce((a, b) => a + (b || 0), 0);
  if (total > ed.goal) throw new AllocationConflict(`This line has ${fmt(ed.goal)} units to ship now: the total can be ${fmt(ed.goal)} at most.`);

  const entries = entriesFrom(ed, values, fresh);
  const rec = ledgerRecord({ order: ed.order, raw: ed.raw, sku: ed.sku, entries, data: fresh });
  const itemId = await writeLedgerLine(write, api, { lineId, linkId: ed.raw.ledgerLinkId, rec, empty: !entries.length });

  // 4 — US Qty Fulfilled reviewed, and the In-Transit Status of the container lines this line uses.
  const fulfilled = Number(ed.raw.fulfilled) || 0;
  if (ed.raw.lastProcessed !== fulfilled) {
    await write("linkLines", { entries: [{ target: "baseline", i: String(lineId), v: JSON.stringify({ [BASELINE.col]: String(fulfilled) }) }] });
  }
  const statuses = transitUpdates(fresh, entries.filter((e) => e.source === "intransit").map((e) => ({ sourceId: e.sourceId, sku: ed.sku })));
  await writeTransitLines(write, statuses);

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
  return { data: next, entries, allocated: Math.min(total, ed.goal) };
}

// Rewrites the Ledger record of one sale line (rec = ledgerRecord(...)). Returns the Ledger item id (or null).
export async function writeLedgerLine(write, api, { lineId, linkId, rec, empty }) {
  // 2 — the line's Ledger item, in any group.
  const item = await api.findLedgerItem(lineId, linkId);
  let itemId = item?.id || null;

  if (empty) {
    if (itemId) {
      await deleteSubitems(write, item.subitemIds);
      await write("updateLedgerItem", { i: itemId, v: JSON.stringify(rec.itemValues) });
      if (item.group === LEDGER.groups.active) await write("moveLedgerItem", { i: itemId, g: LEDGER.groups.released });
    }
  } else if (itemId) {
    await deleteSubitems(write, item.subitemIds);
    await createSubitems(write, itemId, rec.subitems);
    await write("updateLedgerItem", { i: itemId, v: JSON.stringify(rec.itemValues) });
    if (item.group === LEDGER.groups.released) await write("moveLedgerItem", { i: itemId, g: LEDGER.groups.active });
  } else {
    itemId = String((await write("createLedgerItem", { n: rec.name, v: JSON.stringify(rec.itemValues) })).create_item.id);
    await createSubitems(write, itemId, rec.subitems);
  }
  // The Wholesale subitem points to its Ledger item.
  if (itemId && String(linkId || "") !== itemId) {
    await write("linkLines", { entries: [{ target: "ledgerLine", i: String(lineId), v: JSON.stringify({ [LEDGER.link.col]: { item_ids: [Number(itemId)] } }) }] });
  }
  return itemId;
}

// In-Transit Status of the lines of these containers for these SKUs, only where it changes:
// [{ id (In-Transit subitem), label }].
export function transitUpdates(data, used) {
  const poById = new Map((data.pos || []).map((p) => [String(p.id), p]));
  const byId = new Map((data.containers || []).map((c) => [String(c.id), c]));
  const out = new Map();
  for (const { sourceId, sku } of used) {
    const c = byId.get(String(sourceId));
    for (const l of c?.lines || []) {
      if (l.sku !== sku) continue;
      const label = transitLineLabel(c, l, poById);
      if (l.status !== label) out.set(String(l.id), label);
    }
  }
  return [...out].map(([id, label]) => ({ id, label }));
}

export async function writeTransitLines(write, updates) {
  for (const part of chunks(updates)) {
    await write("setTransitLines", { entries: part.map((u) => ({ i: u.id, v: JSON.stringify({ [TRANSIT_LINES.col]: { label: u.label } }) })) });
  }
}

async function deleteSubitems(write, ids) {
  for (const part of chunks(ids || [])) await write("deleteLedgerSubitems", { entries: part.map((i) => ({ i })) });
}

export async function createSubitems(write, parentId, subitems) {
  for (const part of chunks(subitems)) {
    const res = await write("createLedgerSubitems", { p: parentId, entries: part.map((s) => ({ n: s.name, v: JSON.stringify(s.values) })) });
    const ids = batchIds(res, part.length);
    if (ids.some((x) => !x)) throw new Error("Monday did not create every source record of this allocation. Click Allocate again.");
  }
}
