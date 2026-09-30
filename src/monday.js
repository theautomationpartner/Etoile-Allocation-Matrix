// Reads the five monday.com boards the matrix needs (§2) through the server proxy (/api/monday)
// and normalizes them into the shape engine.js expects. Board and column IDs are the ones the
// current Allocation Queue app already uses; the matrix must not create new ones.

export const BOARDS = {
  wholesale: "18402982970",
  wholesaleSub: "18402982973",
  warehouse: "18402981515",
  inTransit: "18402604887",
  po: "18402622623",
};

export const COL = {
  sale: { retailer: "dropdown_mm17we0j", region: "color_mm17q217", status: "color_mm17bttk", orderDate: "date_mm1s15v9", cancelDate: "date_mm5bxkpz", saleCin7: "link_mm26kvdr", allocStatus: "color_mm7146kz", allocPct: "numeric_mm71h5ps" },
  saleSub: { skuId: "text_mm251am5", ordered: "numeric_mm17ttsn", fulfilled: "numeric_mm19rrnv", outstanding: "numeric_mm19gkqq", allocJson: "long_text_mm4kee9f", allocSource: "dropdown_mm4fwfk7", poRel: "board_relation_mm3hna2c", itRel: "board_relation_mm342hhx" },
  wh: { sku: "text_mm17625z", usQty: "numeric_mm1765fq" },
  it: { location: "color_mm3bhhys", eta: "date4", packingList: "color_mm1c7w2a", subSku: "text_mm15xggt", subQty: "numeric_mm3k24ed", subPoRef: "text_mm2ebx76" },
  po: { reference: "text_mm14nxap", region: "color_mm1hmv7r", eta: "date4", status: "status", supplier: "dropdown_mm17rsxm", subSku: "text_mm1598d7", subQtyOrdered: "numeric_mm15va7p", subQtyOutstanding: "numeric_mm1g5z37" },
};

const OPEN_GROUPS = ["topics", "group_mm1730xq"];
const PAGE = 100;

const num = (t) => {
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : 0;
};
const date = (t) => (t ? String(t).slice(0, 10) : "");
const cv = (item, id) => (item.column_values || []).find((c) => c.id === id)?.text ?? "";
const ids = (list) => list.map((x) => JSON.stringify(x)).join(",");

export async function mondayQuery(query, variables = {}) {
  const res = await fetch("/api/monday", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error || body.errors?.[0]?.message || `HTTP ${res.status}`);
  if (Array.isArray(body.errors) && body.errors.length) throw new Error(body.errors.map((e) => e.message).join(" | "));
  return body.data;
}

// Walks items_page / next_items_page until the cursor runs out.
async function allItems(boardId, fields, { groups } = {}) {
  const itemsSel = `cursor items { ${fields} }`;
  const first = groups
    ? `query($b:[ID!]){ boards(ids:$b){ groups(ids:[${ids(groups)}]){ items_page(limit:${PAGE}){ ${itemsSel} } } } }`
    : `query($b:[ID!]){ boards(ids:$b){ items_page(limit:${PAGE}){ ${itemsSel} } } }`;
  const data = await mondayQuery(first, { b: [boardId] });
  const board = data?.boards?.[0];
  if (!board) throw new Error(`Board ${boardId} was not found or is not accessible with this token.`);

  const pages = groups ? (board.groups || []).map((g) => g.items_page) : [board.items_page];
  const out = [];
  for (let page of pages) {
    const seen = new Set();
    while (page) {
      out.push(...(page.items || []));
      if (!page.cursor || seen.has(page.cursor)) break;
      seen.add(page.cursor);
      const next = await mondayQuery(`query($c:String!){ next_items_page(cursor:$c, limit:${PAGE}){ ${itemsSel} } }`, { c: page.cursor });
      page = next?.next_items_page;
    }
  }
  return out;
}

// §14.1 JSON contract of long_text_mm4kee9f: [{ source, sourceId, ref, qty, eta?, packingDone? }]
export function parseAllocationJson(text) {
  if (!text) return [];
  try {
    const arr = JSON.parse(text);
    return Array.isArray(arr)
      ? arr.filter((x) => x && num(x.qty) > 0).map((x) => ({ source: x.source, sourceId: String(x.sourceId ?? ""), ref: x.ref || "", qty: num(x.qty), eta: x.eta || "" }))
      : [];
  } catch {
    return [];
  }
}

async function loadOrders() {
  const s = COL.sale, sc = COL.saleSub;
  const fields = `id name group { id }
    column_values(ids:[${ids(Object.values(s))}]) { id text }
    subitems { id name column_values(ids:[${ids([sc.skuId, sc.ordered, sc.fulfilled, sc.outstanding, sc.allocJson])}]) { id text } }`;
  const items = await allItems(BOARDS.wholesale, fields, { groups: OPEN_GROUPS });
  return items.map((it) => ({
    id: it.id,
    name: it.name,
    group: it.group?.id || "",
    retailer: cv(it, s.retailer),
    region: cv(it, s.region),
    saleStatus: cv(it, s.status),
    orderDate: date(cv(it, s.orderDate)),
    cancelDate: date(cv(it, s.cancelDate)),
    lines: (it.subitems || []).map((sub) => {
      const skuId = cv(sub, sc.skuId);
      return {
        id: sub.id,
        sku: (skuId.includes("|") ? skuId.split("|").pop() : skuId).trim(), // §2: text after the last "|"
        ordered: num(cv(sub, sc.ordered)),
        fulfilled: num(cv(sub, sc.fulfilled)),
        outstanding: num(cv(sub, sc.outstanding)),
        entries: parseAllocationJson(cv(sub, sc.allocJson)),
      };
    }),
  }));
}

async function loadWarehouse() {
  const fields = `id name column_values(ids:[${ids([COL.wh.sku, COL.wh.usQty])}]) { id text }`;
  const items = await allItems(BOARDS.warehouse, fields);
  const out = {};
  for (const it of items) {
    const sku = cv(it, COL.wh.sku).trim();
    if (sku && !out[sku]) out[sku] = { itemId: it.id, name: it.name, usQty: num(cv(it, COL.wh.usQty)) };
  }
  return out;
}

async function loadContainers() {
  const c = COL.it;
  const fields = `id name group { id } column_values(ids:[${ids([c.location, c.eta, c.packingList])}]) { id text }
    subitems { id column_values(ids:[${ids([c.subSku, c.subQty, c.subPoRef])}]) { id text } }`;
  const items = await allItems(BOARDS.inTransit, fields, { groups: ["topics"] });
  return items.map((it) => ({
    id: it.id,
    name: it.name,
    group: it.group?.id || "",
    location: cv(it, c.location),
    eta: date(cv(it, c.eta)),
    packingList: cv(it, c.packingList),
    lines: (it.subitems || []).map((sub) => ({ id: sub.id, sku: cv(sub, c.subSku).trim(), qty: num(cv(sub, c.subQty)), poRef: cv(sub, c.subPoRef).trim() })),
  }));
}

async function loadPOs() {
  const p = COL.po;
  const fields = `id name column_values(ids:[${ids([p.reference, p.region, p.eta, p.status, p.supplier])}]) { id text }
    subitems { id column_values(ids:[${ids([p.subSku, p.subQtyOrdered, p.subQtyOutstanding])}]) { id text } }`;
  const items = await allItems(BOARDS.po, fields);
  return items.map((it) => ({
    id: it.id,
    name: it.name,
    reference: cv(it, p.reference),
    region: cv(it, p.region),
    eta: date(cv(it, p.eta)),
    status: cv(it, p.status),
    supplier: cv(it, p.supplier),
    lines: (it.subitems || []).map((sub) => ({ id: sub.id, sku: cv(sub, p.subSku).trim(), qtyOrdered: num(cv(sub, p.subQtyOrdered)), qtyOutstanding: num(cv(sub, p.subQtyOutstanding)) })),
  }));
}

export async function loadMatrixData() {
  const [orders, warehouse, containers, pos] = await Promise.all([loadOrders(), loadWarehouse(), loadContainers(), loadPOs()]);
  return { orders, warehouse, containers, pos, loadedAt: new Date() };
}
