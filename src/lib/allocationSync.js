// Step 3 — saving the allocation of one sale line to 🔗 Allocation Ledger - Monday Vibe (PDF §10, §14).
// write(op, variables) runs one operation of mondayWrites.js; api is createMondayApi(...).
//
//   1. Concurrency (§10): the Ledger is read again and the caps are checked with those figures.
//   2. The line's Ledger item (linked from the Wholesale subitem, or found by Allocation Key) is rewritten:
//      its subitems are replaced and its columns updated. Without one, an item is created in Active and
//      linked from the Wholesale subitem (board_relation_mm7pqf7j).
//   3. All zero: the item keeps no subitems, Status "Released", and moves to the Released group.
//      Allocating that line again moves it back to Active.
// Order of writes: old subitems out, new subitems in, then the columns (the JSON copy last), so a failure
// half-way never shows more units than were confirmed.
import { buildModel } from "./engine.js";
import { withLedger } from "./monday.js";
import { LEDGER, batchIds, chunks } from "./mondayWrites.js";
import { editorFor, entriesFrom, ledgerRecord } from "./allocation.js";
import { fmt } from "./format.js";

export class AllocationConflict extends Error {}

// values: { rowId: qty }. Returns { data, entries, allocated } — data is the matrix data with the fresh Ledger
// and this line's new entries (the caller keeps its loadedAt).
export async function saveAllocation(write, api, { data, lineId, values }) {
  // 1 — fresh confirmed entries of every line, and the caps with them.
  const fresh = withLedger(data, await api.loadLedger());
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

  // 2 — the line's Ledger item, in any group.
  const item = await api.findLedgerItem(lineId, ed.raw.ledgerLinkId);
  if (item && item.group !== LEDGER.groups.active && item.group !== LEDGER.groups.released) {
    throw new Error("The Ledger item of this line is not in the Active or Released group. Check it in Monday before allocating.");
  }
  let itemId = item?.id || null;

  if (!entries.length) {
    if (itemId) {
      await deleteSubitems(write, item.subitemIds);
      await write("updateLedgerItem", { i: itemId, v: JSON.stringify(rec.itemValues) });
      if (item.group !== LEDGER.groups.released) await write("moveLedgerItem", { i: itemId, g: LEDGER.groups.released });
    }
  } else if (itemId) {
    await deleteSubitems(write, item.subitemIds);
    await createSubitems(write, itemId, rec.subitems);
    await write("updateLedgerItem", { i: itemId, v: JSON.stringify(rec.itemValues) });
    if (item.group !== LEDGER.groups.active) await write("moveLedgerItem", { i: itemId, g: LEDGER.groups.active });
  } else {
    itemId = String((await write("createLedgerItem", { n: rec.name, v: JSON.stringify(rec.itemValues) })).create_item.id);
    await createSubitems(write, itemId, rec.subitems);
  }
  // The Wholesale subitem points to its Ledger item.
  if (itemId && String(ed.raw.ledgerLinkId || "") !== itemId) {
    await write("linkLines", { entries: [{ target: "ledgerLine", i: String(lineId), v: JSON.stringify({ [LEDGER.link.col]: { item_ids: [Number(itemId)] } }) }] });
  }

  const next = {
    ...fresh,
    orders: fresh.orders.map((o) => ({
      ...o,
      lines: o.lines.map((l) => (String(l.id) === String(lineId)
        ? { ...l, entries, ledgerLinkId: itemId || l.ledgerLinkId, ledgerItemId: entries.length ? itemId : null }
        : l)),
    })),
  };
  return { data: next, entries, allocated: Math.min(total, ed.goal) };
}

async function deleteSubitems(write, ids) {
  for (const part of chunks(ids || [])) await write("deleteLedgerSubitems", { entries: part.map((i) => ({ i })) });
}

async function createSubitems(write, parentId, subitems) {
  for (const part of chunks(subitems)) {
    const res = await write("createLedgerSubitems", { p: parentId, entries: part.map((s) => ({ n: s.name, v: JSON.stringify(s.values) })) });
    const ids = batchIds(res, part.length);
    if (ids.some((x) => !x)) throw new Error("Monday did not create every source record of this allocation. Click Allocate again.");
  }
}
