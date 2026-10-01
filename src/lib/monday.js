// Reads the monday.com boards the matrix needs (§2) and normalizes them into the shape engine.js expects.
// Transport-agnostic: pass any function (query, variables) => data.
//   · local / Vercel:  fetchTransport  → POST /api/monday (server proxy holds the token)
//   · monday Vibe:     (q, v) => monday.api(q, { variables: v }).then(r => r.data)
// Board and column IDs are the ones the current Allocation Queue app already uses.

import { NS } from "./mondayWrites.js";
import { authHeaders, NotAuthorizedError, reportDenied } from "./auth.js";

export const BOARDS = {
  wholesale: "18402982970",
  wholesaleSub: "18402982973",
  warehouse: "18402981515",
  inTransit: "18402604887",
  po: "18402622623",
  ledger: "18430965833", // 🔗 Allocation Ledger - Monday Vibe
  ledgerSub: "18430967307",
  newShipments: "18433404829", // 🔗 New Shipments - Monday Vibe (step 4)
};

export const COL = {
  sale: { retailer: "dropdown_mm17we0j", region: "color_mm17q217", status: "color_mm17bttk", orderDate: "date_mm1s15v9", cancelDate: "date_mm5bxkpz", saleCin7: "link_mm26kvdr", allocStatus: "color_mm7146kz", allocPct: "numeric_mm71h5ps" },
  saleSub: { skuId: "text_mm251am5", ordered: "numeric_mm17ttsn", fulfilled: "numeric_mm19rrnv", outstanding: "numeric_mm19gkqq", allocJson: "long_text_mm4kee9f", allocSource: "dropdown_mm4fwfk7", poRel: "board_relation_mm3hna2c", itRel: "board_relation_mm342hhx", ledgerRel: "board_relation_mm7pqf7j" },
  wh: { sku: "text_mm17625z", usQty: "numeric_mm1765fq" },
  it: { location: "color_mm3bhhys", eta: "date4", packingList: "color_mm1c7w2a", subSku: "text_mm15xggt", subQty: "numeric_mm3k24ed", subPoRef: "text_mm2ebx76" },
  po: { reference: "text_mm14nxap", region: "color_mm1hmv7r", eta: "date4", status: "status", supplier: "dropdown_mm17rsxm", subSku: "text_mm1598d7", subQtyOrdered: "numeric_mm15va7p", subQtyOutstanding: "numeric_mm1g5z37" },
  ledger: { key: "text_mm76g12x", saleRel: "board_relation_mm76cxt5", saleId: "text_mm76t66a", sku: "text_mm76wfw4", allocatedQty: "numeric_mm76s5dm", status: "color_mm76q1fj", json: "long_text_mm764vdq", shipmentsRel: "board_relation_mm7p81dk" },
  // Ledger subitems: one per source that feeds the sale line (the structured record of the allocation).
  ledgerSub: { type: "color_mm76ffrx", sourceId: "text_mm768syf", ref: "text_mm76r4a3", qty: "numeric_mm76x8g", total: "numeric_mm76pg3t", eta: "date_mm76m9nh", packingDone: "boolean_mm76nhw6" },
};

export const OPEN_GROUPS = ["topics", "group_mm1730xq"]; // Wholesale: Orders + Pending
export const LEDGER_ACTIVE_GROUP = "group_mm76c2zx"; // Ledger: Active (Fulfilled / Released hold no units)
export const IMPORTER_BOARD = "18404604646"; // In-Transit / Wholesale Importer (only its item count, for the side nav)
const LEDGER_SOURCE_TYPE = { "Warehouse Stock": "warehouse", "In-Transit": "intransit", "Purchase Order": "po" };

// Where confirmed allocations are read from. Pending the client's decision (see PROMPT txt, open points).
export const ALLOCATION_SOURCE = { SUBITEM_JSON: "subitem-json", LEDGER: "ledger" };

const PAGE = 100;
const num = (t) => {
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : 0;
};
const date = (t) => (t ? String(t).slice(0, 10) : "");
const cv = (item, id) => (item.column_values || []).find((c) => c.id === id)?.text ?? "";
const gqlList = (list) => list.map((x) => JSON.stringify(x)).join(",");

export async function fetchTransport(query, variables = {}) {
  const res = await fetch("/api/monday", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401) {
    reportDenied();
    throw new NotAuthorizedError();
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error || body.errors?.[0]?.message || `HTTP ${res.status}`);
  if (Array.isArray(body.errors) && body.errors.length) throw new Error(body.errors.map((e) => e.message).join(" | "));
  return body.data;
}

// §14.1 JSON contract: [{ source, sourceId, ref, qty, eta?, packingDone? }]
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

export function createMondayApi(transport = fetchTransport) {
  // Walks items_page / next_items_page until the cursor runs out.
  async function allItems(boardId, fields, { groups } = {}) {
    const sel = `cursor items { ${fields} }`;
    const first = groups
      ? `query($b:[ID!]){ boards(ids:$b){ groups(ids:[${gqlList(groups)}]){ items_page(limit:${PAGE}){ ${sel} } } } }`
      : `query($b:[ID!]){ boards(ids:$b){ items_page(limit:${PAGE}){ ${sel} } } }`;
    const data = await transport(first, { b: [boardId] });
    const board = data?.boards?.[0];
    if (!board) throw new Error(`Board ${boardId} was not found or is not accessible.`);
    const pages = groups ? (board.groups || []).map((g) => g.items_page) : [board.items_page];
    const out = [];
    for (let page of pages) {
      const seen = new Set();
      while (page) {
        out.push(...(page.items || []));
        if (!page.cursor || seen.has(page.cursor)) break;
        seen.add(page.cursor);
        page = (await transport(`query($c:String!){ next_items_page(cursor:$c, limit:${PAGE}){ ${sel} } }`, { c: page.cursor }))?.next_items_page;
      }
    }
    return out;
  }

  async function loadOrders() {
    const s = COL.sale, sc = COL.saleSub;
    const fields = `id name group { id }
      column_values(ids:[${gqlList(Object.values(s))}]) { id text }
      subitems { id name column_values(ids:[${gqlList([sc.skuId, sc.ordered, sc.fulfilled, sc.outstanding, sc.allocJson, sc.ledgerRel])}]) {
        id text ... on BoardRelationValue { linked_item_ids } } }`;
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
          name: sub.name,
          sku: (skuId.includes("|") ? skuId.split("|").pop() : skuId).trim(), // §2: text after the last "|"
          ordered: num(cv(sub, sc.ordered)),
          fulfilled: num(cv(sub, sc.fulfilled)),
          outstanding: num(cv(sub, sc.outstanding)),
          entries: parseAllocationJson(cv(sub, sc.allocJson)),
          ledgerItemId: (sub.column_values.find((c) => c.id === sc.ledgerRel)?.linked_item_ids || [])[0] || null,
        };
      }),
    }));
  }

  // One Ledger item per sale line (group Active), one subitem per source feeding it.
  // byId → the Ledger item a Wholesale subitem links to (board_relation_mm7pqf7j);
  // byKey → fallback by Allocation Key (= Wholesale subitem id).
  async function loadLedger() {
    const l = COL.ledger, ls = COL.ledgerSub;
    const fields = `id name column_values(ids:[${gqlList([l.key, l.sku, l.json])}]) { id text }
      subitems { id name column_values(ids:[${gqlList(Object.values(ls))}]) { id text } }`;
    const items = await allItems(BOARDS.ledger, fields, { groups: [LEDGER_ACTIVE_GROUP] });
    const byId = new Map(), byKey = new Map();
    for (const it of items) {
      const fromSubitems = (it.subitems || [])
        .map((s) => ({ source: LEDGER_SOURCE_TYPE[cv(s, ls.type)], sourceId: cv(s, ls.sourceId).trim(), ref: cv(s, ls.ref), qty: num(cv(s, ls.qty)), eta: date(cv(s, ls.eta)) }))
        .filter((e) => e.source && e.qty > 0);
      // The subitems are the record; the JSON copy is only a fallback for an item without subitems.
      const record = { itemId: it.id, sku: cv(it, l.sku).trim(), entries: fromSubitems.length ? fromSubitems : parseAllocationJson(cv(it, l.json)) };
      byId.set(String(it.id), record);
      const key = cv(it, l.key).trim();
      if (key) byKey.set(key, record);
    }
    return { byId, byKey };
  }

  // Item counts for the side nav badges (as in the mockup).
  async function loadBoardCounts() {
    const d = await transport(`query($b:[ID!]){ boards(ids:$b){ id items_count } }`, { b: [BOARDS.wholesale, BOARDS.po, BOARDS.warehouse, IMPORTER_BOARD] });
    return Object.fromEntries((d?.boards || []).map((b) => [String(b.id), b.items_count]));
  }

  async function loadWarehouse() {
    const items = await allItems(BOARDS.warehouse, `id name column_values(ids:[${gqlList([COL.wh.sku, COL.wh.usQty])}]) { id text }`);
    const out = {};
    for (const it of items) {
      const sku = cv(it, COL.wh.sku).trim();
      if (sku && !out[sku]) out[sku] = { itemId: it.id, name: it.name, usQty: num(cv(it, COL.wh.usQty)) };
    }
    return out;
  }

  async function loadContainers() {
    const c = COL.it;
    const fields = `id name group { id } column_values(ids:[${gqlList([c.location, c.eta, c.packingList])}]) { id text }
      subitems { id column_values(ids:[${gqlList([c.subSku, c.subQty, c.subPoRef])}]) { id text } }`;
    // All groups: "topics" is the in-transit supply; Archive holds landed ("Done") containers whose
    // reservations now count as warehouse stock. Archived/deleted items are not returned by monday.
    const items = await allItems(BOARDS.inTransit, fields);
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
    const fields = `id name column_values(ids:[${gqlList([p.reference, p.region, p.eta, p.status, p.supplier])}]) { id text }
      subitems { id column_values(ids:[${gqlList([p.subSku, p.subQtyOrdered, p.subQtyOutstanding])}]) { id text } }`;
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

  // Step 4 — saved shipments: items of New Shipments connected to a wholesale order (the board's sample
  // items without an order are ignored). Returned in creation order.
  async function loadShipments() {
    const c = NS.col, sc = NS.subCol;
    const fields = `id name created_at column_values(ids:[${gqlList(Object.values(c))}]) { id text ... on BoardRelationValue { linked_item_ids } }
      subitems { id name column_values(ids:[${gqlList(Object.values(sc))}]) { id text } }`;
    const items = await allItems(NS.board, fields);
    return items
      .map((it) => {
        const rel = it.column_values.find((x) => x.id === c.order)?.linked_item_ids || [];
        return {
          mondayId: String(it.id),
          orderId: rel[0] ? String(rel[0]) : null,
          name: cv(it, c.name) || it.name,
          target: date(cv(it, c.date)),
          createdAt: it.created_at || "",
          lines: (it.subitems || []).map((s) => ({ subId: String(s.id), sku: cv(s, sc.sku).trim(), qty: num(cv(s, sc.qty)) })).filter((l) => l.sku),
        };
      })
      .filter((s) => s.orderId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.mondayId.localeCompare(b.mondayId));
  }

  async function loadMatrixData({ allocationSource = ALLOCATION_SOURCE.LEDGER } = {}) {
    const useLedger = allocationSource === ALLOCATION_SOURCE.LEDGER;
    const [orders, warehouse, containers, pos, ledger, boardCounts, shipments] = await Promise.all([
      loadOrders(), loadWarehouse(), loadContainers(), loadPOs(), useLedger ? loadLedger() : null, loadBoardCounts().catch(() => ({})), loadShipments(),
    ]);
    if (useLedger) {
      for (const o of orders) {
        for (const l of o.lines) {
          const rec = (l.ledgerItemId && ledger.byId.get(String(l.ledgerItemId))) || ledger.byKey.get(String(l.id));
          l.entries = rec?.entries || [];
          l.ledgerItemId = rec?.itemId || null;
        }
      }
    }
    return { orders, warehouse, containers, pos, boardCounts, shipments, allocationSource, loadedAt: new Date() };
  }

  return { loadMatrixData, loadLedger, loadShipments };
}
