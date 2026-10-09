// Deletes an In-Transit shipment (requirements "In-Transit" §8): starts the Make scenario that monday's
// "Delete In-Transit Item" button starts (5290661 — reverts Master SKU, marks the Importer file, removes the item),
// through the webhook in DELETE_SHIPMENT_WEBHOOK. Only for authenticated, whitelisted users (see _auth.js).
// The app never deletes anything itself: it checks the container and calls the webhook.
//   Checks (server side, on monday): the item is on 🚢 In-Transit Shipments, Location US, group In-Transit
//   Shipments (Items), Packing List = Draft (only Draft files can be undone, §8.1) and no deletion running.
//   Webhook body (JSON), monday-like so the scenario can read the item as from the button:
//     { event: { type: "delete_shipment", source: "etoile-allocation-matrix", boardId, pulseId, pulseName,
//       columnId: "button_mm3yn17e", userId }, itemId, itemName, boardId, requestedBy: { userId, name, email }, at }
// Env: DELETE_SHIPMENT_WEBHOOK (the scenario's webhook URL; without it the app says the action is not configured).

import { guarded, serverMonday } from "./_auth.js";
import { invalidateParts } from "./_cache.js";

const BOARD = "18402604887"; // 🚢 In-Transit Shipments
const ITEMS_GROUP = "topics"; // In-Transit Shipments (Items)
const COL = { location: "color_mm3bhhys", packingList: "color_mm1c7w2a", deletion: "color_mm3y67m8" };
const BUTTON = "button_mm3yn17e"; // Delete In-Transit Item

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export const POST = guarded(async (request, { user }) => {
  const url = process.env.DELETE_SHIPMENT_WEBHOOK;
  if (!url) return json(503, { error: "Deleting from the app is not configured yet (DELETE_SHIPMENT_WEBHOOK). Use the Delete In-Transit Item button in Monday." });
  let itemId;
  try {
    itemId = String(JSON.parse(await request.text())?.itemId || "");
  } catch {
    return json(400, { error: "Body must be JSON: { itemId }." });
  }
  if (!/^\d+$/.test(itemId)) return json(400, { error: "itemId must be a monday item id." });

  const d = await serverMonday(
    `query($i:[ID!]){ items(ids:$i){ id name state board { id } group { id } column_values(ids:["${COL.location}","${COL.packingList}","${COL.deletion}"]) { id text } } }`,
    { i: [itemId] },
  ).catch(() => null);
  const it = d?.items?.[0];
  const cv = (id) => it?.column_values.find((c) => c.id === id)?.text || "";
  if (!it || it.state !== "active" || String(it.board?.id) !== BOARD) return json(404, { error: "This shipment is no longer in Monday." });
  if (it.group?.id !== ITEMS_GROUP || cv(COL.location) !== "US") return json(409, { error: "Only US shipments in transit can be deleted from the app." });
  if (cv(COL.packingList) !== "Draft") return json(409, { error: `The packing list is ${cv(COL.packingList) || "not set"}. Only shipments created from a Draft file can be deleted.` });
  if (cv(COL.deletion)) return json(409, { error: `Monday is already deleting this shipment (${cv(COL.deletion)}).` });

  const body = {
    event: { type: "delete_shipment", source: "etoile-allocation-matrix", boardId: Number(BOARD), pulseId: Number(itemId), pulseName: it.name, columnId: BUTTON, userId: Number(user.userId) },
    itemId: Number(itemId), itemName: it.name, boardId: Number(BOARD),
    requestedBy: { userId: user.userId, name: user.name, email: user.email },
    at: new Date().toISOString(),
  };
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    console.error("[delete-shipment] webhook unreachable", e);
    return json(502, { error: "The deletion could not be started (the webhook did not answer). Nothing was deleted." });
  }
  if (!res.ok) {
    console.error(`[delete-shipment] webhook HTTP ${res.status}`);
    return json(502, { error: `The deletion could not be started (webhook HTTP ${res.status}). Nothing was deleted.` });
  }
  console.info(`[delete-shipment] ${it.name} (${itemId}) requested by ${user.name} (${user.userId})`);
  await invalidateParts(["containers", "imports", "warehouse"]); // monday's deletion changes them
  return json(200, { ok: true, itemId, itemName: it.name });
});
