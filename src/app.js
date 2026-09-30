// Etoile Flow — Allocation Matrix screen.
// Step 1 of 4: metrics + Show filters (functional). Controls, legend and the matrix frame are
// rendered as the skeleton that steps 2–4 (Sales/Sources, Allocation, Shipments) will fill in.

import { buildModel, FILTERS } from "./engine.js";
import { loadMatrixData } from "./monday.js";

/* ── formatting (§7.2) ── */
const fmt = (v) => (v || 0).toLocaleString("en-US");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const plural = (count, one, many) => `${fmt(count)} ${count === 1 ? one : many}`;
const clock = (d) => d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

/* ── state ── */
const state = {
  status: "loading", // loading | ready | error
  data: null,
  model: null,
  error: "",
  filter: "all", // §15.1: one filter at a time, kept when the view changes
  view: "order", // order | sku | source
};

const store = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode: keep working without it */ }
  },
};

/* ── navigation (only Allocation matrix is available in this phase) ── */
const ICONS = {
  grid: '<path d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9"/>',
  table: '<path d="M2 3h12v10H2zM2 6.5h12M6.5 6.5V13M10.5 6.5V13"/>',
  bag: '<path d="M3.5 5h9l-.8 9h-7.4zM6 5V3.6A2 2 0 0 1 10 3.6V5"/>',
  ship: '<path d="M2.5 10.5 3.6 7h8.8l1.1 3.5M4.8 7V4.3h6.4V7M2 12.8c1.2 0 1.2 1 2.4 1s1.2-1 2.4-1 1.2 1 2.4 1 1.2-1 2.4-1 1.2 1 2.4 1"/>',
  box: '<path d="M8 2 14 5v6l-6 3-6-3V5zM2 5l6 3 6-3M8 8v6"/>',
  tag: '<path d="M2.5 8.2V2.5H8.2L14 8.3 8.3 14z"/>',
  up: '<path d="M8 12V3M4.5 6.5 8 3l3.5 3.5M2.5 13.5h11"/>',
};
const PAGES = [
  { section: "OVERVIEW" },
  { id: "home", label: "Control center", icon: "grid" },
  { id: "matrix", label: "Allocation matrix", icon: "table", active: true },
  { section: "BOARDS" },
  { id: "wholesale", label: "Wholesale Allocation", icon: "bag" },
  { id: "transit", label: "In-Transit Shipments", icon: "ship" },
  { id: "po", label: "Purchase Orders", icon: "box" },
  { id: "sku", label: "Master SKU Inventory", icon: "tag" },
  { id: "importer", label: "In-Transit Importer", icon: "up" },
];
const icon = (k) => `<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>`;

function renderNav() {
  document.getElementById("nav").innerHTML = PAGES.map((p) => {
    if (p.section) return `<div class="nav-h">${p.section}</div>`;
    return p.active
      ? `<a class="nav-i on" href="#" aria-current="page" title="${p.label}">${icon(p.icon)}<span class="lb">${p.label}</span></a>`
      : `<span class="nav-i off" role="link" aria-disabled="true" title="${p.label} — not available yet">${icon(p.icon)}<span class="lb">${p.label}</span></span>`;
  }).join("");
}

/* ── metric cards (§4) ── */
function metricCards() {
  if (state.status !== "ready") {
    const card = (label) => `<div class="kpi" aria-busy="true"><div class="lab">${label}</div><div class="val"><span class="sk v"></span></div><div class="sub"><span class="sk s"></span></div></div>`;
    return `<div class="kpis">${["Units to allocate", "Impossible to cover", "Free inventory to draw on", "Already allocated"].map(card).join("")}</div>`;
  }
  const m = state.model.metrics;
  const f = state.filter;
  const filterCard = ({ key, label, value, sub, tone = "" }) => {
    const on = f === key;
    return `<button type="button" class="kpi ${tone} ${on ? "on" : ""}" data-filter="${key}" aria-pressed="${on}">
      <span class="lab">${label}</span><span class="val">${value}</span><span class="sub">${sub}</span>
      <span class="cta">${on ? "Showing these" : "Show these"} <span aria-hidden="true">→</span></span></button>`;
  };
  const split = m.allocatedSplit;
  return `<div class="kpis">
    ${filterCard({
      key: "pending",
      label: "Units to allocate",
      value: fmt(m.unitsToAllocate),
      sub: `${plural(m.linesWithLeft, "line item", "line items")} · ${fmt(m.draftUnits)} already proposed as draft`,
    })}
    ${filterCard({
      key: "blocked",
      label: "Impossible to cover",
      value: fmt(m.impossible),
      tone: m.impossible > 0 ? "warn" : "",
      sub: m.impossible > 0 ? `${plural(m.shortSkuCount, "SKU needs", "SKUs need")} a new purchase order` : "Nothing is blocked",
    })}
    <div class="kpi">
      <div class="lab">Free inventory to draw on</div><div class="val">${fmt(m.freeInventory)}</div>
      <div class="sub">on hand plus arriving, nobody has claimed it</div>
      <span class="cta soon" title="The In-Transit Shipments screen is not available yet">See where it sits <span aria-hidden="true">→</span></span>
    </div>
    <div class="kpi">
      <div class="lab">Already allocated</div><div class="val">${fmt(m.alreadyAllocated)}</div>
      <div class="sub">${fmt(split.onHand)} on hand · ${fmt(split.inTransit)} in transit · ${fmt(split.onOrder)} on order</div>
    </div>
  </div>`;
}

/* ── controls (§3) ── */
function controls() {
  const views = [["order", "Wholesale order"], ["sku", "SKU"], ["source", "Source of stock"]];
  const bar = `<div class="mx-bar">
    <span class="fl">View by</span>
    <span class="seg" role="group" aria-label="View by">
      ${views.map(([k, l]) => `<button type="button" data-view="${k}" aria-pressed="${state.view === k}">${l}</button>`).join("")}
    </span>
    <span class="spacer"></span>
    <button class="btn" type="button" disabled title="Available when the matrix rows are built">Expand all</button>
    <button class="btn" type="button" disabled title="Available when the matrix rows are built">Collapse all</button>
  </div>`;

  let note = "";
  if (state.status === "ready") {
    const rows = state.model.lines;
    const shown = rows.filter(FILTERS[state.filter].keep).length;
    note = state.filter === "all" ? `${plural(rows.length, "row", "rows")}` : `${fmt(shown)} of ${plural(rows.length, "row", "rows")} match`;
  }
  const chips = `<div class="fbar">
    <span class="fl">Show</span>
    ${Object.entries(FILTERS).map(([k, f]) => `<button type="button" class="fchip" data-chip="${k}" aria-pressed="${state.filter === k}">${f.label}</button>`).join("")}
    ${note ? `<span class="fnote">${note}</span>` : ""}
  </div>`;
  return bar + chips;
}

/* ── legend (§3, static; same colours as the cells) ── */
const legend = () => `<div class="mx-hint">
  <span class="k"><span class="sw wh">240</span> from warehouse</span>
  <span class="k"><span class="sw it">240</span> from a container</span>
  <span class="k"><span class="sw po">240</span> from a purchase order</span>
  <span class="k"><span class="sw dr">240</span> draft · proposed, not allocated</span>
  <span class="k"><span class="sw av">240</span> free, not assigned yet</span>
  <span class="k tip">Open a draft or a grey number, check it, then click <b>Allocate</b>.</span>
</div>`;

/* ── matrix frame (§5): fixed left block now; rows and source columns arrive in step 2 ── */
const HEAD = {
  order: { title: "Wholesale order", meta: "order · allocation · shipments", nums: ["To ship", "Allocated", "Left"], group: ["order", "orders"] },
  sku: { title: "SKU", meta: "grouped by product · orders inside", nums: ["Required", "Assigned", "Left"], group: ["product", "products"] },
  source: { title: "Source of stock", meta: "grouped by origin · SKUs inside", nums: ["On board", "Assigned", "Free"], group: ["source", "sources"] },
};
function matrixFrame() {
  const h = HEAD[state.view];
  let body;
  if (state.status === "loading") body = `<div class="mx-empty"><b>Loading from Monday…</b>Wholesale orders, warehouse stock, containers and purchase orders.</div>`;
  else if (state.status === "error") body = `<div class="mx-empty"><b>No data yet.</b>Monday could not be read — see the message above.</div>`;
  else body = `<div class="mx-empty"><b>Matrix rows come next.</b>Step 2 builds the rows and one column per source of stock.</div>`;

  let foot = `<span>Suggested order: warehouse first, but only if it covers the whole line — then the container arriving soonest, then a purchase order.</span>`;
  if (state.status === "ready") {
    const { counts, orphanUnits } = state.model;
    const groups = state.view === "order" ? counts.orders : state.view === "sku" ? new Set(state.model.lines.map((l) => l.sku)).size : null;
    const lead = groups === null ? `${plural(counts.rows, "row", "rows")}` : `${plural(groups, h.group[0], h.group[1])} · ${plural(counts.rows, "row", "rows")}`;
    foot = `<span>${lead}</span>${foot}`;
    if (orphanUnits) foot += `<span class="bad">${fmt(orphanUnits)} units point to a source that is no longer active</span>`;
  }

  return `<div class="mx-wrap"><div class="mx-scroll"><table class="mx">
    <thead><tr>
      <th class="s1" scope="col"><div class="hx"><div class="t">${h.title}</div><div class="m">${h.meta}</div></div></th>
      <th class="s2" scope="col"><div class="hn">${h.nums.map((x) => `<span>${x}</span>`).join("")}</div></th>
      <th scope="col"><span class="sr-only">Sources</span></th>
    </tr></thead>
    <tbody><tr><td colspan="3">${body}</td></tr></tbody>
  </table></div><div class="mx-foot">${foot}</div></div>`;
}

function errorBanner() {
  if (!state.error) return "";
  const stale = state.status === "ready";
  return `<div class="alert" role="alert"><b>${stale ? "Refresh failed." : "Monday could not be read."}</b>
    <span>${esc(state.error)}${stale ? ` Showing the figures loaded at ${clock(state.data.loadedAt)}.` : ""}</span>
    <button class="btn" type="button" data-retry>Try again</button></div>`;
}

function render() {
  document.getElementById("view").innerHTML = `
    <div class="page-h"><div><h2>Allocation matrix</h2>
      <p>Where every sold unit comes from — and the place to decide it. Pick the angle: the sale, the product, or the container.</p></div></div>
    ${errorBanner()}${metricCards()}${controls()}${legend()}${matrixFrame()}`;
  const fresh = document.getElementById("fresh");
  fresh.textContent = state.status === "ready" ? `Loaded ${clock(state.data.loadedAt)}` : state.status === "loading" ? "Loading…" : "";
  document.getElementById("refreshBtn").disabled = state.status === "loading";
}

/* ── interactions ── */
function setFilter(key, { toggle }) {
  state.filter = toggle && state.filter === key ? "all" : key; // §4: a second click on a card returns to Everything
  render();
}

document.getElementById("view").addEventListener("click", (e) => {
  const card = e.target.closest("[data-filter]");
  if (card) return setFilter(card.dataset.filter, { toggle: true });
  const chip = e.target.closest("[data-chip]");
  if (chip) return setFilter(chip.dataset.chip, { toggle: false });
  const view = e.target.closest("[data-view]");
  if (view) {
    state.view = view.dataset.view;
    return render();
  }
  if (e.target.closest("[data-retry]")) load();
});

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("on"), 3600);
}

async function load() {
  const hadData = Boolean(state.data);
  if (!hadData) state.status = "loading";
  state.error = "";
  render();
  if (hadData) document.getElementById("fresh").textContent = "Refreshing…";
  try {
    const data = await loadMatrixData();
    state.data = data;
    state.model = buildModel(data);
    state.status = "ready";
    if (hadData) toast("Figures refreshed from Monday.");
  } catch (error) {
    console.error("[matrix] load failed", error);
    state.error = error?.message || String(error);
    state.status = hadData ? "ready" : "error"; // keep the last good figures (§15.3, Attention by SKU rule)
  }
  render();
}

/* ── shell: collapsible menu (remembered, §3) and theme ── */
function setSide(min) {
  const app = document.getElementById("app"), btn = document.getElementById("sideTg");
  app.classList.toggle("min", min);
  btn.setAttribute("aria-label", min ? "Expand menu" : "Collapse menu");
  btn.title = min ? "Expand menu" : "Collapse menu";
  store.set("etoile-side", min ? "min" : "");
}
document.getElementById("sideTg").addEventListener("click", () => setSide(!document.getElementById("app").classList.contains("min")));
document.getElementById("themeBtn").addEventListener("click", () => {
  const root = document.documentElement;
  const dark = root.getAttribute("data-theme") ? root.getAttribute("data-theme") === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const next = dark ? "light" : "dark";
  root.setAttribute("data-theme", next);
  store.set("etoile-theme", next);
});
document.getElementById("refreshBtn").addEventListener("click", load);

if (store.get("etoile-side") === "min") setSide(true);
renderNav();
load();
