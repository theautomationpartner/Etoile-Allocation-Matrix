// Every write the app can make to monday.com (step 3: allocations in the Ledger; step 4: shipments). Shared by the browser and the
// server: the server (api/monday-write.js) only runs these operations, on these boards and columns.
// In monday Vibe the same queries go through monday.api(query, { variables }) after checkWrite().
//
// Line-level writes are BATCHED: one GraphQL request carries up to BATCH_SIZE aliased mutations
// (e0: create_subitem(...), e1: create_subitem(...), …) instead of one request per line.

export const NS = {
  board: "18433404829", // 🔗 New Shipments - Monday Vibe — item = one shipment
  sub: "18433458521", // its subitems — one SKU line of the shipment
  group: "topics",
  col: { order: "board_relation_mm7pc3qe", name: "text_mm7pj5nc", date: "date_mm7qv5p6", units: "numeric_mm7p9jrf", orderToShip: "numeric_mm7pvjrx", saved: "date_mm7p655r" },
  subCol: { sku: "text_mm7pzh4y", qty: "numeric_mm7p9w92", allocated: "numeric_mm7p8qnb", remaining: "numeric_mm7p2wg0", line: "text_mm7pp7c6", split: "text_mm7p4b6",
    fulfilledAtSave: "numeric_mm84qha7" }, // US Qty Fulfilled of the sale line when the shipment line was created (2026-10-14)
  // "Owner" (people) of each SKU line: who saved it. Written only by the server, with the verified user.
  subOwner: "person",
};
// Connections to the shipments of a sale line.
export const SHIPMENT_LINKS = {
  wholesaleSub: { board: "18402982973", col: "board_relation_mm7pd15e" }, // Wholesale subitem → its shipments
  ledger: { board: "18430965833", col: "board_relation_mm7p81dk" }, // Allocation Ledger item → its shipments
};

// Step 3 — 🔗 Allocation Ledger - Monday Vibe: one item per sale line, one subitem per source feeding it.
export const LEDGER = {
  board: "18430965833",
  sub: "18430967307",
  groups: { active: "group_mm76c2zx", released: "group_mm76qvz" }, // the app never moves an item into or out of Fulfilled
  col: {
    key: "text_mm76g12x", sale: "board_relation_mm76cxt5", saleId: "text_mm76t66a", sku: "text_mm76wfw4", master: "board_relation_mm76mpxt",
    ordered: "numeric_mm766vqv", fulfilled: "numeric_mm76ebf5", outstanding: "numeric_mm76m58e", allocated: "numeric_mm76s5dm", status: "color_mm76q1fj",
    poRel: "board_relation_mm76vycr", poRefs: "text_mm76yede", poUsed: "text_mm76rwqv", poTotal: "text_mm76he3a", poUsedTotal: "numeric_mm761kw4",
    itRel: "board_relation_mm76detw", itRefs: "text_mm76fpnf", itUsed: "text_mm76q5gd", itTotal: "text_mm76bnnc", itUsedTotal: "numeric_mm76fpzk",
    whUsed: "numeric_mm76q8fe", earliestEta: "date_mm7654mr", json: "long_text_mm764vdq", updated: "date_mm766j65",
  },
  subCol: { type: "color_mm76ffrx", sourceId: "text_mm768syf", ref: "text_mm76r4a3", qty: "numeric_mm76x8g", total: "numeric_mm76pg3t", eta: "date_mm76m9nh", packingDone: "boolean_mm76nhw6", arrival: "color_mm7xe2mp" },
  // Wholesale subitem → its Ledger item
  link: { board: "18402982973", col: "board_relation_mm7pqf7j" },
};
// Review (2026-10-07): the US Qty Fulfilled already reviewed, on the Wholesale subitem ("Last Fulfilled Processed").
export const BASELINE = { board: "18402982973", col: "numeric_mm7x8pp1" };
// In-Transit subitem Status of the container lines used by a sale: Arrived – Pending Receiving / Received.
export const TRANSIT_LINES = { board: "18402783956", col: "color_mm3kvr2h" };

export const BATCH_SIZE = 50;
const LINK_TARGET = {
  line: { board: SHIPMENT_LINKS.wholesaleSub.board, columns: [SHIPMENT_LINKS.wholesaleSub.col] },
  ledger: { board: SHIPMENT_LINKS.ledger.board, columns: [SHIPMENT_LINKS.ledger.col] },
  ledgerLine: { board: LEDGER.link.board, columns: [LEDGER.link.col] }, // Wholesale subitem → Ledger item
  baseline: { board: BASELINE.board, columns: [BASELINE.col] }, // Wholesale subitem → Last Fulfilled Processed
};

// Builds one request with one aliased mutation per entry. Returns { query, variables }.
function aliased(entries, header, call) {
  const decl = [header, ...entries.map((_, k) => call.decl(k))].filter(Boolean).join(", ");
  const body = entries.map((e, k) => `e${k}: ${call.body(k, e)} { id }`).join(" ");
  const variables = {};
  entries.forEach((e, k) => Object.assign(variables, call.vars(k, e)));
  return { query: `mutation(${decl}){ ${body} }`, variables };
}

export const WRITE_OPS = {
  // ── the shipment item ──
  createShipment: {
    build: (v) => ({ query: `mutation($n:String!,$v:JSON!){ create_item(board_id:${NS.board}, group_id:"${NS.group}", item_name:$n, column_values:$v){ id } }`, variables: v }),
    vars: ["n", "v"], columns: () => Object.values(NS.col),
  },
  updateShipment: {
    build: (v) => ({ query: `mutation($i:ID!,$v:JSON!){ change_multiple_column_values(board_id:${NS.board}, item_id:$i, column_values:$v){ id } }`, variables: v }),
    vars: ["i", "v"], columns: () => ["name", ...Object.values(NS.col)], itemBoards: () => [NS.board],
  },
  // ── its SKU lines, in batches ──
  createShipmentLines: {
    batch: true, parentBoards: [NS.board], vars: ["p"], fields: ["n", "v"], columns: () => Object.values(NS.subCol),
    build: ({ p, entries }) => {
      const r = aliased(entries, "$p:ID!", {
        decl: (k) => `$n${k}:String!, $v${k}:JSON!`,
        body: (k) => `create_subitem(parent_item_id:$p, item_name:$n${k}, column_values:$v${k})`,
        vars: (k, e) => ({ [`n${k}`]: e.n, [`v${k}`]: e.v }),
      });
      return { query: r.query, variables: { p, ...r.variables } };
    },
  },
  updateShipmentLines: {
    batch: true, fields: ["i", "v"], columns: () => ["name", ...Object.values(NS.subCol)], itemBoards: () => [NS.sub],
    build: ({ entries }) => aliased(entries, "", {
      decl: (k) => `$i${k}:ID!, $v${k}:JSON!`,
      body: (k) => `change_multiple_column_values(board_id:${NS.sub}, item_id:$i${k}, column_values:$v${k})`,
      vars: (k, e) => ({ [`i${k}`]: e.i, [`v${k}`]: e.v }),
    }),
  },
  // Shipment items or SKU lines. Items someone already deleted in monday are skipped by the server.
  deleteShipmentItems: {
    batch: true, fields: ["i"], itemBoards: () => [NS.board, NS.sub], skipGone: true,
    build: ({ entries }) => aliased(entries, "", {
      decl: (k) => `$i${k}:ID!`,
      body: (k) => `delete_item(item_id:$i${k})`,
      vars: (k, e) => ({ [`i${k}`]: e.i }),
    }),
  },
  // ── Step 3: the allocation of a sale line in the Allocation Ledger ──
  createLedgerItem: {
    build: (v) => ({ query: `mutation($n:String!,$v:JSON!){ create_item(board_id:${LEDGER.board}, group_id:"${LEDGER.groups.active}", item_name:$n, column_values:$v, create_labels_if_missing:false){ id } }`, variables: v }),
    vars: ["n", "v"], columns: () => Object.values(LEDGER.col),
  },
  updateLedgerItem: {
    build: (v) => ({ query: `mutation($i:ID!,$v:JSON!){ change_multiple_column_values(board_id:${LEDGER.board}, item_id:$i, column_values:$v, create_labels_if_missing:false){ id } }`, variables: v }),
    vars: ["i", "v"], columns: () => Object.values(LEDGER.col), itemBoards: () => [LEDGER.board],
  },
  // Active ↔ Released only.
  moveLedgerItem: {
    build: (v) => ({ query: `mutation($i:ID!,$g:String!){ move_item_to_group(item_id:$i, group_id:$g){ id } }`, variables: v }),
    vars: ["i", "g"], allowed: { g: Object.values(LEDGER.groups) }, itemBoards: () => [LEDGER.board],
  },
  createLedgerSubitems: {
    batch: true, parentBoards: [LEDGER.board], vars: ["p"], fields: ["n", "v"], columns: () => Object.values(LEDGER.subCol),
    build: ({ p, entries }) => {
      const r = aliased(entries, "$p:ID!", {
        decl: (k) => `$n${k}:String!, $v${k}:JSON!`,
        body: (k) => `create_subitem(parent_item_id:$p, item_name:$n${k}, column_values:$v${k}, create_labels_if_missing:false)`,
        vars: (k, e) => ({ [`n${k}`]: e.n, [`v${k}`]: e.v }),
      });
      return { query: r.query, variables: { p, ...r.variables } };
    },
  },
  // Subitems someone already deleted in monday are skipped by the server.
  deleteLedgerSubitems: {
    batch: true, fields: ["i"], itemBoards: () => [LEDGER.sub], skipGone: true,
    build: ({ entries }) => aliased(entries, "", {
      decl: (k) => `$i${k}:ID!`,
      body: (k) => `delete_item(item_id:$i${k})`,
      vars: (k, e) => ({ [`i${k}`]: e.i }),
    }),
  },
  // A source record kept from the previous allocation of the line, rewritten in place (Allocate, 2026-10-13):
  // updating it is ~0.7 s against ~3.7 s for deleting it and creating it again.
  rewriteLedgerSubitems: {
    batch: true, fields: ["i", "v"], columns: () => ["name", ...Object.values(LEDGER.subCol)], itemBoards: () => [LEDGER.sub],
    build: ({ entries }) => aliased(entries, "", {
      decl: (k) => `$i${k}:ID!, $v${k}:JSON!`,
      body: (k) => `change_multiple_column_values(board_id:${LEDGER.sub}, item_id:$i${k}, column_values:$v${k}, create_labels_if_missing:false)`,
      vars: (k, e) => ({ [`i${k}`]: e.i, [`v${k}`]: e.v }),
    }),
  },
  // Status Allocation of Ledger items, in batches (daily check).
  setLedgerStatus: {
    batch: true, fields: ["i", "v"], columns: () => [LEDGER.col.status], itemBoards: () => [LEDGER.board],
    build: ({ entries }) => aliased(entries, "", {
      decl: (k) => `$i${k}:ID!, $v${k}:JSON!`,
      body: (k) => `change_multiple_column_values(board_id:${LEDGER.board}, item_id:$i${k}, column_values:$v${k}, create_labels_if_missing:false)`,
      vars: (k, e) => ({ [`i${k}`]: e.i, [`v${k}`]: e.v }),
    }),
  },
  // Arrival Status of Ledger subitems (daily check).
  updateLedgerSubitems: {
    batch: true, fields: ["i", "v"], columns: () => [LEDGER.subCol.arrival], itemBoards: () => [LEDGER.sub],
    build: ({ entries }) => aliased(entries, "", {
      decl: (k) => `$i${k}:ID!, $v${k}:JSON!`,
      body: (k) => `change_multiple_column_values(board_id:${LEDGER.sub}, item_id:$i${k}, column_values:$v${k}, create_labels_if_missing:false)`,
      vars: (k, e) => ({ [`i${k}`]: e.i, [`v${k}`]: e.v }),
    }),
  },
  // Status of In-Transit subitems (container lines used by a sale): Arrived – Pending Receiving / Received.
  setTransitLines: {
    batch: true, fields: ["i", "v"], columns: () => [TRANSIT_LINES.col], itemBoards: () => [TRANSIT_LINES.board],
    build: ({ entries }) => aliased(entries, "", {
      decl: (k) => `$i${k}:ID!, $v${k}:JSON!`,
      body: (k) => `change_multiple_column_values(board_id:${TRANSIT_LINES.board}, item_id:$i${k}, column_values:$v${k}, create_labels_if_missing:false)`,
      vars: (k, e) => ({ [`i${k}`]: e.i, [`v${k}`]: e.v }),
    }),
  },
  // Connect sale lines (target "line": Wholesale subitem; "ledger": Allocation Ledger item) to their shipments,
  // or (target "ledgerLine") a Wholesale subitem to its Allocation Ledger item, or write (target "baseline")
  // its Last Fulfilled Processed.
  linkLines: {
    batch: true, fields: ["target", "i", "v"], columns: (e) => LINK_TARGET[e.target]?.columns || [], itemBoards: (e) => [LINK_TARGET[e.target]?.board],
    build: ({ entries }) => aliased(entries, "", {
      decl: (k) => `$i${k}:ID!, $v${k}:JSON!`,
      body: (k, e) => `change_multiple_column_values(board_id:${LINK_TARGET[e.target].board}, item_id:$i${k}, column_values:$v${k})`,
      vars: (k, e) => ({ [`i${k}`]: e.i, [`v${k}`]: e.v }),
    }),
  },
};

const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v || {});
const badColumns = (values, allowed) => Object.keys(parse(values)).filter((k) => !allowed.includes(k));

// Static checks: known operation, required variables, batch size, and only allowed column ids.
export function checkWrite(op, variables = {}) {
  const def = WRITE_OPS[op];
  if (!def) throw new Error(`Unknown write operation "${op}".`);
  for (const k of def.vars || []) if (variables[k] === undefined || variables[k] === null || variables[k] === "") throw new Error(`Missing "${k}" for ${op}.`);
  for (const [k, ok] of Object.entries(def.allowed || {})) if (!ok.includes(variables[k])) throw new Error(`${op}: "${variables[k]}" is not allowed for "${k}".`);
  if (def.batch) {
    const entries = variables.entries;
    if (!Array.isArray(entries) || !entries.length) throw new Error(`${op} needs at least one entry.`);
    if (entries.length > BATCH_SIZE) throw new Error(`${op}: at most ${BATCH_SIZE} entries per request.`);
    for (const e of entries) {
      for (const f of def.fields) if (e?.[f] === undefined || e?.[f] === null || e?.[f] === "") throw new Error(`Missing "${f}" in an entry of ${op}.`);
      if (def.columns && e.v !== undefined) {
        const bad = badColumns(e.v, def.columns(e));
        if (bad.length) throw new Error(`${op} cannot write column(s): ${bad.join(", ")}.`);
      }
      if (op === "linkLines" && !LINK_TARGET[e.target]) throw new Error(`linkLines: unknown target "${e.target}".`);
    }
  } else if (def.columns && variables.v !== undefined) {
    const bad = badColumns(variables.v, def.columns());
    if (bad.length) throw new Error(`${op} cannot write column(s): ${bad.join(", ")}.`);
  }
  return def;
}

// ── Several operations in ONE request, in steps (2026-10-13) ──
// Allocate and Save used to send one request per operation, and monday runs the changes of one request one after
// the other (create_subitem ≈ 1.4 s, delete_item ≈ 2.3 s each). Now the browser sends every operation at once as
// steps: [[op, …], …]. The operations of a step don't depend on each other, so the server sends each of their
// changes to monday at the same time (up to WRITE_CONCURRENCY); the steps run one after the other and stop at the
// first failure, so an order like "old subitems out, new ones in, then the columns" still holds.
export const MAX_STEP_CHANGES = 150;
export const WRITE_CONCURRENCY = 8;

export const changesOf = (op, variables) => (WRITE_OPS[op].batch ? variables.entries.length : 1);

// Static checks of every operation, and the size of the whole request.
export function checkSteps(steps) {
  if (!Array.isArray(steps) || !steps.length || steps.some((st) => !Array.isArray(st) || !st.length)) throw new Error("No write operations.");
  const defs = steps.map((st) => st.map(({ op, variables }) => checkWrite(op, variables)));
  const changes = steps.flat().reduce((a, { op, variables }) => a + changesOf(op, variables), 0);
  if (changes > MAX_STEP_CHANGES) throw new Error(`At most ${MAX_STEP_CHANGES} changes per request.`);
  return defs;
}

// Runs steps of operations (null operations are skipped): in one request when the transport can (write.many), else
// one operation after the other. Returns the data of each operation, in the same shape as steps (undefined for a
// skipped one). A request carries at most MAX_STEP_CHANGES changes: more go in further requests, in order (a step
// that big is split; its operations don't depend on each other).
// Read back (2026-10-14): the server reads again, by id, the records each request changed (and opts.read: more ids
// to read with the last one, e.g. { lines: [Wholesale subitem ids] }) and answers them; onRead gets the list of
// those reads, in order — or null if any request answered none (one operation at a time, or the read failed): then
// the caller keeps its own copy and those parts are read again on the next load.
export async function runSteps(write, steps, { read, onRead } = {}) {
  const clean = steps.map((st) => (st || []).filter(Boolean));
  const res = clean.map((st) => new Array(st.length));
  const reads = [];
  if (typeof write.many === "function") {
    const pieces = []; // { i: step, idx: [operation indexes] }
    clean.forEach((st, i) => {
      let cur = [], size = 0;
      st.forEach((o, j) => {
        const n = changesOf(o.op, o.variables);
        if (cur.length && size + n > MAX_STEP_CHANGES) { pieces.push({ i, idx: cur }); cur = []; size = 0; }
        cur.push(j); size += n;
      });
      if (cur.length) pieces.push({ i, idx: cur });
    });
    let req = [], size = 0;
    const flush = async (last) => {
      if (!req.length) return;
      let got = null;
      const data = await write.many(req.map((pc) => pc.idx.map((j) => clean[pc.i][j])), { read: last ? read : undefined, onRead: (r) => { got = r; } });
      reads.push(got || null);
      req.forEach((pc, r) => pc.idx.forEach((j, q) => { res[pc.i][j] = data[r][q]; }));
      req = []; size = 0;
    };
    for (const pc of pieces) {
      const n = pc.idx.reduce((a, j) => a + changesOf(clean[pc.i][j].op, clean[pc.i][j].variables), 0);
      if (req.length && size + n > MAX_STEP_CHANGES) await flush(false);
      req.push(pc); size += n;
    }
    await flush(true);
  } else {
    for (const [i, st] of clean.entries()) for (const [j, { op, variables }] of st.entries()) res[i][j] = await write(op, variables);
  }
  onRead?.(reads.length && !reads.includes(null) ? reads : null);
  return steps.map((st, i) => { let j = 0; return (st || []).map((o) => (o ? res[i][j++] : undefined)); });
}

// Ids returned by a batch, in entry order (e0, e1, …).
export const batchIds = (data, n) => Array.from({ length: n }, (_, k) => (data?.[`e${k}`]?.id ? String(data[`e${k}`].id) : null));

export const chunks = (arr, size = BATCH_SIZE) => Array.from({ length: Math.ceil(arr.length / size) }, (_, k) => arr.slice(k * size, k * size + size));

// Browser transport for writes (local / Vercel): the server re-checks and holds the token.
export async function fetchWrite(op, variables) {
  checkWrite(op, variables);
  const { authHeaders, NotAuthorizedError, reportDenied } = await import("./auth.js");
  const res = await fetch("/api/monday-write", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ op, variables }),
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

// Steps of operations in one request (see runSteps): returns the data of each operation, in the same shape.
// read: more records to read back; onRead(read) gets what the server read again after the writes (null: none).
fetchWrite.many = async function fetchSteps(steps, { read, onRead } = {}) {
  checkSteps(steps);
  const { authHeaders, NotAuthorizedError, reportDenied } = await import("./auth.js");
  const res = await fetch("/api/monday-write", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify({ steps, ...(read ? { read } : {}) }),
  });
  if (res.status === 401) {
    reportDenied();
    throw new NotAuthorizedError();
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(body.error || body.errors?.[0]?.message || `HTTP ${res.status}`);
  if (Array.isArray(body.errors) && body.errors.length) throw new Error(body.errors.map((e) => e.message).join(" | "));
  onRead?.(body.read || null);
  return body.data;
};
