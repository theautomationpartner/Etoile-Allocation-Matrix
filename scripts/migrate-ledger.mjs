// One-off migration: Wholesale subitems with a confirmed allocation JSON (long_text_mm4kee9f)
// → one item per sale line in "🔗 Allocation Ledger - Monday Vibe" (18430965833), one subitem per
// source, and the Wholesale subitem linked to it through board_relation_mm7pqf7j.
//
//   node scripts/migrate-ledger.mjs            dry run: prints the plan, writes nothing
//   node scripts/migrate-ledger.mjs --apply    creates the items and links (asks nothing, run after review)
//
// Reads MONDAY_TOKEN from .env.local. Never modifies the Wholesale JSON column.

import { readFileSync, writeFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const token = readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/MONDAY_TOKEN=(.*)/)?.[1]?.trim();
if (!token) throw new Error("MONDAY_TOKEN missing in .env.local");

const B = { wholesale: "18402982970", ledger: "18430965833", ledgerSub: "18430967307" };
const OPEN_GROUPS = ["topics", "group_mm1730xq"];
const LEDGER_ACTIVE = "group_mm76c2zx";
const L = {
  key: "text_mm76g12x", sale: "board_relation_mm76cxt5", saleId: "text_mm76t66a", sku: "text_mm76wfw4", master: "board_relation_mm76mpxt",
  ordered: "numeric_mm766vqv", fulfilled: "numeric_mm76ebf5", outstanding: "numeric_mm76m58e", allocated: "numeric_mm76s5dm", status: "color_mm76q1fj",
  poRel: "board_relation_mm76vycr", poRefs: "text_mm76yede", poUsed: "text_mm76rwqv", poTotal: "text_mm76he3a", poUsedTotal: "numeric_mm761kw4",
  itRel: "board_relation_mm76detw", itRefs: "text_mm76fpnf", itUsed: "text_mm76q5gd", itTotal: "text_mm76bnnc", itUsedTotal: "numeric_mm76fpzk",
  whUsed: "numeric_mm76q8fe", earliestEta: "date_mm7654mr", json: "long_text_mm764vdq", updated: "date_mm766j65",
};
const LS = { type: "color_mm76ffrx", sourceId: "text_mm768syf", ref: "text_mm76r4a3", qty: "numeric_mm76x8g", total: "numeric_mm76pg3t", eta: "date_mm76m9nh", packingDone: "boolean_mm76nhw6" };
const WS_LINK = "board_relation_mm7pqf7j"; // on the Wholesale subitems board → Ledger

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
const cv = (it, id) => it.column_values?.find((c) => c.id === id)?.text ?? "";
const num = (t) => (Number.isFinite(parseFloat(t)) ? parseFloat(t) : 0);

// ── 1. Read Wholesale open orders and their subitems ──
async function wholesaleLines() {
  const fields = `id name group { id } subitems { id name column_values(ids:["text_mm251am5","numeric_mm17ttsn","numeric_mm19rrnv","numeric_mm19gkqq","long_text_mm4kee9f","${WS_LINK}"]) { id text ... on BoardRelationValue { linked_item_ids } } }`;
  const d = await gql(`query($b:[ID!]){ boards(ids:$b){ groups(ids:${JSON.stringify(OPEN_GROUPS)}){ items_page(limit:100){ cursor items { ${fields} } } } } }`, { b: [B.wholesale] });
  const out = [];
  for (const g of d.boards[0].groups) {
    if (g.items_page.cursor) throw new Error("More than 100 orders in a group: add pagination before running.");
    for (const it of g.items_page.items) {
      for (const s of it.subitems || []) {
        let entries = [];
        try { entries = JSON.parse(cv(s, "long_text_mm4kee9f") || "[]"); } catch { entries = null; }
        if (entries === null || !Array.isArray(entries) || !entries.some((e) => num(e.qty) > 0)) continue;
        const skuId = cv(s, "text_mm251am5");
        out.push({
          orderId: it.id, orderName: it.name, group: it.group.id, subitemId: s.id, subitemName: s.name,
          sku: (skuId.includes("|") ? skuId.split("|").pop() : skuId).trim(),
          ordered: num(cv(s, "numeric_mm17ttsn")), fulfilled: num(cv(s, "numeric_mm19rrnv")), outstanding: num(cv(s, "numeric_mm19gkqq")),
          entries: entries.filter((e) => num(e.qty) > 0),
          rawJson: cv(s, "long_text_mm4kee9f"),
          linkedLedger: s.column_values.find((c) => c.id === WS_LINK)?.linked_item_ids || [],
        });
      }
    }
  }
  return out;
}

// ── 2. Resolve every source item (PO, container, Master SKU) by id, archived ones included ──
async function resolveSources(lines) {
  const ids = [...new Set(lines.flatMap((l) => l.entries.map((e) => String(e.sourceId))).filter(Boolean))];
  const map = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const d = await gql(`query($i:[ID!]){ items(ids:$i, limit:50){ id name state board { id } group { id title }
      column_values(ids:["date4","color_mm1c7w2a","numeric_mm1765fq","text_mm17625z"]) { id text }
      subitems { id column_values(ids:["text_mm15xggt","numeric_mm3k24ed","text_mm1598d7","numeric_mm15va7p"]) { id text } } } }`, { i: ids.slice(i, i + 50) });
    for (const it of d.items) map.set(String(it.id), it);
  }
  return map;
}

// Containers and POs are sometimes deleted and re-imported with a new ID (e.g. a Draft packing list
// replaced by the Final one). An entry whose ID no longer exists, or points to an archived copy, is
// re-mapped to the active item with the same name that carries the SKU.
const normName = (s) => String(s || "").replace(/\s+/g, " ").trim().toUpperCase();
const INDEX_FIELDS = `id name state group { id title } column_values(ids:["date4","color_mm1c7w2a"]) { id text }
  subitems { id column_values(ids:["text_mm15xggt","numeric_mm3k24ed","text_mm1598d7","numeric_mm15va7p"]) { id text } }`;
async function boardIndex(boardId) {
  const out = [];
  let page = (await gql(`query($b:[ID!]){ boards(ids:$b){ items_page(limit:100){ cursor items { ${INDEX_FIELDS} } } } }`, { b: [boardId] })).boards[0].items_page;
  while (page) {
    out.push(...page.items);
    if (!page.cursor) break;
    page = (await gql(`query($c:String!){ next_items_page(cursor:$c, limit:100){ cursor items { ${INDEX_FIELDS} } } }`, { c: page.cursor })).next_items_page;
  }
  return out;
}
function remapByName(entry, sku, index) {
  const skuCol = entry.source === "po" ? "text_mm1598d7" : "text_mm15xggt";
  const rank = (it) => (it.group.id === "topics" ? 0 : 1);
  return index
    .filter((it) => normName(it.name) === normName(entry.ref) && it.subitems?.some((s) => cv(s, skuCol) === sku))
    .sort((a, b) => rank(a) - rank(b))[0] || null;
}

async function masterSkuIds(skus) {
  const d = await gql(`query($b:ID!,$v:[String]!){ items_page_by_column_values(board_id:$b, limit:500, columns:[{column_id:"text_mm17625z", column_values:$v}]){ items { id column_values(ids:["text_mm17625z","numeric_mm1765fq"]) { id text } } } }`, { b: "18402981515", v: skus });
  return new Map(d.items_page_by_column_values.items.map((it) => [cv(it, "text_mm17625z"), { id: it.id, usQty: num(cv(it, "numeric_mm1765fq")) }]));
}

const STATUS_BY_SET = {
  "": "Unallocated", warehouse: "Warehouse Stock", intransit: "In-Transit", po: "PO Pending",
  "intransit+po": "PO + In-Transit", "intransit+warehouse": "In-Transit + Warehouse", "po+warehouse": "PO + Warehouse",
  "intransit+po+warehouse": "PO + In-Transit + Warehouse",
};
const TYPE_LABEL = { warehouse: "Warehouse Stock", intransit: "In-Transit", po: "Purchase Order" };

function plan(line, sources, master) {
  const sku = line.sku;
  const parts = line.entries.map((e) => {
    const src = sources.get(String(e.sourceId));
    let total = null, eta = e.eta || "", packingDone = Boolean(e.packingDone), state = src?.state || "not found", ref = e.ref || src?.name || "";
    if (e.source === "po" && src) {
      total = src.subitems.filter((s) => cv(s, "text_mm1598d7") === sku).reduce((a, s) => a + num(cv(s, "numeric_mm15va7p")), 0);
      eta = eta || cv(src, "date4");
    } else if (e.source === "intransit" && src) {
      total = src.subitems.filter((s) => cv(s, "text_mm15xggt") === sku).reduce((a, s) => a + num(cv(s, "numeric_mm3k24ed")), 0);
      eta = eta || cv(src, "date4");
      packingDone = packingDone || cv(src, "color_mm1c7w2a") === "Done";
    } else if (e.source === "warehouse") {
      total = master.get(sku)?.usQty ?? null;
      ref = ref || "Warehouse Stock";
    }
    return { source: e.source, sourceId: String(e.sourceId), ref, qty: num(e.qty), total, eta: eta.slice(0, 10), packingDone, state, group: src?.group?.title || "", remapped: e.originalSourceId || null };
  });
  const of = (t) => parts.filter((p) => p.source === t);
  // Client format (2026-09-30): refs comma-separated (each ref once); quantities summed.
  const refs = (arr) => [...new Set(arr.map((p) => p.ref))].join(", ");
  const total = (arr, f) => String(arr.reduce((a, p) => a + (f(p) || 0), 0));
  const types = [...new Set(parts.map((p) => p.source))].sort().join("+");
  const etas = parts.filter((p) => p.source !== "warehouse" && p.eta).map((p) => p.eta).sort();
  const so = line.orderName.includes(" - ") ? line.orderName.split(" - ").pop().trim() : line.orderName;
  const po = of("po"), it = of("intransit"), wh = of("warehouse");
  const today = new Date().toISOString().slice(0, 10);
  const time = new Date().toISOString().slice(11, 19);

  const itemValues = {
    [L.key]: String(line.subitemId),
    [L.sale]: { item_ids: [Number(line.orderId)] },
    [L.saleId]: so,
    [L.sku]: sku,
    ...(master.get(sku) ? { [L.master]: { item_ids: [Number(master.get(sku).id)] } } : {}),
    [L.ordered]: String(line.ordered),
    [L.fulfilled]: String(line.fulfilled),
    [L.outstanding]: String(line.outstanding),
    [L.allocated]: String(parts.reduce((a, p) => a + p.qty, 0)),
    [L.status]: { label: STATUS_BY_SET[types] || "Unallocated" },
    [L.poRel]: { item_ids: [...new Set(po.filter((p) => p.state === "active").map((p) => Number(p.sourceId)))] },
    [L.poRefs]: refs(po),
    [L.poUsed]: total(po, (p) => p.qty),
    [L.poTotal]: total(po, (p) => p.total),
    [L.poUsedTotal]: String(po.reduce((a, p) => a + p.qty, 0)),
    [L.itRel]: { item_ids: [...new Set(it.filter((p) => p.state === "active").map((p) => Number(p.sourceId)))] },
    [L.itRefs]: refs(it),
    [L.itUsed]: total(it, (p) => p.qty),
    [L.itTotal]: total(it, (p) => p.total),
    [L.itUsedTotal]: String(it.reduce((a, p) => a + p.qty, 0)),
    [L.whUsed]: String(wh.reduce((a, p) => a + p.qty, 0)),
    ...(etas[0] ? { [L.earliestEta]: { date: etas[0] } } : {}),
    // Same JSON contract, with the current (re-mapped) source IDs.
    [L.json]: { text: JSON.stringify(line.entries.map(({ originalSourceId, ...e }) => e)) },
    [L.updated]: { date: today, time },
  };
  const subitems = parts.map((p) => ({
    name: p.ref || TYPE_LABEL[p.source],
    values: {
      [LS.type]: { label: TYPE_LABEL[p.source] },
      [LS.sourceId]: p.sourceId,
      [LS.ref]: p.ref,
      [LS.qty]: String(p.qty),
      ...(p.total !== null ? { [LS.total]: String(p.total) } : {}),
      ...(p.eta ? { [LS.eta]: { date: p.eta } } : {}),
      ...(p.source === "intransit" ? { [LS.packingDone]: { checked: p.packingDone ? "true" : "false" } } : {}),
    },
    info: p,
  }));
  return { name: `${so} | ${sku}`, itemValues, subitems, status: STATUS_BY_SET[types] };
}

// ── 3. Existing Ledger items (to avoid duplicates) ──
async function ledgerItems() {
  const d = await gql(`query($b:[ID!]){ boards(ids:$b){ items_page(limit:500){ items { id name group { id } column_values(ids:["${L.key}"]) { id text } } } } }`, { b: [B.ledger] });
  return d.boards[0].items_page.items.map((it) => ({ id: it.id, name: it.name, group: it.group.id, key: cv(it, L.key) }));
}

const lines = await wholesaleLines();
const [sources, master, existing, itIndex, poIndex] = await Promise.all([
  resolveSources(lines), masterSkuIds([...new Set(lines.map((l) => l.sku))]), ledgerItems(),
  boardIndex("18402604887"), boardIndex("18402622623"),
]);
const remaps = [];
for (const l of lines) {
  for (const e of l.entries) {
    if (e.source === "warehouse") continue;
    const src = sources.get(String(e.sourceId));
    if (src && src.state === "active") continue;
    const hit = remapByName(e, l.sku, e.source === "po" ? poIndex : itIndex);
    if (!hit) continue;
    remaps.push(`${l.orderName.split(" - ")[0]} ${l.sku}: ${e.ref} ${e.sourceId} (${src ? src.state : "deleted"}) -> ${hit.id} [${hit.group.title}]`);
    e.originalSourceId = String(e.sourceId);
    e.sourceId = hit.id;
    sources.set(String(hit.id), hit);
  }
}
const byKey = new Map(existing.map((e) => [e.key, e]));
const plans = lines.map((l) => ({ line: l, plan: plan(l, sources, master), existing: byKey.get(String(l.subitemId)) }));

// ── Report ──
let report = `LEDGER MIGRATION — ${APPLY ? "APPLY" : "DRY RUN"} — ${new Date().toISOString()}\n`;
report += `Wholesale subitems with a confirmed JSON (groups Orders + Pending): ${lines.length}\n`;
report += `Ledger items already on the board: ${existing.length}${existing.length ? " → " + existing.map((e) => `${e.name} (key ${e.key})`).join("; ") : ""}\n\n`;
for (const { line, plan: p, existing: ex } of plans) {
  report += `■ ${p.name}   [${line.orderName} · subitem ${line.subitemId}]  ordered ${line.ordered} · fulfilled ${line.fulfilled} · outstanding ${line.outstanding} → Status "${p.status}"${ex ? `   ⚠ key already used by ledger item ${ex.id} (${ex.name})` : ""}${line.linkedLedger.length ? `   ⚠ already linked to ${line.linkedLedger.join(",")}` : ""}\n`;
  for (const s of p.subitems) {
    const i = s.info;
    report += `     └ ${TYPE_LABEL[i.source].padEnd(15)} ${i.ref.padEnd(28)} qty ${String(i.qty).padStart(5)} / total ${String(i.total ?? "?").padStart(5)}  ETA ${i.eta || "—"}${i.source === "intransit" ? `  packing done: ${i.packingDone}` : ""}  [source item ${i.state}${i.group ? " · " + i.group : ""}${i.remapped ? " · remapped from " + i.remapped : ""}]\n`;
  }
}
const stateCount = {};
for (const { plan: p } of plans) for (const s of p.subitems) stateCount[s.info.state] = (stateCount[s.info.state] || 0) + 1;
report += `\nSource items by state (after re-mapping): ${JSON.stringify(stateCount)}\n`;
report += `Re-mapped by name (${remaps.length}):\n  ${remaps.join("\n  ")}\n`;
report += `Would create: ${plans.length} ledger items, ${plans.reduce((a, x) => a + x.plan.subitems.length, 0)} subitems, ${plans.length} links on ${WS_LINK}.\n`;
console.log(report);
writeFileSync(new URL(`./migrate-ledger-${APPLY ? "apply" : "dryrun"}.log`, import.meta.url), report);

if (!APPLY) process.exit(0);

// The test item created by hand ("SO-00871 | EC0390") holds the Allocation Key of EIVR117 · EC0415:
// the client asked to delete it so the migration creates the correct item (goes to monday's trash).
const TEST_ITEM = existing.find((e) => e.name === "SO-00871 | EC0390");
if (TEST_ITEM) {
  await gql(`mutation($i:ID!){ delete_item(item_id:$i){ id } }`, { i: TEST_ITEM.id });
  for (const x of plans) if (x.existing?.id === TEST_ITEM.id) x.existing = null;
  console.log(`deleted test item ${TEST_ITEM.id} (${TEST_ITEM.name})`);
}

// ── 4. Apply ──
for (const { line, plan: p, existing: ex } of plans) {
  if (ex || line.linkedLedger.length) {
    console.log(`skip ${p.name}: already in the Ledger`);
    continue;
  }
  const created = await gql(`mutation($b:ID!,$g:String!,$n:String!,$v:JSON!){ create_item(board_id:$b, group_id:$g, item_name:$n, column_values:$v, create_labels_if_missing:false){ id } }`,
    { b: B.ledger, g: LEDGER_ACTIVE, n: p.name, v: JSON.stringify(p.itemValues) });
  const ledgerId = created.create_item.id;
  for (const s of p.subitems) {
    await gql(`mutation($p:ID!,$n:String!,$v:JSON!){ create_subitem(parent_item_id:$p, item_name:$n, column_values:$v, create_labels_if_missing:false){ id } }`,
      { p: ledgerId, n: s.name, v: JSON.stringify(s.values) });
  }
  await gql(`mutation($b:ID!,$i:ID!,$v:JSON!){ change_multiple_column_values(board_id:$b, item_id:$i, column_values:$v){ id } }`,
    { b: "18402982973", i: line.subitemId, v: JSON.stringify({ [WS_LINK]: { item_ids: [Number(ledgerId)] } }) });
  console.log(`✓ ${p.name} → ledger item ${ledgerId} (${p.subitems.length} subitems), linked to subitem ${line.subitemId}`);
}
