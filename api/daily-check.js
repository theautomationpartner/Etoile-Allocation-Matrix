// Daily check (client, 2026-10-07) — called by Make after the morning Cin7 → monday sync. It never decides for
// the user: it keeps the Ledger in step with what already happened and returns what needs review, so Make can
// mail it with its Gmail connection.
//
//   POST /api/daily-check            header x-daily-secret: <DAILY_CHECK_SECRET>   → writes + review
//   POST /api/daily-check?dry=1      same, nothing written (shows what would be written)
//
// Writes (only where something changes):
//   1. Last Fulfilled Processed of Wholesale subitems (open orders) with an empty column: the Ledger's
//      Qty Fulfilled (what was reviewed when the line was allocated). Never the current figure: what Cin7
//      shipped since stays to review.
//   2. A PO reservation whose units were loaded on a container follows them (engine pass 0): the line's
//      Ledger record is rewritten with the same quantities on the container.
//   3. Status Allocation of each Ledger item (Allocated / Partially Allocated / Over Allocated / Released).
//   4. Arrival Status of each Ledger subitem.
//   5. In-Transit Status of the container lines used by a sale (Arrived – Pending Receiving / Received).
// Response: { ok, dryRun, at, writes, hasItems, count, items, subject, text, html, webhook }
// At the end the same report is POSTed to the webhook in SALE_REPORT_GMAIL (Make sends it with Gmail).
//
// Env: MONDAY_TOKEN, DAILY_CHECK_SECRET (any long random text, also typed in Make), SALE_REPORT_GMAIL (webhook URL),
// APP_URL (optional; default: the app in monday).
import { createHash, timingSafeEqual } from "node:crypto";
import { createMondayApi } from "../src/lib/monday.js";
import { buildModel, SOURCE } from "../src/lib/engine.js";
import { BASELINE, LEDGER, WRITE_OPS, checkWrite, chunks } from "../src/lib/mondayWrites.js";
import { allocationStatus, ledgerRecord } from "../src/lib/allocation.js";
import { arrivalIndex, arrivalLabel } from "../src/lib/arrival.js";
import { transitUpdates, writeLedgerLine, writeTransitLines } from "../src/lib/allocationSync.js";
import { APP_LINK, buildReview, reviewMail } from "../src/lib/review.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const digest = (s) => createHash("sha256").update(String(s)).digest();
const sameSecret = (a, b) => Boolean(a && b) && timingSafeEqual(digest(a), digest(b));

async function monday(query, variables = {}) {
  const headers = { "Content-Type": "application/json", Authorization: process.env.MONDAY_TOKEN };
  if (process.env.MONDAY_API_VERSION) headers["API-Version"] = process.env.MONDAY_API_VERSION;
  const res = await fetch("https://api.monday.com/v2", { method: "POST", headers, body: JSON.stringify({ query, variables }) });
  const body = await res.json().catch(() => ({ errors: [{ message: `monday.com answered HTTP ${res.status}` }] }));
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join(" | "));
  return body.data;
}

// The same operations the app uses (mondayWrites.js), checked the same way; items already deleted are skipped.
function serverWrite(log) {
  return async (op, variables) => {
    const def = checkWrite(op, variables);
    let vars = variables;
    if (def.skipGone) {
      const d = await monday(`query($i:[ID!]){ items(ids:$i, limit:100){ id state } }`, { i: variables.entries.map((e) => String(e.i)) });
      const live = new Set((d?.items || []).filter((it) => it.state !== "deleted").map((it) => String(it.id)));
      vars = { ...variables, entries: variables.entries.filter((e) => live.has(String(e.i))) };
      if (!vars.entries.length) return {};
    }
    log.push(op);
    const { query, variables: v } = WRITE_OPS[op].build(vars);
    return monday(query, v);
  };
}

export async function POST(request) {
  if (!process.env.MONDAY_TOKEN || !process.env.DAILY_CHECK_SECRET) return json(500, { error: "Server not configured (MONDAY_TOKEN / DAILY_CHECK_SECRET)." });
  if (!sameSecret(request.headers.get("x-daily-secret"), process.env.DAILY_CHECK_SECRET)) return json(401, { error: "Not authorized." });
  const dryRun = new URL(request.url).searchParams.get("dry") === "1";
  const appUrl = process.env.APP_URL || APP_LINK;
  const at = new Date().toISOString();
  const log = [];
  const planned = { baseline: 0, followed: 0, status: 0, arrival: 0, transit: 0 };
  // Dry run: nothing is sent; created items get placeholder ids so the plan can run to the end.
  const dryWrite = async (op, v) => {
    checkWrite(op, v);
    log.push(op);
    if (op === "createLedgerItem") return { create_item: { id: "0" } };
    if (op === "createLedgerSubitems") return Object.fromEntries(v.entries.map((_, k) => [`e${k}`, { id: "0" }]));
    return {};
  };
  const write = dryRun ? dryWrite : serverWrite(log);

  try {
    const api = createMondayApi(monday);
    const data = await api.loadMatrixData();
    const model = buildModel(data);
    const where = { containerById: new Map(data.containers.map((c) => [String(c.id), c])), ix: arrivalIndex(data.containers, data.pos) };

    // 1 — Last Fulfilled Processed where it is still empty (every line of the open orders; a new line from
    // Make gets it on the next run).
    const baseline = [];
    for (const x of model.allLines) {
      if (x.line.lastProcessed !== null && x.line.lastProcessed !== undefined) continue;
      baseline.push({ target: "baseline", i: String(x.line.id), v: JSON.stringify({ [BASELINE.col]: String(x.line.ledgerFulfilled ?? x.line.fulfilled ?? 0) }) });
    }
    planned.baseline = baseline.length;
    for (const part of chunks(baseline)) await write("linkLines", { entries: part });

    // 2 — PO reservations that follow their units onto a container: the line's record is rewritten.
    const rewritten = new Set();
    for (const x of model.allLines) {
      if (!x.followed || !x.line.ledgerItemId) continue;
      const entries = x.rawEntries.map((e) => ({
        source: e.source, sourceId: String(e.sourceId), ref: e.ref || "", qty: e.qty,
        ...(e.source !== SOURCE.WAREHOUSE && e.eta ? { eta: e.eta } : {}),
        ...(e.source === SOURCE.IN_TRANSIT ? { packingDone: where.containerById.get(String(e.sourceId))?.packingList === "Done" } : {}),
      }));
      // Qty Fulfilled of the record stays the reviewed figure: what Cin7 shipped since is still to review.
      const raw = { ...x.line, fulfilled: x.line.lastProcessed ?? x.line.ledgerFulfilled ?? x.line.fulfilled };
      const rec = ledgerRecord({ order: x.order, raw, sku: x.sku, entries, data });
      await writeLedgerLine(write, api, { lineId: x.line.id, linkId: x.line.ledgerLinkId, rec, empty: !entries.length });
      rewritten.add(String(x.line.ledgerItemId));
      planned.followed++;
    }

    // 3, 4 — Status Allocation and Arrival Status of the other Ledger records.
    const status = [], arrival = [];
    for (const x of model.allLines) {
      const id = x.line.ledgerItemId;
      if (!id || rewritten.has(String(id))) continue;
      const label = allocationStatus(x.reservedRaw, x.toShip);
      if (x.line.ledgerStatus !== label) status.push({ i: String(id), label });
      for (const e of x.line.entries || []) {
        if (!e.subitemId) continue;
        const alive = x.rawEntries.some((r) => r.source === e.source && String(r.sourceId) === String(e.sourceId));
        if (!alive) continue; // a source that no longer exists keeps its last label
        const want = arrivalLabel(e, x.sku, where);
        if (e.arrivalLabel !== want) arrival.push({ i: e.subitemId, v: JSON.stringify({ [LEDGER.subCol.arrival]: { label: want } }) });
      }
    }
    planned.status = status.length;
    planned.arrival = arrival.length;
    for (const part of chunks(status)) await write("setLedgerStatus", { entries: part.map((s) => ({ i: s.i, v: JSON.stringify({ [LEDGER.col.status]: { label: s.label } }) })) });
    for (const part of chunks(arrival)) await write("updateLedgerSubitems", { entries: part });

    // 5 — In-Transit Status of the container lines that hold reservations.
    const used = [];
    for (const x of model.allLines) for (const e of x.rawEntries) if (e.source === SOURCE.IN_TRANSIT) used.push({ sourceId: e.sourceId, sku: x.sku });
    const transit = transitUpdates(data, used);
    planned.transit = transit.length;
    await writeTransitLines(write, transit);

    const items = buildReview(model, data);
    const mail = reviewMail(items, { appUrl, at, writes: dryRun ? null : planned, dryRun });
    const body = { ok: true, dryRun, at, writes: planned, requests: log.length, hasItems: items.length > 0, count: items.length, appUrl, ...mail, items };
    body.webhook = await notify(body);
    return json(200, body);
  } catch (error) {
    console.error("[daily-check]", error);
    const body = { ok: false, dryRun, at, writes: planned, requests: log.length, error: String(error?.message || error), appUrl, ...failedMail(error, at, appUrl) };
    body.webhook = await notify(body);
    return json(500, body);
  }
}

// The report goes to the webhook in SALE_REPORT_GMAIL (Make → Gmail): { ok, dryRun, at, hasItems, count,
// subject, html, text, appUrl, writes, items }. Sent on every run, also when nothing needs review or it failed.
async function notify(body) {
  const url = process.env.SALE_REPORT_GMAIL || process.env.SALE_REPORT_GMAIl;
  if (!url) return "not configured";
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return res.ok ? "sent" : `HTTP ${res.status}`;
  } catch (e) {
    return `failed: ${e?.message || e}`;
  }
}

function failedMail(error, at, appUrl) {
  const msg = String(error?.message || error).replace(/</g, "&lt;");
  return {
    hasItems: false, count: 0,
    subject: "Allocation Matrix · daily review failed",
    text: `The daily review could not run (${at}): ${error?.message || error}`,
    html: `<div style="font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:13px;color:#15171C"><p><b>The daily review could not run.</b></p><p style="color:#585F6B">${msg}</p><p>Nothing was changed after the error. <a href="${appUrl}">Open the Allocation Matrix</a></p></div>`,
  };
}

export function GET() {
  return json(405, { error: "Use POST." });
}
