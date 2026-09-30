// Server-side read proxy to the monday.com GraphQL API.
// Only for authenticated, whitelisted users (see _auth.js). The API token lives only on the server.

import { guarded } from "./_auth.js";

const MONDAY_URL = "https://api.monday.com/v2";
const MAX_BODY_BYTES = 64 * 1024;

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

// Strips string literals and comments so the operation check only sees GraphQL keywords.
const stripNoise = (q) => q.replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|#[^\n]*/g, " ");
const isMutation = (q) => /(^|[\s{}])(mutation|subscription)\b/i.test(stripNoise(q));

export const POST = guarded(async (request) => {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: "Request too large." });

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json(400, { error: "Body must be JSON: { query, variables }." });
  }
  const { query, variables = {} } = payload || {};
  if (typeof query !== "string" || !query.trim()) return json(400, { error: "Missing GraphQL query." });
  if (isMutation(query)) return json(403, { error: "Only read queries are allowed on this endpoint." });

  const headers = { "Content-Type": "application/json", Authorization: process.env.MONDAY_TOKEN };
  if (process.env.MONDAY_API_VERSION) headers["API-Version"] = process.env.MONDAY_API_VERSION;

  try {
    const res = await fetch(MONDAY_URL, { method: "POST", headers, body: JSON.stringify({ query, variables }) });
    const body = await res.json().catch(() => ({ errors: [{ message: `monday.com answered HTTP ${res.status}` }] }));
    return json(res.ok ? 200 : res.status, body);
  } catch (error) {
    return json(502, { error: `Could not reach monday.com: ${error?.message || error}` });
  }
});

export function GET() {
  return json(405, { error: "Use POST." });
}
