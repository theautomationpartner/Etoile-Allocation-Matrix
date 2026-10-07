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
  for (const l of model.lines) {
    const plan = releasePlan(l);
    if (!plan) continue;
    const arrived = l.rawEntries.some((e) => e.stage === SOURCE.WAREHOUSE);
    const shipped = l.shippedSince > 0
      ? ` Cin7 shipped ${fmt(l.shippedSince)} since the last review${arrived ? "." : ", and none of its sources has arrived yet: they may have come from somewhere else."}`
      : "";
    out.push({
      type: "over", key: `over|${l.lineId}`, orderId: String(l.orderId), lineId: String(l.lineId), sku: l.sku,
      title: `${number(l.order)} · ${l.sku}`,
      text: `${fmt(l.reservedRaw)} allocated, ${fmt(l.toShip)} left to ship.${shipped}`,
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

// Plain-text and HTML body for the morning mail (Make sends it with its Gmail connection).
export function reviewMail(items, { appUrl = "" } = {}) {
  const groups = Object.entries(REVIEW_TYPES).map(([type, label]) => ({ label, items: items.filter((i) => i.type === type) })).filter((g) => g.items.length);
  const subject = items.length ? `Allocation Matrix · ${items.length} ${items.length === 1 ? "thing needs" : "things need"} review` : "Allocation Matrix · nothing to review";
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const text = groups.map((g) => `${g.label} (${g.items.length})\n${g.items.map((i) => `- ${i.title}: ${i.text}${i.action ? ` [${i.action}: ${i.detail}]` : ""}`).join("\n")}`).join("\n\n")
    + (appUrl ? `\n\nOpen the Allocation Matrix to review: ${appUrl}` : "");
  const html = groups.map((g) => `<h3 style="margin:16px 0 6px;font:600 14px sans-serif">${esc(g.label)} (${g.items.length})</h3><ul style="margin:0;padding-left:18px;font:13px sans-serif">${
    g.items.map((i) => `<li style="margin:3px 0"><b>${esc(i.title)}</b> — ${esc(i.text)}${i.action ? ` <i>(${esc(i.action)}: ${esc(i.detail)})</i>` : ""}</li>`).join("")}</ul>`).join("")
    + (appUrl ? `<p style="font:13px sans-serif">Open the <a href="${esc(appUrl)}">Allocation Matrix</a> to review.</p>` : "");
  return { subject, text, html };
}
