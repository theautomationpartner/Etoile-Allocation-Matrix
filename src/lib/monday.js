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
  inTransitSub: "18402783956",
  po: "18402622623",
  ledger: "18430965833", // 🔗 Allocation Ledger - Monday Vibe
  ledgerSub: "18430967307",
  newShipments: "18433404829", // 🔗 New Shipments - Monday Vibe (step 4)
};

export const COL = {
  sale: { retailer: "dropdown_mm17we0j", region: "color_mm17q217", status: "color_mm17bttk", orderDate: "date_mm1s15v9", cancelDate: "date_mm5bxkpz", saleCin7: "link_mm26kvdr", allocStatus: "color_mm7146kz", allocPct: "numeric_mm71h5ps" },
  saleSub: { skuId: "text_mm251am5", ordered: "numeric_mm17ttsn", fulfilled: "numeric_mm19rrnv", outstanding: "numeric_mm19gkqq", allocJson: "long_text_mm4kee9f", allocSource: "dropdown_mm4fwfk7", poRel: "board_relation_mm3hna2c", itRel: "board_relation_mm342hhx", ledgerRel: "board_relation_mm7pqf7j", lastProcessed: "numeric_mm7x8pp1" },
  wh: { sku: "text_mm17625z", usQty: "numeric_mm1765fq" },
  // Master SKU subitems ("Incoming records"): one per PO × SKU (PurchaseID = Cin7 OrderID|SKU), one per container.
  whSub: { po: "board_relation_mm19zsyp", region: "lookup_mm1hgwz5", eta: "date_mm2vrt3q", arrival: "color_mm2vzyxm", usInTransit: "numeric_mm293ds6",
    usOutstanding: "numeric_mm19bvcx", usOnOrder: "numeric_mm19v320", purchaseId: "text_mm1cnjfs", transitId: "text_mm34kmb5" },
  // isProcess: "Is Process" checkbox — copies made while importing, never counted.
  // subPo: the PO item of each container line · subStatus: Arrived – Pending Receiving / Received (written by the app)
  it: { location: "color_mm3bhhys", eta: "date4", packingList: "color_mm1c7w2a", isProcess: "boolean_mm7xhwt8", subSku: "text_mm15xggt", subQty: "numeric_mm3k24ed", subPoRef: "text_mm2ebx76", subPo: "board_relation_mm2ef1zr", subStatus: "color_mm3kvr2h" },
  po: { reference: "text_mm14nxap", region: "color_mm1hmv7r", eta: "date4", status: "status", supplier: "dropdown_mm17rsxm", subSku: "text_mm1598d7", subQtyOrdered: "numeric_mm15va7p", subQtyOutstanding: "numeric_mm1g5z37", subQtyArrived: "numeric_mm1593d3", subStatus: "status" },
  ledger: { key: "text_mm76g12x", saleRel: "board_relation_mm76cxt5", saleId: "text_mm76t66a", sku: "text_mm76wfw4", fulfilled: "numeric_mm76ebf5", allocatedQty: "numeric_mm76s5dm", status: "color_mm76q1fj", json: "long_text_mm764vdq", shipmentsRel: "board_relation_mm7p81dk" },
  // Ledger subitems: one per source that feeds the sale line (the structured record of the allocation).
  ledgerSub: { type: "color_mm76ffrx", sourceId: "text_mm768syf", ref: "text_mm76r4a3", qty: "numeric_mm76x8g", total: "numeric_mm76pg3t", eta: "date_mm76m9nh", packingDone: "boolean_mm76nhw6", arrival: "color_mm7xe2mp" },
};

export const OPEN_GROUPS = ["topics", "group_mm1730xq"]; // Wholesale: Orders + Pending
export const LEDGER_ACTIVE_GROUP = "group_mm76c2zx"; // Ledger: Active
export const LEDGER_FULFILLED_GROUP = "group_mm76zg9t"; // Ledger: Fulfilled — still the line's record while its order is open
export const LEDGER_RELEASED_GROUP = "group_mm76qvz"; // Ledger: Released — a line allocated back to zero (holds no units)
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
// Date column value {"date":"2026-10-01","time":"11:24:00"} (UTC) → ISO string, or "".
const savedIso = (value) => {
  try {
    const v = JSON.parse(value || "null");
    return v?.date ? `${v.date}T${v.time || "00:00:00"}Z` : "";
  } catch {
    return "";
  }
};

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

// Confirmed entries of every sale line from the Ledger (group Active). A line keeps the raw link of its
// Wholesale subitem (ledgerLinkId) and the Ledger item that holds its units now (ledgerItemId).
export function withLedger(data, ledger) {
  const orders = data.orders.map((o) => ({
    ...o,
    lines: o.lines.map((l) => {
      const linkId = l.ledgerLinkId !== undefined ? l.ledgerLinkId : l.ledgerItemId;
      const rec = (linkId && ledger.byId.get(String(linkId))) || ledger.byKey.get(String(l.id));
      return {
        ...l, entries: rec?.entries || [], ledgerLinkId: linkId || null, ledgerItemId: rec?.itemId || null,
        ledgerFulfilled: rec?.fulfilled ?? null, ledgerStatus: rec?.statusLabel || "",
      };
    }),
  }));
  return { ...data, orders };
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
      subitems { id name column_values(ids:[${gqlList([sc.skuId, sc.ordered, sc.fulfilled, sc.outstanding, sc.allocJson, sc.ledgerRel, sc.lastProcessed])}]) {
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
          // US Qty Fulfilled already reviewed (written on Allocate / Release); null while the column is empty
          lastProcessed: cv(sub, sc.lastProcessed) === "" ? null : num(cv(sub, sc.lastProcessed)),
          entries: parseAllocationJson(cv(sub, sc.allocJson)),
          ledgerItemId: (sub.column_values.find((c) => c.id === sc.ledgerRel)?.linked_item_ids || [])[0] || null,
        };
      }),
    }));
  }

  // One Ledger item per sale line (groups Active and Fulfilled), one subitem per source feeding it.
  // As in the Allocation Queue, what decides is the ORDER's group (Orders + Pending): a line of an open
  // order keeps the units of its Ledger item even if that item sits in Fulfilled. Released holds none.
  // byId → the Ledger item a Wholesale subitem links to (board_relation_mm7pqf7j);
  // byKey → fallback by Allocation Key (= Wholesale subitem id).
  async function loadLedger() {
    const l = COL.ledger, ls = COL.ledgerSub;
    const fields = `id name group { id } column_values(ids:[${gqlList([l.key, l.sku, l.json, l.fulfilled, l.status])}]) { id text }
      subitems { id name column_values(ids:[${gqlList(Object.values(ls))}]) { id text } }`;
    const items = await allItems(BOARDS.ledger, fields, { groups: [LEDGER_ACTIVE_GROUP, LEDGER_FULFILLED_GROUP] });
    const byId = new Map(), byKey = new Map();
    for (const it of items) {
      const fromSubitems = (it.subitems || [])
        .map((s) => ({ source: LEDGER_SOURCE_TYPE[cv(s, ls.type)], sourceId: cv(s, ls.sourceId).trim(), ref: cv(s, ls.ref), qty: num(cv(s, ls.qty)), eta: date(cv(s, ls.eta)), subitemId: String(s.id), arrivalLabel: cv(s, ls.arrival) }))
        .filter((e) => e.source && e.qty > 0);
      // The subitems are the record; the JSON copy is only a fallback for an item without subitems.
      const record = {
        itemId: it.id, group: it.group?.id || "", sku: cv(it, l.sku).trim(),
        entries: fromSubitems.length ? fromSubitems : parseAllocationJson(cv(it, l.json)),
        fulfilled: cv(it, l.fulfilled) === "" ? null : num(cv(it, l.fulfilled)), // US Qty Fulfilled when the app last wrote the line
        statusLabel: cv(it, l.status),
      };
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

  // Master SKU items, with their subitems: the "Incoming records" (one per PO × SKU, split per container that
  // carries it), written by the PO sync and the In-Transit importer (Proceso-In-Transit.md).
  async function loadWarehouse() {
    const r = COL.whSub;
    const items = await allItems(BOARDS.warehouse, `id name column_values(ids:[${gqlList([COL.wh.sku, COL.wh.usQty])}]) { id text }
      subitems { id name column_values(ids:[${gqlList(Object.values(r))}]) { id text ... on BoardRelationValue { linked_item_ids } ... on MirrorValue { display_value } } }`);
    const out = {};
    for (const it of items) {
      const sku = cv(it, COL.wh.sku).trim();
      if (!sku || out[sku]) continue;
      out[sku] = {
        itemId: it.id, name: it.name, usQty: num(cv(it, COL.wh.usQty)),
        incoming: (it.subitems || []).map((s) => {
          const col = (id) => s.column_values.find((c) => c.id === id);
          return {
            id: String(s.id), name: s.name,
            poId: (col(r.po)?.linked_item_ids || [])[0] ? String(col(r.po).linked_item_ids[0]) : null,
            region: col(r.region)?.display_value || col(r.region)?.text || "",
            eta: date(cv(s, r.eta)), arrival: cv(s, r.arrival), // Estimated / Confirmed
            inTransit: num(cv(s, r.usInTransit)), outstanding: num(cv(s, r.usOutstanding)), onOrder: num(cv(s, r.usOnOrder)),
            purchaseId: cv(s, r.purchaseId).trim(), transitLineId: cv(s, r.transitId).trim(), // In-Transit subitem carrying it
          };
        }),
      };
    }
    return out;
  }

  async function loadContainers() {
    const c = COL.it;
    const fields = `id name group { id } column_values(ids:[${gqlList([c.location, c.eta, c.packingList, c.isProcess])}]) { id text }
      subitems { id column_values(ids:[${gqlList([c.subSku, c.subQty, c.subPoRef, c.subPo, c.subStatus])}]) { id text ... on BoardRelationValue { linked_item_ids } } }`;
    // All groups: "topics" is the in-transit supply; Archive holds landed ("Done") containers whose
    // reservations are checked against their PO's arrivals. Archived/deleted items are not returned by monday.
    // "Is Process" items are copies made while importing: never counted.
    const items = await allItems(BOARDS.inTransit, fields);
    const poOf = (sub) => (sub.column_values.find((x) => x.id === c.subPo)?.linked_item_ids || [])[0];
    return items.filter((it) => cv(it, c.isProcess) !== "v").map((it) => ({
      id: it.id,
      name: it.name,
      group: it.group?.id || "",
      location: cv(it, c.location),
      eta: date(cv(it, c.eta)),
      packingList: cv(it, c.packingList),
      lines: (it.subitems || []).map((sub) => ({
        id: sub.id, sku: cv(sub, c.subSku).trim(), qty: num(cv(sub, c.subQty)), poRef: cv(sub, c.subPoRef).trim(),
        poId: poOf(sub) ? String(poOf(sub)) : null, status: cv(sub, c.subStatus),
      })),
    }));
  }

  async function loadPOs() {
    const p = COL.po;
    const fields = `id name column_values(ids:[${gqlList([p.reference, p.region, p.eta, p.status, p.supplier])}]) { id text }
      subitems { id column_values(ids:[${gqlList([p.subSku, p.subQtyOrdered, p.subQtyOutstanding, p.subQtyArrived, p.subStatus])}]) { id text } }`;
    const items = await allItems(BOARDS.po, fields);
    return items.map((it) => ({
      id: it.id,
      name: it.name,
      reference: cv(it, p.reference),
      region: cv(it, p.region),
      eta: date(cv(it, p.eta)),
      status: cv(it, p.status),
      supplier: cv(it, p.supplier),
      lines: (it.subitems || []).map((sub) => ({
        id: sub.id, sku: cv(sub, p.subSku).trim(), qtyOrdered: num(cv(sub, p.subQtyOrdered)), qtyOutstanding: num(cv(sub, p.subQtyOutstanding)),
        qtyArrived: num(cv(sub, p.subQtyArrived)), status: cv(sub, p.subStatus), // Fully Arrived · Partially Arrived · …
      })),
    }));
  }

  // Step 4 — saved shipments: items of New Shipments connected to a wholesale order (the board's sample
  // items without an order are ignored). Returned in creation order.
  async function loadShipments() {
    const c = NS.col, sc = NS.subCol;
    const fields = `id name created_at column_values(ids:[${gqlList(Object.values(c))}]) { id text value ... on BoardRelationValue { linked_item_ids } }
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
          savedAt: savedIso(it.column_values.find((x) => x.id === c.saved)?.value), // UTC, from the column value
          createdAt: it.created_at || "",
          lines: (it.subitems || []).map((s) => ({ subId: String(s.id), sku: cv(s, sc.sku).trim(), qty: num(cv(s, sc.qty)) })).filter((l) => l.sku),
        };
      })
      .filter((s) => s.orderId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.mondayId.localeCompare(b.mondayId));
  }

  // Every column the app reads or writes must exist. If someone deletes or recreates one in monday
  // (it happened with date4), the app stops with a clear message instead of silently showing zeros.
  async function checkSchema() {
    const need = {
      [BOARDS.wholesale]: { name: "Wholesale Allocation", cols: [COL.sale.region, COL.sale.cancelDate] },
      [BOARDS.wholesaleSub]: { name: "Wholesale Allocation (subitems)", cols: [COL.saleSub.skuId, COL.saleSub.outstanding, COL.saleSub.ledgerRel, COL.saleSub.lastProcessed, "board_relation_mm7pd15e", "multiple_person_mm7pdm50"] },
      [BOARDS.warehouse]: { name: "Master SKU Inventory", cols: [COL.wh.sku, COL.wh.usQty] },
      "18402981518": { name: "Master SKU Inventory (subitems)", cols: Object.values(COL.whSub) },
      [BOARDS.inTransit]: { name: "In-Transit Shipments", cols: [COL.it.location, COL.it.eta, COL.it.packingList, COL.it.isProcess] },
      [BOARDS.inTransitSub]: { name: "In-Transit Shipments (subitems)", cols: [COL.it.subSku, COL.it.subQty, COL.it.subPoRef, COL.it.subPo, COL.it.subStatus] },
      [BOARDS.po]: { name: "Purchase Orders", cols: [COL.po.region, COL.po.eta] },
      "18402780137": { name: "Purchase Orders (subitems)", cols: [COL.po.subSku, COL.po.subQtyOutstanding, COL.po.subQtyArrived, COL.po.subStatus] },
      [BOARDS.ledger]: { name: "Allocation Ledger", cols: [COL.ledger.key, COL.ledger.json, COL.ledger.shipmentsRel, COL.ledger.fulfilled, COL.ledger.status] },
      [BOARDS.ledgerSub]: { name: "Allocation Ledger (subitems)", cols: [COL.ledgerSub.type, COL.ledgerSub.sourceId, COL.ledgerSub.qty, COL.ledgerSub.arrival] },
      [NS.board]: { name: "New Shipments", cols: Object.values(NS.col) },
      [NS.sub]: { name: "New Shipments (subitems)", cols: [...Object.values(NS.subCol), NS.subOwner] },
    };
    const d = await transport(`query($b:[ID!]){ boards(ids:$b){ id columns { id } } }`, { b: Object.keys(need) });
    const missing = [];
    for (const [id, req] of Object.entries(need)) {
      const board = (d?.boards || []).find((b) => String(b.id) === id);
      if (!board) { missing.push(`board "${req.name}"`); continue; }
      const have = new Set(board.columns.map((c) => c.id));
      for (const c of req.cols) if (!have.has(c)) missing.push(`column ${c} on "${req.name}"`);
    }
    if (missing.length) throw new Error(`Monday is missing ${missing.join(", ")}. The figures can't be calculated safely — ask your administrator to restore it.`);
  }

  // Step 3 — the Ledger item of one sale line, in any group (a Released one is reused when the line is
  // allocated again): the one the Wholesale subitem links to, else the one whose Allocation Key is the line.
  async function findLedgerItem(lineId, linkId) {
    const f = `id state group { id } board { id } subitems { id }`;
    const [linked, byKey] = await Promise.all([
      linkId ? transport(`query($i:[ID!]){ items(ids:$i){ ${f} } }`, { i: [String(linkId)] }) : null,
      transport(`query($b:ID!,$v:[String]!){ items_page_by_column_values(board_id:$b, limit:10, columns:[{column_id:"${COL.ledger.key}", column_values:$v}]){ items { ${f} } } }`,
        { b: BOARDS.ledger, v: [String(lineId)] }),
    ]);
    const live = (it) => it && it.state === "active" && String(it.board?.id) === BOARDS.ledger;
    const rank = (it) => ({ [LEDGER_ACTIVE_GROUP]: 0, [LEDGER_FULFILLED_GROUP]: 1, [LEDGER_RELEASED_GROUP]: 2 }[it.group?.id] ?? 3);
    const candidates = [...(linked?.items || []), ...((byKey?.items_page_by_column_values?.items || []).sort((a, b) => rank(a) - rank(b)))].filter(live);
    const it = candidates[0];
    return it ? { id: String(it.id), group: it.group?.id || "", subitemIds: (it.subitems || []).map((s) => String(s.id)) } : null;
  }

  async function loadMatrixData({ allocationSource = ALLOCATION_SOURCE.LEDGER } = {}) {
    await checkSchema();
    const useLedger = allocationSource === ALLOCATION_SOURCE.LEDGER;
    const [orders, warehouse, containers, pos, ledger, boardCounts, shipments] = await Promise.all([
      loadOrders(), loadWarehouse(), loadContainers(), loadPOs(), useLedger ? loadLedger() : null, loadBoardCounts().catch(() => ({})), loadShipments(),
    ]);
    const data = { orders, warehouse, containers, pos, boardCounts, shipments, allocationSource, loadedAt: new Date() };
    return useLedger ? withLedger(data, ledger) : data;
  }

  return { loadMatrixData, loadLedger, loadShipments, findLedgerItem };
}
