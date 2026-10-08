// One-off cleanup (client decision, 2026-10-08): only the Wholesale group "Orders" is demand. The sales in
// "Pending" (group_mm1730xq) are old and obsolete; their allocation is decoupled:
//   · Ledger: their items move to a new group "Archived – Pending orders" (subitems and data untouched)
//   · Wholesale: their subitems lose the 🔗 Allocation Ledger connection (board_relation_mm7pqf7j)
// It also writes EtoileContextoApp/ARCHIVO-ventas-pending.md with what was decoupled and how to revert it.
//
//   node scripts/archive-pending.mjs           dry run: shows what it would do (and writes the md as a plan)
//   node scripts/archive-pending.mjs --apply   does it (idempotent)
import { readFileSync, writeFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const token = readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/MONDAY_TOKEN=(.*)/)?.[1]?.trim();
const B = { wholesale: "18402982970", wholesaleSub: "18402982973", ledger: "18430965833" };
const PENDING = "group_mm1730xq";
const ARCHIVE_TITLE = "Archived – Pending orders";
const LINK = "board_relation_mm7pqf7j";
const LC = { key: "text_mm76g12x", sale: "board_relation_mm76cxt5", sku: "text_mm76wfw4", allocated: "numeric_mm76s5dm", status: "color_mm76q1fj" };
const LS = { type: "color_mm76ffrx", ref: "text_mm76r4a3", qty: "numeric_mm76x8g" };
const SC = { skuId: "text_mm251am5", ordered: "numeric_mm17ttsn", fulfilled: "numeric_mm19rrnv", outstanding: "numeric_mm19gkqq" };

async function gql(query, variables = {}) {
  const res = await fetch("https://api.monday.com/v2", { method: "POST", headers: { "Content-Type": "application/json", Authorization: token }, body: JSON.stringify({ query, variables }) });
  const body = await res.json();
  if (body.errors?.length) throw new Error(JSON.stringify(body.errors));
  return body.data;
}
async function all(board, fields, group) {
  const sel = `cursor items { ${fields} }`;
  const d = await gql(group
    ? `query($b:[ID!]){ boards(ids:$b){ groups(ids:["${group}"]){ items_page(limit:100){ ${sel} } } } }`
    : `query($b:[ID!]){ boards(ids:$b){ items_page(limit:100){ ${sel} } } }`, { b: [board] });
  let page = group ? d.boards[0].groups[0]?.items_page : d.boards[0].items_page;
  const out = [];
  while (page) {
    out.push(...page.items);
    if (!page.cursor) break;
    page = (await gql(`query($c:String!){ next_items_page(cursor:$c, limit:100){ ${sel} } }`, { c: page.cursor })).next_items_page;
  }
  return out;
}
const cv = (it, id) => it.column_values.find((c) => c.id === id);
const num = (t) => (Number.isFinite(parseFloat(t)) ? parseFloat(t) : 0);
const fmt = (v) => Number(v).toLocaleString("en-US");

console.log(`${APPLY ? "APPLY" : "DRY RUN"} — archive the allocation of the Pending sales`);

// 1 — Pending sales and their lines
const sales = await all(B.wholesale, `id name subitems { id name column_values(ids:["${LINK}","${Object.values(SC).join('","')}"]) { id text ... on BoardRelationValue { linked_item_ids } } }`, PENDING);
const saleIds = new Set(sales.map((s) => String(s.id)));
const lines = sales.flatMap((s) => (s.subitems || []).map((l) => ({
  sale: s, id: String(l.id), name: l.name, sku: (cv(l, SC.skuId)?.text || "").split("|").pop().trim(),
  ordered: num(cv(l, SC.ordered)?.text), fulfilled: num(cv(l, SC.fulfilled)?.text), outstanding: num(cv(l, SC.outstanding)?.text),
  link: (cv(l, LINK)?.linked_item_ids || []).map(String),
})));
const lineIds = new Set(lines.map((l) => l.id));

// 2 — their Ledger items: connected to a Pending sale, linked from one of its lines, or keyed by one
const ledger = await all(B.ledger, `id name group { id title } column_values(ids:["${Object.values(LC).join('","')}"]) { id text ... on BoardRelationValue { linked_item_ids } }
  subitems { id name column_values(ids:["${Object.values(LS).join('","')}"]) { id text } }`);
const linked = new Set(lines.flatMap((l) => l.link));
const items = ledger.filter((it) => (cv(it, LC.sale)?.linked_item_ids || []).some((x) => saleIds.has(String(x)))
  || linked.has(String(it.id)) || lineIds.has((cv(it, LC.key)?.text || "").trim()));

// 3 — the archive group
const groups = (await gql(`query($b:[ID!]){ boards(ids:$b){ groups { id title } } }`, { b: [B.ledger] })).boards[0].groups;
let archive = groups.find((g) => g.title === ARCHIVE_TITLE);
if (!archive && APPLY) {
  archive = (await gql(`mutation($b:ID!,$t:String!){ create_group(board_id:$b, group_name:$t){ id title } }`, { b: B.ledger, t: ARCHIVE_TITLE })).create_group;
  console.log(`+ Ledger group "${ARCHIVE_TITLE}" created (${archive.id})`);
}

const toMove = items.filter((it) => it.group.id !== archive?.id);
const toUnlink = lines.filter((l) => l.link.length);
console.log(`Pending sales: ${sales.map((s) => s.name).join(" · ")} (${lines.length} lines)`);
console.log(`Ledger items to archive: ${toMove.length} of ${items.length} · Wholesale lines to unlink: ${toUnlink.length}`);

if (APPLY) {
  for (const it of toMove) await gql(`mutation($i:ID!,$g:String!){ move_item_to_group(item_id:$i, group_id:$g){ id } }`, { i: it.id, g: archive.id });
  for (const l of toUnlink) {
    await gql(`mutation($b:ID!,$i:ID!,$v:JSON!){ change_multiple_column_values(board_id:$b, item_id:$i, column_values:$v){ id } }`,
      { b: B.wholesaleSub, i: l.id, v: JSON.stringify({ [LINK]: { item_ids: [] } }) });
  }
  // check
  const after = await gql(`query($i:[ID!],$s:[ID!]){ a: items(ids:$i, limit:100){ id group { id } } b: items(ids:$s, limit:100){ id column_values(ids:["${LINK}"]){ ... on BoardRelationValue { linked_item_ids } } } }`,
    { i: items.map((x) => x.id), s: lines.map((l) => l.id) });
  const notMoved = after.a.filter((x) => x.group.id !== archive.id).length;
  const stillLinked = after.b.filter((x) => (x.column_values[0]?.linked_item_ids || []).length).length;
  console.log(`Check: ${after.a.length - notMoved}/${items.length} Ledger items in the archive · ${stillLinked} Wholesale lines still linked`);
  if (notMoved || stillLinked) process.exitCode = 1;
}

// 4 — the md
const lineOf = (it) => lines.find((l) => l.link.includes(String(it.id))) || lines.find((l) => l.id === (cv(it, LC.key)?.text || "").trim());
const saleOf = (it) => sales.find((s) => (cv(it, LC.sale)?.linked_item_ids || []).map(String).includes(String(s.id))) || lineOf(it)?.sale;
const reserved = items.reduce((s, it) => s + num(cv(it, LC.allocated)?.text), 0);
const outstanding = lines.reduce((s, l) => s + l.outstanding, 0);
const today = new Date().toISOString().slice(0, 10);
const row = (it) => {
  const l = lineOf(it);
  const src = (it.subitems || []).map((s) => `${fmt(num(cv(s, LS.qty)?.text))} ${cv(s, LS.ref)?.text || cv(s, LS.type)?.text || s.name}`).join(" · ") || "—";
  return `| ${saleOf(it)?.name.split(" ")[0] || "—"} | ${cv(it, LC.sku)?.text || l?.sku || "—"} | \`${it.id}\` | ${l ? `\`${l.id}\`` : "—"} | ${l ? fmt(l.ordered) : "—"} | ${l ? fmt(l.fulfilled) : "—"} | ${l ? fmt(l.outstanding) : "—"} | ${fmt(num(cv(it, LC.allocated)?.text))} | ${cv(it, LC.status)?.text || "—"} | ${src} |`;
};
const md = `# Ventas del grupo Pending: allocation desacoplada

*${APPLY ? `Aplicado el ${today}` : `PLAN (todavía no aplicado) · generado el ${today}`} con \`scripts/archive-pending.mjs\`.*

## Qué pasó

- En 🛍️ Wholesale Allocation (Reservations) el grupo **Pending** (\`group_mm1730xq\`) tenía ventas viejas y obsoletas: ${sales.map((s) => `**${s.name}**`).join(" y ")}.
- Sus asignaciones venían de la Allocation Queue (monday Vibe): se habían hecho sobre lo pedido y nunca se bajaron con lo despachado en Cin7. Reservaban **${fmt(reserved)} unidades** para **${fmt(outstanding)}** pendientes de despachar.
- Esas reservas bloqueaban stock (warehouse, contenedores y POs) para las demás ventas y generaban casi todos los avisos de "Needs review" y del mail diario (56 de 56 el 7 de octubre de 2026).

## Qué se decidió (8 de octubre de 2026)

- **La Allocation Matrix toma como demanda solo el grupo Orders** (\`topics\`) de Wholesale. El grupo Pending no se lee más.
- **Desde dónde empezamos:** las ventas que hoy están en Orders (EIVR118, EIVR117 y EIVR121) y todo lo nuevo que Make cree desde ahora (Make crea las ventas en Orders).
- Lo de Pending no se borra: queda archivado para poder consultarlo o recuperarlo.

## Qué se hizo

1. En 🔗 Allocation Ledger se creó el grupo **${ARCHIVE_TITLE}**${archive ? ` (\`${archive.id}\`)` : ""} y se movieron ahí **${items.length} items** de esas ventas, con sus subitems (fuentes) y todos sus datos intactos. La app no lee ese grupo, así que esas unidades ya no se reservan.
2. En Wholesale se vació la columna **🔗 Allocation Ledger** (\`${LINK}\`) de **${toUnlink.length} subitems** de esas ventas. La tabla de abajo guarda qué subitem apuntaba a qué item del Ledger.
3. Nada más cambió: las ventas siguen en Pending, con sus subitems y cantidades como las escribe Make.

## Qué hacer con lo desacoplado

| Caso | Qué hacer |
|---|---|
| La venta ya no se va a despachar (obsoleta) | Nada. Queda en Pending y su allocation en el archivo del Ledger, como historial. Si se cierra en Cin7, Make la actualiza como siempre. |
| La venta todavía se tiene que despachar | Moverla al grupo **Orders** en Wholesale. La app la muestra **sin nada asignado** y se asigna de nuevo con el editor, con el stock y los contenedores de hoy. Los items archivados **no** se reutilizan: la app crea items nuevos en Active. |
| Hace falta ver qué tenía asignado | Abrir el grupo **${ARCHIVE_TITLE}** del Ledger o la tabla de abajo. |
| Volver atrás (no recomendado) | Mover los items del archivo al grupo Active del Ledger, volver a conectar cada subitem de Wholesale con su item (tabla de abajo) y volver a incluir Pending en el código (\`OPEN_GROUPS\` en \`src/lib/monday.js\` y \`OPEN_ORDER_GROUPS\` en \`src/lib/engine.js\`). |

## Ventas de Pending

| Venta | Líneas | Pedido | Despachado | Pendiente | Items del Ledger |
|---|---|---|---|---|---|
${sales.map((s) => { const ls = lines.filter((l) => l.sale === s); return `| ${s.name} (\`${s.id}\`) | ${ls.length} | ${fmt(ls.reduce((a, l) => a + l.ordered, 0))} | ${fmt(ls.reduce((a, l) => a + l.fulfilled, 0))} | ${fmt(ls.reduce((a, l) => a + l.outstanding, 0))} | ${items.filter((it) => saleOf(it) === s).length} |`; }).join("\n")}

## Items del Ledger archivados

Cantidades de la línea (Pedido / Despachado / Pendiente) al momento del archivo.

| Venta | SKU | Item del Ledger | Subitem de Wholesale | Pedido | Despachado | Pendiente | Asignado | Status Allocation | Fuentes (Qty Used) |
|---|---|---|---|---|---|---|---|---|---|
${items.map(row).join("\n")}

---

*ETOILE · Allocation Matrix · limpieza de las ventas de Pending*
`;
writeFileSync(new URL("../EtoileContextoApp/ARCHIVO-ventas-pending.md", import.meta.url), md);
console.log("md: EtoileContextoApp/ARCHIVO-ventas-pending.md");
