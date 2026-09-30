// Server-side writes to monday.com, only for authenticated, whitelisted users (see _auth.js).
// Only the operations in src/lib/mondayWrites.js are accepted, only on their boards and columns;
// items to update or delete are checked to belong to the allowed board first.
// When a sale line is connected to its shipments, the user who saved is added to the line's
// "People" column (who edited the shipments of that line; several people can be listed).

import { guarded, serverMonday } from "./_auth.js";
import { WRITE_OPS, checkWrite } from "../src/lib/mondayWrites.js";
import { LINE_PEOPLE_COLUMN } from "../src/lib/access.js";

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export const POST = guarded(async (request, { user }) => {
  let payload;
  try {
    payload = JSON.parse(await request.text());
  } catch {
    return json(400, { error: "Body must be JSON: { op, variables }." });
  }
  const { op } = payload || {};
  let variables = payload?.variables || {};
  let def;
  try {
    def = checkWrite(op, variables);
  } catch (e) {
    return json(400, { error: e.message });
  }

  // The item being changed (or the parent of a new subitem) must be on one of the allowed boards.
  const guard = def.itemBoards ? { id: variables.i, boards: def.itemBoards } : def.parentBoards ? { id: variables.p, boards: def.parentBoards } : null;
  let current = null;
  if (guard) {
    const check = await serverMonday(
      `query($i:[ID!]){ items(ids:$i){ id board { id } column_values(ids:["${LINE_PEOPLE_COLUMN}"]) { id value } } }`,
      { i: [String(guard.id)] },
    ).catch(() => null);
    current = check?.items?.[0];
    const board = current?.board?.id;
    if (!board || !guard.boards.includes(String(board))) return json(403, { error: `Item ${guard.id} is not on an allowed board for ${op}.` });
  }

  // Add the signed-in user to the sale line's People column (keeping whoever is already there).
  if (op === "linkWholesaleLine") {
    let people = [];
    try {
      people = JSON.parse(current?.column_values?.[0]?.value || "{}")?.personsAndTeams || [];
    } catch {
      people = [];
    }
    if (!people.some((p) => p.kind === "person" && String(p.id) === user.userId)) people.push({ id: Number(user.userId), kind: "person" });
    const values = { ...JSON.parse(variables.v), [LINE_PEOPLE_COLUMN]: { personsAndTeams: people } };
    variables = { ...variables, v: JSON.stringify(values) };
  }

  try {
    const res = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: process.env.MONDAY_TOKEN },
      body: JSON.stringify({ query: WRITE_OPS[op].query, variables }),
    });
    return json(200, await res.json());
  } catch (error) {
    return json(502, { error: `Could not reach monday.com: ${error?.message || error}` });
  }
});

export function GET() {
  return json(405, { error: "Use POST." });
}
