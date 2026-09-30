// Server-side writes to monday.com. Only the operations in src/lib/mondayWrites.js are accepted, only on
// their boards and columns; items to update or delete are checked to belong to the allowed board first.

import { WRITE_OPS, checkWrite } from "../src/lib/mondayWrites.js";

const MONDAY_URL = "https://api.monday.com/v2";

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function monday(query, variables, token) {
  const headers = { "Content-Type": "application/json", Authorization: token };
  if (process.env.MONDAY_API_VERSION) headers["API-Version"] = process.env.MONDAY_API_VERSION;
  const res = await fetch(MONDAY_URL, { method: "POST", headers, body: JSON.stringify({ query, variables }) });
  return res.json();
}

export async function POST(request) {
  const token = process.env.MONDAY_TOKEN;
  if (!token) return json(500, { error: "MONDAY_TOKEN is not configured on the server." });
  let payload;
  try {
    payload = JSON.parse(await request.text());
  } catch {
    return json(400, { error: "Body must be JSON: { op, variables }." });
  }
  const { op, variables = {} } = payload || {};
  let def;
  try {
    def = checkWrite(op, variables);
  } catch (e) {
    return json(400, { error: e.message });
  }

  // The item being changed (or the parent of a new subitem) must be on one of the allowed boards.
  const guard = def.itemBoards ? { id: variables.i, boards: def.itemBoards } : def.parentBoards ? { id: variables.p, boards: def.parentBoards } : null;
  if (guard) {
    const check = await monday(`query($i:[ID!]){ items(ids:$i){ id board { id } } }`, { i: [String(guard.id)] }, token);
    const board = check?.data?.items?.[0]?.board?.id;
    if (!board || !guard.boards.includes(String(board))) return json(403, { error: `Item ${guard.id} is not on an allowed board for ${op}.` });
  }

  try {
    const body = await monday(WRITE_OPS[op].query, variables, token);
    return json(200, body);
  } catch (error) {
    return json(502, { error: `Could not reach monday.com: ${error?.message || error}` });
  }
}

export function GET() {
  return json(405, { error: "Use POST." });
}
