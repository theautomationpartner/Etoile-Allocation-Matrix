// One-off setup of "🔗 New Shipments - Monday Vibe" (18433404829) for step 4 (Shipments, PDF §16).
//   node scripts/setup-new-shipments.mjs           dry run: shows what is missing
//   node scripts/setup-new-shipments.mjs --apply   creates the missing columns (idempotent, by title)
// Item = one shipment of a wholesale order · Subitem = one SKU line of that shipment.

import { readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const token = readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/MONDAY_TOKEN=(.*)/)?.[1]?.trim();
const BOARD = "18433404829";

const ITEM_COLUMNS = [
  { title: "Wholesale Order", type: "board_relation", defaults: { boardIds: [18402982970] } },
  { title: "Shipment Name", type: "text" },
  { title: "Units", type: "numbers" },
  { title: "Order To Ship", type: "numbers" },
  { title: "Last Saved", type: "date" },
];
const SUB_COLUMNS = [
  { title: "SKU", type: "text" },
  { title: "Qty To Ship", type: "numbers" },
  { title: "Allocated", type: "numbers" },
  { title: "Remaining To Ship", type: "numbers" },
  { title: "Wholesale Line", type: "text" },
  { title: "Source Split", type: "text" },
];

async function gql(query, variables = {}) {
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors?.length) throw new Error(JSON.stringify(body.errors));
  return body.data;
}
const columnsOf = async (id) => (await gql(`query($b:[ID!]){ boards(ids:$b){ columns { id title type settings_str } } }`, { b: [id] })).boards[0].columns;

async function ensureColumns(boardId, wanted) {
  const have = await columnsOf(boardId);
  const out = {};
  for (const w of wanted) {
    const found = have.find((c) => c.title === w.title);
    if (found) { out[w.title] = found.id; console.log(`  ✓ ${w.title} (${found.id})`); continue; }
    if (!APPLY) { console.log(`  + ${w.title} [${w.type}] would be created`); continue; }
    const d = await gql(`mutation($b:ID!,$t:String!,$ty:ColumnType!,$d:JSON){ create_column(board_id:$b, title:$t, column_type:$ty, defaults:$d){ id } }`,
      { b: boardId, t: w.title, ty: w.type, d: w.defaults ? JSON.stringify(w.defaults) : null });
    out[w.title] = d.create_column.id;
    console.log(`  + ${w.title} created (${d.create_column.id})`);
  }
  return out;
}

console.log(`${APPLY ? "APPLY" : "DRY RUN"} — New Shipments board ${BOARD}`);
const cols = await columnsOf(BOARD);
const date4 = cols.find((c) => c.id === "date4");
if (date4 && date4.title !== "Ship Date") {
  if (APPLY) await gql(`mutation{ change_column_title(board_id:${BOARD}, column_id:"date4", title:"Ship Date"){ id } }`);
  console.log(`  ${APPLY ? "~" : "~ would"} rename column date4 "${date4.title}" → "Ship Date"`);
}
console.log("Item columns:");
const itemIds = await ensureColumns(BOARD, ITEM_COLUMNS);

// The subitems board only exists once a subitem is created: create one on a temporary item, then remove it.
let subBoard = cols.find((c) => c.type === "subtasks") ? JSON.parse(cols.find((c) => c.type === "subtasks").settings_str).boardIds[0] : null;
if (!subBoard && APPLY) {
  const tmp = (await gql(`mutation{ create_item(board_id:${BOARD}, item_name:"setup (temporary)"){ id } }`)).create_item.id;
  const sub = (await gql(`mutation($p:ID!){ create_subitem(parent_item_id:$p, item_name:"setup"){ id board { id } } }`, { p: tmp })).create_subitem;
  subBoard = sub.board.id;
  await gql(`mutation($i:ID!){ delete_item(item_id:$i){ id } }`, { i: tmp });
  console.log(`  + subitems board created (${subBoard}); temporary item removed`);
}
console.log(`Subitem columns (board ${subBoard || "not created yet"}):`);
const subIds = subBoard ? await ensureColumns(String(subBoard), SUB_COLUMNS) : (SUB_COLUMNS.forEach((c) => console.log(`  + ${c.title} [${c.type}] would be created`)), {});
console.log("\nIDs:", JSON.stringify({ subBoard, item: { ...itemIds, "Ship Date": "date4" }, sub: subIds }, null, 1));
