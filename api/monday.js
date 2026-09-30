// Server-side proxy to the monday.com GraphQL API.
// The token lives only in the server environment (MONDAY_TOKEN); the browser never sees it.
// Read-only for now: the matrix only writes from step 3 (Allocation), with its own endpoint.

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

export async function POST(request) {
  const token = process.env.MONDAY_TOKEN;
  if (!token) return json(500, { error: "MONDAY_TOKEN is not configured on the server." });

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

  const headers = { "Content-Type": "application/json", Authorization: token };
  if (process.env.MONDAY_API_VERSION) headers["API-Version"] = process.env.MONDAY_API_VERSION;

  try {
    const res = await fetch(MONDAY_URL, { method: "POST", headers, body: JSON.stringify({ query, variables }) });
    const body = await res.json().catch(() => ({ errors: [{ message: `monday.com answered HTTP ${res.status}` }] }));
    return json(res.ok ? 200 : res.status, body);
  } catch (error) {
    return json(502, { error: `Could not reach monday.com: ${error?.message || error}` });
  }
}

export function GET() {
  return json(405, { error: "Use POST." });
}
