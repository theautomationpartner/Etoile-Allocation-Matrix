// Step 4 — saving shipments to monday.com (board 🔗 New Shipments). write(op, variables) runs one
// operation of mondayWrites.js (fetchWrite locally; monday.api in Vibe).
//   item    = the shipment: order, name, ship date, units, order's To ship, last saved
//   subitem = one SKU line: SKU, qty to ship, allocated, remaining to ship, Wholesale line id, source split
// Then every sale line involved is connected to the shipments that carry it:
//   Wholesale subitem (board_relation_mm7pd15e) and Allocation Ledger item (board_relation_mm7p81dk).
// Line writes go in batches of up to 50 per request (create, update, delete and connect).
// Speed (2026-10-13): every write of a Save — the shipment, its lines and the links of the sale lines (after) — goes
// in ONE request as one step (runSteps): they don't depend on each other, so monday gets them at the same time. A new
// shipment needs one more request (it must exist before its lines).
import { NS, SHIPMENT_LINKS, batchIds, chunks, runSteps } from "./mondayWrites.js";

const now = () => {
  const d = new Date();
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 19) };
};

// ctx: { order: { id, number, toShip }, lineOf(sku) → { lineId, ledgerItemId, allocated, productName, fulfilled },
//        remaining(sku), splitText(sku) }
// If a write fails half-way, the error carries `partial` ({ mondayId, subIds }) with what already exists in
// monday, so a retry updates those items instead of creating duplicates.
// after(mondayId) → more operations sent with the last request (the links of the sale lines, linkOps).
export async function saveShipment(write, ship, ctx, { after } = {}) {
  const done = { mondayId: ship.mondayId, subIds: { ...(ship.subIds || {}) } };
  try {
    return await saveSteps(write, ship, ctx, done, after);
  } catch (error) {
    error.partial = done;
    throw error;
  }
}

async function saveSteps(write, ship, ctx, done, after) {
  const c = NS.col, sc = NS.subCol;
  const units = ship.skus.reduce((a, k) => a + (ship.qty[k] || 0), 0);
  const itemName = `${ctx.order.number} · ${ship.name}`;
  const values = {
    [c.order]: { item_ids: [Number(ctx.order.id)] },
    [c.name]: ship.name,
    [c.date]: ship.target ? { date: ship.target } : "",
    [c.units]: String(units),
    [c.orderToShip]: String(ctx.order.toShip),
    [c.saved]: now(),
  };

  let mondayId = ship.mondayId;
  const ops = [];
  if (mondayId) {
    ops.push({ op: "updateShipment", variables: { i: mondayId, v: JSON.stringify({ name: itemName, ...values }) } });
  } else {
    mondayId = String((await write("createShipment", { n: itemName, v: JSON.stringify(values) })).create_item.id);
    done.mondayId = mondayId;
  }

  // created: a new line also gets "Fulfilled at save" (the line's US Qty Fulfilled now). It is never rewritten, so the
  // units fulfilled after the line was created can be told apart (shipments.js attributeShipped).
  const lineValues = (sku, created) => {
    const line = ctx.lineOf(sku);
    return JSON.stringify({
      ...(created && Number.isFinite(line?.fulfilled) ? { [sc.fulfilledAtSave]: String(line.fulfilled) } : {}),
      [sc.sku]: sku,
      [sc.qty]: String(ship.qty[sku] || 0),
      [sc.allocated]: String(line?.allocated || 0),
      [sc.remaining]: String(ctx.remaining(sku)),
      [sc.line]: String(line?.lineId || ""),
      [sc.split]: ctx.splitText(sku),
    });
  };

  // Existing lines: batched updates.
  const toUpdate = ship.skus.filter((sku) => done.subIds[sku]);
  for (const part of chunks(toUpdate)) {
    ops.push({ op: "updateShipmentLines", variables: { entries: part.map((sku) => ({ i: done.subIds[sku], v: lineValues(sku) })) } });
  }
  // New lines: batched creates of up to 50.
  const toCreate = chunks(ship.skus.filter((sku) => !done.subIds[sku]));
  const firstCreate = ops.length;
  for (const part of toCreate) {
    ops.push({ op: "createShipmentLines", variables: { p: mondayId, entries: part.map((sku) => ({ n: `${sku} - ${ctx.lineOf(sku)?.productName || sku}`, v: lineValues(sku, true) })) } });
  }
  // Rows removed from the shipment (§16.3 "Quitar una fila"): their subitems go too.
  const removed = chunks(Object.keys(done.subIds).filter((sku) => !ship.skus.includes(sku)));
  for (const part of removed) ops.push({ op: "deleteShipmentItems", variables: { entries: part.map((sku) => ({ i: done.subIds[sku] })) } });

  const [results] = await runSteps(write, [[...ops, ...(after ? after(mondayId) : [])]]);
  toCreate.forEach((part, n) => {
    batchIds(results[firstCreate + n], part.length).forEach((id, k) => {
      if (!id) throw new Error(`Monday did not create the line for ${part[k]}.`);
      done.subIds[part[k]] = id;
    });
  });
  for (const part of removed) part.forEach((sku) => delete done.subIds[sku]);
  return { mondayId, subIds: { ...done.subIds } };
}

// after: more operations sent in the same request (the links of the sale lines left, linkOps).
export async function deleteShipment(write, ship, after = []) {
  await runSteps(write, [[ship.mondayId ? { op: "deleteShipmentItems", variables: { entries: [{ i: ship.mondayId }] } } : null, ...after]]); // its subitems go with it
}

// Connect each sale line of these SKUs to the saved shipments that carry units of it (batched) — as operations.
export function linkOps(ships, skus, lineOf) {
  const entries = [];
  for (const sku of new Set(skus)) {
    const line = lineOf(sku);
    if (!line) continue;
    const ids = ships.filter((s) => s.mondayId && (s.qty[sku] || 0) > 0 && s.skus.includes(sku)).map((s) => Number(s.mondayId));
    entries.push({ target: "line", i: line.lineId, v: JSON.stringify({ [SHIPMENT_LINKS.wholesaleSub.col]: { item_ids: ids } }) });
    if (line.ledgerItemId) entries.push({ target: "ledger", i: line.ledgerItemId, v: JSON.stringify({ [SHIPMENT_LINKS.ledger.col]: { item_ids: ids } }) });
  }
  return chunks(entries).map((part) => ({ op: "linkLines", variables: { entries: part } }));
}

export async function linkLines(write, ships, skus, lineOf) {
  await runSteps(write, [linkOps(ships, skus, lineOf)]);
}
