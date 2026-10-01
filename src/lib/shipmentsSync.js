// Step 4 — saving shipments to monday.com (board 🔗 New Shipments). write(op, variables) runs one
// operation of mondayWrites.js (fetchWrite locally; monday.api in Vibe).
//   item    = the shipment: order, name, ship date, units, order's To ship, last saved
//   subitem = one SKU line: SKU, qty to ship, allocated, remaining to ship, Wholesale line id, source split
// Then every sale line involved is connected to the shipments that carry it:
//   Wholesale subitem (board_relation_mm7pd15e) and Allocation Ledger item (board_relation_mm7p81dk).
import { NS, SHIPMENT_LINKS } from "./mondayWrites.js";

const now = () => {
  const d = new Date();
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 19) };
};

// ctx: { order: { id, number, toShip }, lineOf(sku) → { lineId, ledgerItemId, allocated, productName },
//        remaining(sku), splitText(sku) }
// If a write fails half-way, the error carries `partial` ({ mondayId, subIds }) with what already exists in
// monday, so a retry updates those items instead of creating duplicates.
export async function saveShipment(write, ship, ctx) {
  const done = { mondayId: ship.mondayId, subIds: { ...(ship.subIds || {}) } };
  try {
    return await saveSteps(write, ship, ctx, done);
  } catch (error) {
    error.partial = done;
    throw error;
  }
}

async function saveSteps(write, ship, ctx, done) {
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
  if (mondayId) {
    await write("updateShipment", { i: mondayId, v: JSON.stringify({ name: itemName, ...values }) });
  } else {
    mondayId = String((await write("createShipment", { n: itemName, v: JSON.stringify(values) })).create_item.id);
    done.mondayId = mondayId;
  }

  const subIds = {};
  for (const sku of ship.skus) {
    const line = ctx.lineOf(sku);
    const v = JSON.stringify({
      [sc.sku]: sku,
      [sc.qty]: String(ship.qty[sku] || 0),
      [sc.allocated]: String(line?.allocated || 0),
      [sc.remaining]: String(ctx.remaining(sku)),
      [sc.line]: String(line?.lineId || ""),
      [sc.split]: ctx.splitText(sku),
    });
    const existing = ship.subIds?.[sku];
    if (existing) {
      await write("updateShipmentLine", { i: existing, v });
      subIds[sku] = existing;
    } else {
      const name = `${sku} - ${line?.productName || sku}`;
      subIds[sku] = String((await write("createShipmentLine", { p: mondayId, n: name, v })).create_subitem.id);
      done.subIds[sku] = subIds[sku];
    }
  }
  // Rows removed from the shipment (§16.3 "Quitar una fila"): their subitems go too.
  for (const [sku, id] of Object.entries(ship.subIds || {})) {
    if (ship.skus.includes(sku)) continue;
    await write("deleteShipmentItem", { i: id });
    delete done.subIds[sku];
  }
  return { mondayId, subIds };
}

export async function deleteShipment(write, ship) {
  if (ship.mondayId) await write("deleteShipmentItem", { i: ship.mondayId }); // subitems are removed with it
}

// Connect each sale line of these SKUs to the saved shipments that carry units of it.
export async function linkLines(write, ships, skus, lineOf) {
  for (const sku of new Set(skus)) {
    const line = lineOf(sku);
    if (!line) continue;
    const ids = ships.filter((s) => s.mondayId && (s.qty[sku] || 0) > 0 && s.skus.includes(sku)).map((s) => Number(s.mondayId));
    await write("linkWholesaleLine", { i: line.lineId, v: JSON.stringify({ [SHIPMENT_LINKS.wholesaleSub.col]: { item_ids: ids } }) });
    if (line.ledgerItemId) await write("linkLedgerItem", { i: line.ledgerItemId, v: JSON.stringify({ [SHIPMENT_LINKS.ledger.col]: { item_ids: ids } }) });
  }
}
