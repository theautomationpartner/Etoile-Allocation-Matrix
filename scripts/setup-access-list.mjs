// One-off setup of the whitelist board "🔐 Allocation Matrix — Access List" (private, workspace ETOILE).
//   node scripts/setup-access-list.mjs           dry run
//   node scripts/setup-access-list.mjs --apply   creates the board (if missing), its columns and one item per user
// Every member of the monday account gets an item. Only ADMIN_USER_ID starts Active (Admin); everyone
// else starts Inactive (Member) until an admin activates them — nobody gets access by default.

import { readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const token = readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/MONDAY_TOKEN=(.*)/)?.[1]?.trim();
const BOARD_NAME = "🔐 Allocation Matrix — Access List";
const WORKSPACE_ID = 11725658; // ETOILE
const ADMIN_USER_ID = "100657040";

const COLUMNS = [
  { key: "status", title: "Status", type: "status", defaults: { labels: { 1: "Active", 2: "Inactive" } } },
  { key: "role", title: "Role", type: "status", defaults: { labels: { 0: "Member", 1: "Admin" } } },
  { key: "userId", title: "User ID", type: "text" },
  { key: "email", title: "Email", type: "text" },
  { key: "person", title: "Person", type: "people" },
  { key: "lastAccess", title: "Last Access", type: "date" },
  { key: "notes", title: "Notes", type: "text" },
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

console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${BOARD_NAME}`);
const found = (await gql(`query($w:[ID]){ boards(workspace_ids:$w, limit:500){ id name } }`, { w: [WORKSPACE_ID] })).boards.find((b) => b.name === BOARD_NAME);
let boardId = found?.id;
if (!boardId) {
  console.log(`  + board would be created (private, workspace ${WORKSPACE_ID})`);
  if (APPLY) boardId = (await gql(`mutation($n:String!,$w:ID!){ create_board(board_name:$n, board_kind:private, workspace_id:$w){ id } }`, { n: BOARD_NAME, w: WORKSPACE_ID })).create_board.id;
}
console.log(`  board: ${boardId || "(new)"}`);

const ids = {};
const have = boardId ? (await gql(`query($b:[ID!]){ boards(ids:$b){ columns { id title type } groups { id title } } }`, { b: [boardId] })).boards[0] : { columns: [], groups: [] };
for (const c of COLUMNS) {
  const hit = have.columns.find((x) => x.title === c.title && x.type === c.type);
  if (hit) { ids[c.key] = hit.id; console.log(`  ✓ ${c.title} (${hit.id})`); continue; }
  console.log(`  + ${c.title} [${c.type}]`);
  if (APPLY) ids[c.key] = (await gql(`mutation($b:ID!,$t:String!,$ty:ColumnType!,$d:JSON){ create_column(board_id:$b, title:$t, column_type:$ty, defaults:$d){ id } }`,
    { b: boardId, t: c.title, ty: c.type, d: c.defaults ? JSON.stringify(c.defaults) : null })).create_column.id;
}

// One group "Users" (rename the board's default group).
let groupId = have.groups[0]?.id;
if (APPLY && boardId) {
  const groups = (await gql(`query($b:[ID!]){ boards(ids:$b){ groups { id title } } }`, { b: [boardId] })).boards[0].groups;
  groupId = groups[0].id;
  if (groups[0].title !== "Users") await gql(`mutation($b:ID!,$g:String!){ update_group(board_id:$b, group_id:$g, group_attribute:title, new_value:"Users"){ id } }`, { b: boardId, g: groupId });
  // Remove the sample items monday adds to a new board.
  const items = (await gql(`query($b:[ID!]){ boards(ids:$b){ items_page(limit:100){ items { id name column_values { id text } } } } }`, { b: [boardId] })).boards[0].items_page.items;
  for (const it of items) if (!it.column_values.find((c) => c.id === ids.userId)?.text) await gql(`mutation($i:ID!){ delete_item(item_id:$i){ id } }`, { i: it.id });
}

const users = (await gql(`{ users(limit:500){ id name email is_guest enabled } }`)).users.filter((u) => !u.is_guest && u.enabled);
const existing = boardId && ids.userId
  ? new Set((await gql(`query($b:[ID!]){ boards(ids:$b){ items_page(limit:500){ items { column_values(ids:["${ids.userId}"]) { text } } } } }`, { b: [boardId] })).boards[0].items_page.items.map((i) => i.column_values[0]?.text))
  : new Set();
for (const u of users) {
  const admin = String(u.id) === ADMIN_USER_ID;
  if (existing.has(String(u.id))) { console.log(`  ✓ ${u.name} (${u.id}) already listed`); continue; }
  console.log(`  + ${u.name} (${u.id}) → ${admin ? "Active · Admin" : "Inactive · Member"}`);
  if (!APPLY) continue;
  const v = {
    [ids.status]: { label: admin ? "Active" : "Inactive" },
    [ids.role]: { label: admin ? "Admin" : "Member" },
    [ids.userId]: String(u.id),
    [ids.email]: u.email || "",
    [ids.person]: { personsAndTeams: [{ id: Number(u.id), kind: "person" }] },
  };
  await gql(`mutation($b:ID!,$g:String!,$n:String!,$v:JSON!){ create_item(board_id:$b, group_id:$g, item_name:$n, column_values:$v){ id } }`,
    { b: boardId, g: groupId, n: u.name, v: JSON.stringify(v) });
}
console.log("\nIDs:", JSON.stringify({ boardId, columns: ids }));
