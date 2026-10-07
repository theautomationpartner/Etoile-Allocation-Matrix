// One-off setup of the monday columns and labels used by the review flow (October 2026):
//   · Wholesale subitems: "Last Fulfilled Processed" (numbers) — the US Qty Fulfilled already reviewed
//   · Ledger subitems:    "Arrival Status" (status, 6 labels) — where the units of that source are
//   · Ledger items:       Status Allocation gets Allocated · Partially Allocated · Over Allocated
//
//   node scripts/setup-review.mjs              dry run: shows what is missing
//   node scripts/setup-review.mjs --apply      adds what is missing (idempotent; never removes anything)
//   node scripts/setup-review.mjs --finalize   removes the old Status Allocation labels, only when no
//                                              Ledger item uses them any more (after the merge to main)
import { readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const FINALIZE = process.argv.includes("--finalize");
const token = readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/MONDAY_TOKEN=(.*)/)?.[1]?.trim();

const WHOLESALE_SUB = "18402982973";
const LEDGER = "18430965833";
const LEDGER_SUB = "18430967307";
const STATUS_ALLOCATION = "color_mm76q1fj";

export const ARRIVAL_LABELS = [
  { label: "PO - Pending", color: "purple" },
  { label: "PO - Arrived", color: "dark_purple" },
  { label: "In-Transit - Pending", color: "bright_blue" },
  { label: "In-Transit - Arrived", color: "chili_blue" },
  { label: "Warehouse - Pending", color: "egg_yolk" },
  { label: "Warehouse - Arrived", color: "done_green" },
];
const NEW_STATUS = [
  { label: "Allocated", color: "grass_green" },
  { label: "Partially Allocated", color: "peach" },
  { label: "Over Allocated", color: "stuck_red" },
];
const KEEP_STATUS = ["Allocated", "Partially Allocated", "Over Allocated", "Released"];

// monday color index → StatusColumnColors name (needed to send the existing labels back unchanged)
const COLOR_NAME = {
  0: "working_orange", 1: "done_green", 2: "stuck_red", 3: "dark_blue", 4: "purple", 5: "explosive", 6: "grass_green", 7: "bright_blue",
  8: "saladish", 9: "egg_yolk", 10: "blackish", 11: "dark_red", 12: "sofia_pink", 13: "lipstick", 14: "dark_purple", 15: "bright_green",
  16: "chili_blue", 17: "american_gray", 18: "brown", 19: "dark_orange", 101: "sunset", 102: "bubble", 103: "peach", 104: "berry", 105: "winter",
  106: "river", 107: "navy", 108: "aquamarine", 109: "indigo", 110: "dark_indigo",
};

async function gql(query, variables = {}) {
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token, "API-Version": "2025-10" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors?.length) throw new Error(JSON.stringify(body.errors));
  return body.data;
}
const columnsOf = async (b) => (await gql(`query($b:[ID!]){ boards(ids:$b){ columns { id title type revision settings } } }`, { b: [b] })).boards[0].columns;

async function setStatusLabels(board, col, labels) {
  await gql(`mutation($b:ID!,$i:String!,$r:String!,$s:UpdateStatusColumnSettingsInput){ update_status_column(board_id:$b, id:$i, revision:$r, settings:$s){ id } }`,
    { b: board, i: col.id, r: col.revision, s: { labels } });
}
const existing = (col) => (col.settings?.labels || []).map((l) => ({ id: l.id, label: l.label, index: l.index, color: COLOR_NAME[l.color] || "explosive", is_done: l.is_done, is_deactivated: l.is_deactivated }));

console.log(`${FINALIZE ? "FINALIZE" : APPLY ? "APPLY" : "DRY RUN"}`);

// 1 — Wholesale subitems: Last Fulfilled Processed
{
  const cols = await columnsOf(WHOLESALE_SUB);
  const found = cols.find((c) => c.title === "Last Fulfilled Processed");
  if (found) console.log(`✓ Wholesale subitems · Last Fulfilled Processed (${found.id})`);
  else if (!APPLY) console.log("+ Wholesale subitems · Last Fulfilled Processed [numbers] would be created");
  else {
    const d = await gql(`mutation($b:ID!){ create_column(board_id:$b, title:"Last Fulfilled Processed", column_type:numbers, after_column_id:"numeric_mm19gkqq", description:"US Qty Fulfilled already reviewed by the Allocation Matrix (written by the app)"){ id } }`, { b: WHOLESALE_SUB });
    console.log(`+ Wholesale subitems · Last Fulfilled Processed created (${d.create_column.id})`);
  }
}

// 2 — Ledger subitems: Arrival Status
{
  let col = (await columnsOf(LEDGER_SUB)).find((c) => c.title === "Arrival Status");
  if (!col && !APPLY) console.log("+ Ledger subitems · Arrival Status [status, 6 labels] would be created");
  if (!col && APPLY) {
    const d = await gql(`mutation($b:ID!){ create_column(board_id:$b, title:"Arrival Status", column_type:status, description:"Where the units of this source are (written by the Allocation Matrix)"){ id } }`, { b: LEDGER_SUB });
    col = (await columnsOf(LEDGER_SUB)).find((c) => c.id === d.create_column.id);
    console.log(`+ Ledger subitems · Arrival Status created (${col.id})`);
  }
  if (col) {
    const have = new Set((col.settings?.labels || []).map((l) => l.label));
    const missing = ARRIVAL_LABELS.filter((l) => !have.has(l.label));
    if (!missing.length) console.log(`✓ Ledger subitems · Arrival Status (${col.id}) has its 6 labels`);
    else if (!APPLY) console.log(`+ Arrival Status labels would be added: ${missing.map((l) => l.label).join(", ")}`);
    else {
      // A new status column comes with monday's default labels: they are replaced by ours (nothing uses them yet).
      const used = await gql(`query($b:[ID!]){ boards(ids:$b){ items_page(limit:1, query_params:{rules:[{column_id:"${col.id}", compare_value:[], operator:is_not_empty}]}){ items { id } } } }`, { b: [LEDGER_SUB] });
      if (used.boards[0].items_page.items.length) throw new Error("Arrival Status already has values: not replacing its labels.");
      await setStatusLabels(LEDGER_SUB, col, ARRIVAL_LABELS.map((l, i) => ({ label: l.label, color: l.color, index: i })));
      console.log(`+ Arrival Status labels set: ${ARRIVAL_LABELS.map((l) => l.label).join(" · ")}`);
    }
  }
}

// 3 — Ledger items: Status Allocation by quantities
{
  const col = (await columnsOf(LEDGER)).find((c) => c.id === STATUS_ALLOCATION);
  const labels = existing(col);
  const missing = NEW_STATUS.filter((n) => !labels.some((l) => l.label === n.label));
  if (!missing.length) console.log(`✓ Status Allocation has ${NEW_STATUS.map((l) => l.label).join(", ")}`);
  else if (!APPLY && !FINALIZE) console.log(`+ Status Allocation labels would be added: ${missing.map((l) => l.label).join(", ")}`);
  else if (APPLY) {
    let index = Math.max(...labels.map((l) => l.index)) + 1;
    await setStatusLabels(LEDGER, col, [...labels, ...missing.map((m) => ({ label: m.label, color: m.color, index: index++ }))]);
    console.log(`+ Status Allocation labels added: ${missing.map((l) => l.label).join(", ")} (the old ones stay until --finalize)`);
  }
  if (FINALIZE) {
    const old = labels.filter((l) => !KEEP_STATUS.includes(l.label));
    const d = await gql(`query($b:[ID!]){ boards(ids:$b){ items_page(limit:500){ items { id name column_values(ids:["${STATUS_ALLOCATION}"]){ text } } } } }`, { b: [LEDGER] });
    const using = d.boards[0].items_page.items.filter((it) => old.some((l) => l.label === it.column_values[0].text));
    if (using.length) throw new Error(`${using.length} Ledger items still use an old label (e.g. ${using.slice(0, 3).map((i) => i.name).join(", ")}). Run the daily check first.`);
    await setStatusLabels(LEDGER, col, labels.filter((l) => KEEP_STATUS.includes(l.label)));
    console.log(`- Status Allocation old labels removed: ${old.map((l) => l.label).join(", ")}`);
  }
}
