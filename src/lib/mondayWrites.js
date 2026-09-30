// Every write the app can make to monday.com (step 4: shipments). Shared by the browser and the
// server: the server (api/monday-write.js) only runs these operations, on these boards and columns.
// In monday Vibe the same queries go through monday.api(query, { variables }) after checkWrite().

export const NS = {
  board: "18433404829", // 🔗 New Shipments - Monday Vibe — item = one shipment
  sub: "18433458521", // its subitems — one SKU line of the shipment
  group: "topics",
  col: { order: "board_relation_mm7pc3qe", name: "text_mm7pj5nc", date: "date4", units: "numeric_mm7p9jrf", orderToShip: "numeric_mm7pvjrx", saved: "date_mm7p655r" },
  subCol: { sku: "text_mm7pzh4y", qty: "numeric_mm7p9w92", allocated: "numeric_mm7p8qnb", remaining: "numeric_mm7p2wg0", line: "text_mm7pp7c6", split: "text_mm7p4b6" },
};
// Connections to the shipments of a sale line.
export const SHIPMENT_LINKS = {
  wholesaleSub: { board: "18402982973", col: "board_relation_mm7pd15e" }, // Wholesale subitem → its shipments
  ledger: { board: "18430965833", col: "board_relation_mm7p81dk" }, // Allocation Ledger item → its shipments
};

const cmcv = (board) => `mutation($i:ID!,$v:JSON!){ change_multiple_column_values(board_id:${board}, item_id:$i, column_values:$v){ id } }`;

export const WRITE_OPS = {
  createShipment: {
    query: `mutation($n:String!,$v:JSON!){ create_item(board_id:${NS.board}, group_id:"${NS.group}", item_name:$n, column_values:$v){ id } }`,
    vars: ["n", "v"], columns: Object.values(NS.col),
  },
  updateShipment: { query: cmcv(NS.board), vars: ["i", "v"], columns: ["name", ...Object.values(NS.col)], itemBoards: [NS.board] },
  createShipmentLine: {
    query: `mutation($p:ID!,$n:String!,$v:JSON!){ create_subitem(parent_item_id:$p, item_name:$n, column_values:$v){ id } }`,
    vars: ["p", "n", "v"], columns: Object.values(NS.subCol), parentBoards: [NS.board],
  },
  updateShipmentLine: { query: cmcv(NS.sub), vars: ["i", "v"], columns: ["name", ...Object.values(NS.subCol)], itemBoards: [NS.sub] },
  deleteShipmentItem: { query: `mutation($i:ID!){ delete_item(item_id:$i){ id } }`, vars: ["i"], itemBoards: [NS.board, NS.sub] },
  linkWholesaleLine: { query: cmcv(SHIPMENT_LINKS.wholesaleSub.board), vars: ["i", "v"], columns: [SHIPMENT_LINKS.wholesaleSub.col], itemBoards: [SHIPMENT_LINKS.wholesaleSub.board] },
  linkLedgerItem: { query: cmcv(SHIPMENT_LINKS.ledger.board), vars: ["i", "v"], columns: [SHIPMENT_LINKS.ledger.col], itemBoards: [SHIPMENT_LINKS.ledger.board] },
};

// Static checks: known operation, required variables, and only allowed column ids in the values.
export function checkWrite(op, variables = {}) {
  const def = WRITE_OPS[op];
  if (!def) throw new Error(`Unknown write operation "${op}".`);
  for (const k of def.vars) if (variables[k] === undefined || variables[k] === null || variables[k] === "") throw new Error(`Missing "${k}" for ${op}.`);
  if (def.columns && variables.v !== undefined) {
    const values = typeof variables.v === "string" ? JSON.parse(variables.v) : variables.v;
    const bad = Object.keys(values).filter((k) => !def.columns.includes(k));
    if (bad.length) throw new Error(`${op} cannot write column(s): ${bad.join(", ")}.`);
  }
  return def;
}

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
