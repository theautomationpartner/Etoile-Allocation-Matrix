// Review (client, 2026-10-07) — what needs a decision, shown in the app and mailed every morning by Make.
// Pure function over the engine model. Cases are left in view on purpose: nothing is fixed automatically.
//
//   over     a line holds more than it still has to ship (Cin7 shipped, or the order was lowered) → Release
//   source   a source has more units reserved than it holds (e.g. warehouse stock used for something else)
//   notDone  a container's PO already shows the units arrived, but its Packing List is not Done
//   late     a container with reservations is past its ETA and not Done yet
import { SOURCE } from "./engine.js";
import { containerCode, orderParts } from "./matrix.js";
import { releasePlan } from "./allocation.js";
import { fmt } from "./format.js";
import { localToday } from "./shipments.js";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayMonth = (s) => (s ? `${Number(s.slice(8, 10))} ${MON[Number(s.slice(5, 7)) - 1]}` : "");

export function buildReview(model, data, { today = localToday() } = {}) {
  const out = [];
  const number = (o) => orderParts(o.name).number;
  const allContainers = new Map((data.containers || []).map((c) => [String(c.id), c]));

  // ── over ──
  for (const l of [...model.lines, ...(model.heldLines || [])]) {
    const plan = releasePlan(l);
    if (!plan) continue;
    const arrived = l.rawEntries.some((e) => e.stage === SOURCE.WAREHOUSE);
    const shipped = l.shippedSince > 0
      ? ` Cin7 shipped ${fmt(l.shippedSince)} since the last review${arrived ? "." : ", and none of its sources has arrived yet: they may have come from somewhere else."}`
      : "";
    out.push({
      type: "over", key: `over|${l.lineId}`, orderId: String(l.orderId), lineId: String(l.lineId), sku: l.sku,
      title: `${number(l.order)} · ${l.sku}`,
      text: `${fmt(l.reservedRaw)} allocated, ${l.held ? "nothing left to ship (fully shipped)" : `${fmt(l.toShip)} left to ship`}.${shipped}`,
      action: `Release ${fmt(plan.units)}`,
      detail: plan.parts.map((p) => `${fmt(p.qty)} from ${p.title}`).join(" · "),
      units: plan.units,
    });
  }

  // ── source: more reserved than the source holds (before the caps) ──
  const bySource = new Map();
  for (const x of model.allLines) {
    for (const e of x.rawEntries || []) {
      const k = e.source === SOURCE.WAREHOUSE ? `warehouse||${x.sku}` : `${e.source}|${e.sourceId}|${x.sku}`;
      if (!bySource.has(k)) bySource.set(k, { e, sku: x.sku, reserved: 0, orders: new Set() });
      const s = bySource.get(k);
      s.reserved += e.qty;
      s.orders.add(number(x.order));
    }
  }
  for (const [k, s] of bySource) {
    const { e, sku } = s;
    const c = e.source === SOURCE.IN_TRANSIT ? allContainers.get(String(e.sourceId)) : null;
    const cap = e.source === SOURCE.WAREHOUSE ? model.whTotal(sku)
      : c ? model.containerTotal(c, sku)
        : (() => { const p = model.pos.find((x) => String(x.id) === String(e.sourceId)); return p ? model.poTotal(p, sku) : 0; })();
    if (s.reserved <= cap) continue;
    const name = e.source === SOURCE.WAREHOUSE ? "Warehouse" : c ? containerCode(c.name) : e.ref || String(e.sourceId);
    const has = e.source === SOURCE.WAREHOUSE ? "on hand (US qty)" : e.source === SOURCE.IN_TRANSIT ? "on board" : "still to ship from the supplier";
    out.push({
      type: "source", key: `source|${k}`, sku,
      title: `${sku} · ${name}`,
      text: `${fmt(s.reserved)} reserved, ${fmt(cap)} ${has}. Orders: ${[...s.orders].join(", ")}.`,
    });
  }

  // ── containers: arrived in the PO but not Done · late ──
  const held = new Map(); // container id → reserved units
  for (const x of model.allLines) for (const e of x.entries) if (e.source === SOURCE.IN_TRANSIT) held.set(String(e.sourceId), (held.get(String(e.sourceId)) || 0) + e.qty);
  const notDone = new Map();
  for (const x of model.allLines) for (const e of x.entries) if (e.notDone) (notDone.get(String(e.sourceId)) || notDone.set(String(e.sourceId), new Set()).get(String(e.sourceId))).add(x.sku);
  for (const [id, skus] of notDone) {
    const c = allContainers.get(id);
    out.push({
      type: "notDone", key: `notDone|${id}`, containerId: id,
      title: `${containerCode(c?.name || id)}`,
      text: `The PO already shows ${[...skus].join(", ")} arrived, but the packing list is ${c?.packingList || "not Done"}. Mark it Done when it is received.`,
    });
  }
  for (const c of model.containers) {
    if (!c.eta || c.eta >= today || !held.get(String(c.id)) || notDone.has(String(c.id))) continue;
    out.push({
      type: "late", key: `late|${c.id}`, containerId: String(c.id),
      title: containerCode(c.name),
      text: `Should have arrived on ${dayMonth(c.eta)} and the packing list is still ${c.packingList || "not Done"}. ${fmt(held.get(String(c.id)))} units are allocated on it.`,
    });
  }
  return out;
}

export const REVIEW_TYPES = {
  over: "Allocated above what is left to ship",
  source: "More reserved than the source holds",
  notDone: "Arrived in the PO, packing list not Done",
  late: "Past its ETA, not Done",
};

// What each case means and what to do, for the mail.
const MAIL_HINT = {
  over: "Cin7 shipped units, or the order was lowered: these lines hold more than they still have to ship. Open the app and click Release on each line.",
  source: "A source has more units reserved than it holds (for example, warehouse stock used for something else). Review those orders.",
  notDone: "The PO already shows the units arrived, but the container's packing list is not Done. Mark it Done in In-Transit Shipments.",
  late: "These containers hold reservations, are past their ETA and are not Done yet. Mark them Done when they land.",
};
const TONE = { over: "#AF3328", source: "#8F640E", notDone: "#2A5AA8", late: "#585F6B" };
export const APP_LINK = "https://etoile8.monday.com/custom_objects/18433465002";

// The morning mail (Make sends it with its Gmail connection): { subject, text, html }.
//   at: when the check ran · writes: what the check updated in monday · dryRun: nothing was written
export function reviewMail(items, { appUrl = APP_LINK, at = new Date(), writes = null, dryRun = false } = {}) {
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const groups = Object.entries(REVIEW_TYPES).map(([type, label]) => ({ type, label, items: items.filter((i) => i.type === type) })).filter((g) => g.items.length);
  const when = new Date(at).toLocaleString("en-US", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) + " UTC";
  const n = items.length;
  const subject = `${dryRun ? "[Test] " : ""}Allocation Matrix · ${n ? `${n} ${n === 1 ? "item needs" : "items need"} review` : "nothing to review"}`;
  const updated = writes ? Object.values(writes).reduce((a, b) => a + (b || 0), 0) : 0;

  const text = [
    `Allocation Matrix — daily review (${when})${dryRun ? " — TEST RUN, nothing was written" : ""}`,
    n ? `${n} ${n === 1 ? "item needs" : "items need"} review.` : "Nothing needs review today.",
    ...groups.map((g) => `\n${g.label} (${g.items.length})\n${MAIL_HINT[g.type]}\n${g.items.map((i) => `- ${i.title}: ${i.text}${i.action ? ` → ${i.action}: ${i.detail}` : ""}`).join("\n")}`),
    `\nOpen the Allocation Matrix: ${appUrl}`,
  ].join("\n");

  const font = "font-family:'Instrument Sans',Segoe UI,Helvetica,Arial,sans-serif";
  const tiles = Object.entries(REVIEW_TYPES).map(([type, label]) => {
    const c = items.filter((i) => i.type === type).length;
    return `<td width="25%" style="padding:6px" valign="top"><div style="border:1px solid #E2E5EA;border-top:3px solid ${c ? TONE[type] : "#E2E5EA"};border-radius:6px;padding:10px 12px;background:#FFFFFF">
      <div style="${font};font-size:22px;font-weight:700;color:${c ? "#15171C" : "#8B929C"}">${c}</div>
      <div style="${font};font-size:11.5px;line-height:15px;color:#585F6B">${esc(label)}</div></div></td>`;
  }).join("");
  const section = (g) => `
    <tr><td style="padding:22px 28px 0">
      <div style="${font};font-size:15px;font-weight:700;color:#15171C;border-left:3px solid ${TONE[g.type]};padding-left:10px">${esc(g.label)} <span style="color:#8B929C;font-weight:600">· ${g.items.length}</span></div>
      <div style="${font};font-size:12.5px;color:#585F6B;margin:6px 0 10px 13px">${esc(MAIL_HINT[g.type])}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #E2E5EA;border-radius:6px">
        ${g.items.map((i, k) => `<tr style="background:${k % 2 ? "#FAFBFC" : "#FFFFFF"}">
          <td style="${font};font-size:12.5px;font-weight:700;color:#15171C;padding:9px 12px;border-top:${k ? "1px solid #EDEFF3" : "0"};white-space:nowrap" valign="top">${esc(i.title)}</td>
          <td style="${font};font-size:12.5px;color:#585F6B;padding:9px 12px;border-top:${k ? "1px solid #EDEFF3" : "0"}" valign="top">${esc(i.text)}${i.action
            ? `<div style="margin-top:4px;color:#15171C"><b>${esc(i.action)}</b> <span style="color:#8B929C">— ${esc(i.detail)}</span></div>` : ""}</td>
        </tr>`).join("")}
      </table>
    </td></tr>`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#F2F3F6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F3F6"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:#FFFFFF;border:1px solid #E2E5EA;border-radius:8px;overflow:hidden">
  <tr><td style="background:#15171C;padding:20px 28px">
    <div style="${font};font-size:18px;font-weight:700;color:#FFFFFF">Etoile Flow</div>
    <div style="${font};font-size:12.5px;color:#9CA3AE;margin-top:2px">Allocation Matrix · Daily review · ${esc(when)}</div>
  </td></tr>
  ${dryRun ? `<tr><td style="background:#F8F0DC;padding:10px 28px;${font};font-size:12.5px;color:#8F640E"><b>Test run</b> — nothing was written to monday.</td></tr>` : ""}
  <tr><td style="padding:22px 28px 4px">
    <div style="${font};font-size:16px;font-weight:700;color:#15171C">${n ? `${n} ${n === 1 ? "item needs" : "items need"} your review` : "Nothing needs review today"}</div>
    <div style="${font};font-size:13px;color:#585F6B;margin-top:4px">${n
      ? "Nothing is changed automatically: each case is decided in the Allocation Matrix."
      : "Every allocation matches what is left to ship, and every source holds what is reserved on it."}</div>
  </td></tr>
  <tr><td style="padding:10px 22px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${tiles}</tr></table></td></tr>
  ${groups.map(section).join("")}
  <tr><td align="center" style="padding:26px 28px 8px">
    <a href="${esc(appUrl)}" style="${font};display:inline-block;background:#15171C;color:#FFFFFF;text-decoration:none;font-size:13.5px;font-weight:600;padding:11px 22px;border-radius:6px">Open the Allocation Matrix</a>
  </td></tr>
  <tr><td style="padding:14px 28px 22px;${font};font-size:11.5px;line-height:17px;color:#8B929C;border-top:1px solid #EDEFF3">
    Sent automatically after the Cin7 → monday sync.${writes ? ` ${updated ? `${updated} monday ${updated === 1 ? "value was" : "values were"} brought up to date (allocation status, arrival status, PO reservations moved to their container, shipped baseline).` : "monday was already up to date."}` : ""}
  </td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}
