// Sample data copied from the agreed mockup "Etoile Flow — Inventory & Allocation" (v12).
// Used ONLY by tests, to check the engine reproduces the numbers the client approved.
// It is never loaded by the app.

const SKUS = {
  EC0383: { n: "Duo Vanity Case: Burgundy Croc", us: 24 },
  EC0387: { n: "Duo Vanity Case: Espresso Croc", us: 120 },
  EC0398: { n: "Duo Vanity Case: Noir Croc", us: 12 },
  EC0394: { n: "Duo Vanity Case: Crush", us: 90 },
  EC0395: { n: "Vanity Case: Crush", us: 86 },
  EC0399: { n: "Vanity Case: Noir Croc", us: 0 },
  EC0389: { n: "Mini Vanity Case: Espresso Croc", us: 57 },
  EC0385: { n: "Mini Vanity Case: Burgundy Croc", us: 71 },
  EC0400: { n: "Mini Vanity Case: Noir Croc", us: 8 },
  EC0386: { n: "Oval Toiletry Case: Burgundy Croc", us: 68 },
  EC0401: { n: "Oval Toiletry Case: Noir Croc", us: 0 },
  EC0272: { n: "Clear Pouch - Beige", us: 340 },
  EC0433: { n: "Duo Vanity Case: Serpent", us: 0 },
  EC0434: { n: "Vanity Case: Serpent", us: 0 },
  EC0435: { n: "Mini Vanity Case: Serpent", us: 0 },
  EC0436: { n: "Oval Toiletry Case: Serpent", us: 0 },
  EC0388: { n: "Vanity Case: Espresso Croc", us: 57 },
  EC0384: { n: "Vanity Case: Burgundy Croc", us: 79 },
  EC0450: { n: "Weekender Vanity Case: Olive Croc", us: 60 },
  EC0451: { n: "Mini Vanity Case: Olive Croc", us: 0 },
  EC0452: { n: "Oval Toiletry Case: Olive Croc", us: 45 },
};

const POS = [
  { id: "PO-00385", ref: "PO260108US", region: "US", eta: "2026-04-16",
    lines: { EC0384: [857, 857], EC0388: [2000, 2000], EC0385: [708, 708], EC0389: [1800, 1800], EC0387: [1200, 1200], EC0383: [504, 504] } },
  { id: "PO-00432", ref: "PO260716US", region: "US", eta: "2026-09-28",
    lines: { EC0383: [600, 0], EC0387: [1200, 0], EC0398: [900, 0], EC0394: [700, 0], EC0395: [960, 0], EC0399: [760, 0],
      EC0389: [500, 0], EC0385: [500, 0], EC0400: [380, 0], EC0386: [300, 0], EC0401: [640, 0], EC0272: [50, 0] } },
  { id: "PO-00441", ref: "PO260812US", region: "US", eta: "2026-11-20", lines: { EC0387: [1400, 0], EC0399: [900, 0], EC0401: [800, 0], EC0400: [600, 0] } },
  { id: "PO-00445", ref: "PO260901US", region: "US", eta: "2026-12-18", lines: { EC0433: [1400, 0], EC0434: [900, 0], EC0435: [900, 0], EC0436: [400, 0] } },
  { id: "PO-00450", ref: "PO260620US", region: "US", eta: "2026-10-02", lines: { EC0450: [500, 0], EC0451: [400, 0], EC0452: [300, 0] } },
  { id: "PO-00458", ref: "PO260705US", region: "US", eta: "2026-10-30", lines: { EC0450: [800, 0], EC0451: [300, 0] } },
];

const SHIPS = [
  { id: "US / FLEX-4084548 / 40HC", eta: "2026-09-03", packing: "Final",
    lines: [["EC0394", "PO-00432", 600], ["EC0395", "PO-00432", 800], ["EC0389", "PO-00432", 408], ["EC0385", "PO-00432", 408]] },
  { id: "US / FLEX-4119719 / 40HC", eta: "2026-09-28", packing: "Final",
    lines: [["EC0383", "PO-00432", 464], ["EC0387", "PO-00432", 699], ["EC0387", "PO-00441", 301], ["EC0398", "PO-00432", 752],
      ["EC0399", "PO-00432", 600], ["EC0400", "PO-00432", 300], ["EC0386", "PO-00432", 204], ["EC0401", "PO-00432", 540], ["EC0272", "PO-00432", 50]] },
  { id: "US / FLEX-4132795 / 40HC", eta: "2026-10-24", packing: "Final",
    lines: [["EC0387", "PO-00432", 501], ["EC0387", "PO-00441", 331], ["EC0399", "PO-00432", 160], ["EC0399", "PO-00441", 300]] },
  { id: "US / FLEX-4151882 / 40HC", eta: "2026-11-08", packing: "Draft",
    lines: [["EC0401", "PO-00432", 100], ["EC0401", "PO-00441", 420], ["EC0400", "PO-00441", 400]] },
  { id: "US / FLEX-4170234 / 40HC", eta: "2026-10-06", packing: "Final",
    lines: [["EC0450", "PO-00450", 200], ["EC0450", "PO-00458", 350], ["EC0451", "PO-00450", 400], ["EC0452", "PO-00450", 180]] },
  { id: "US / FLEX-4188610 / 40HC", eta: "2026-10-27", packing: "Final",
    lines: [["EC0450", "PO-00450", 300], ["EC0450", "PO-00458", 250], ["EC0451", "PO-00458", 150]] },
];

const F70 = "US / FLEX-4170234 / 40HC", F86 = "US / FLEX-4188610 / 40HC", F19 = "US / FLEX-4119719 / 40HC";
const F32 = "US / FLEX-4132795 / 40HC", F48 = "US / FLEX-4084548 / 40HC", F51 = "US / FLEX-4151882 / 40HC", WH = "WH";
const GROUP = { Orders: "topics", Pending: "group_mm1730xq", Fulfilled: "group_mm17q5pm" };

// [id, group, cancel, [[sku, ordered, fulfilled, [[source, ref, qty], …]], …]]
const ORDERS = [
  ["EIVR118", "Orders", "2026-12-30", [
    ["EC0433", 1224, 0, [["po", "PO-00445", 1224]]], ["EC0434", 816, 0, [["po", "PO-00445", 816]]],
    ["EC0435", 812, 0, [["po", "PO-00445", 812]]], ["EC0436", 312, 0, [["po", "PO-00445", 312]]],
    ["EC0387", 600, 0, [["po", "PO-00441", 600]]], ["EC0450", 200, 0, [["po", "PO-00458", 200]]]]],
  ["EIVR117", "Fulfilled", "2026-10-15", [["EC0389", 140, 140, [["wh", WH, 140]]]]],
  ["EIVR121", "Pending", "2026-10-31", [
    ["EC0387", 1021, 0, [["it", F19, 699], ["it", F19, 301], ["it", F32, 21]]],
    ["EC0401", 640, 0, [["it", F19, 540], ["it", F51, 100]]],
    ["EC0383", 300, 0, [["wh", WH, 24], ["it", F19, 276]]],
    ["EC0400", 520, 0, []],
    ["EC0450", 150, 0, [["it", F86, 150]]]]],
  ["EIVR124", "Orders", "2026-11-14", [
    ["EC0395", 800, 0, [["it", F48, 800]]], ["EC0394", 640, 0, [["wh", WH, 90], ["it", F48, 550]]],
    ["EC0398", 900, 0, [["it", F19, 752]]], ["EC0387", 480, 0, [["it", F32, 480]]], ["EC0450", 180, 0, [["it", F86, 180]]]]],
  ["EIVR127", "Orders", "2026-11-28", [
    ["EC0399", 760, 0, [["it", F19, 600], ["it", F32, 160]]], ["EC0386", 300, 0, [["wh", WH, 68], ["it", F19, 204]]],
    ["EC0388", 600, 0, [["wh", WH, 57]]], ["EC0387", 300, 0, []], ["EC0451", 150, 0, []]]],
  ["EIVR129", "Orders", "2026-12-05", [
    ["EC0401", 420, 0, []], ["EC0385", 408, 0, [["it", F48, 408]]], ["EC0384", 400, 0, []],
    ["EC0387", 120, 0, [["wh", WH, 120]]], ["EC0399", 300, 0, [["it", F32, 300]]], ["EC0450", 60, 0, [["wh", WH, 60]]]]],
  ["EIVR132", "Orders", "2026-11-20", [
    ["EC0450", 700, 0, [["it", F70, 200], ["it", F70, 350], ["it", F86, 150]]],
    ["EC0451", 400, 0, [["it", F70, 400]]],
    ["EC0452", 250, 0, [["wh", WH, 45], ["it", F70, 180], ["po", "PO-00450", 25]]]]],
];

const SRC = { wh: "warehouse", it: "intransit", po: "po" };

export function mockupData() {
  return {
    warehouse: Object.fromEntries(Object.entries(SKUS).map(([sku, s]) => [sku, { itemId: `wh-${sku}`, name: s.n, usQty: s.us }])),
    pos: POS.map((p) => ({
      id: p.id, name: p.id, reference: p.ref, region: p.region, eta: p.eta,
      lines: Object.entries(p.lines).map(([sku, [ord, arr]]) => ({ id: `${p.id}-${sku}`, sku, qtyOrdered: ord, qtyOutstanding: ord - arr })),
    })),
    containers: SHIPS.map((s) => ({
      id: s.id, name: s.id, group: "topics", location: "US", eta: s.eta, packingList: s.packing,
      lines: s.lines.map(([sku, po, qty], i) => ({ id: `${s.id}-${i}`, sku, poRef: po, qty })),
    })),
    orders: ORDERS.map(([id, grp, cancel, lines]) => ({
      id, name: id, group: GROUP[grp], region: "US", cancelDate: cancel,
      lines: lines.map(([sku, ord, ful, alloc]) => ({
        id: `${id}-${sku}`, sku, outstanding: ord - ful,
        entries: alloc.map(([s, ref, qty]) => ({ source: SRC[s], sourceId: s === "wh" ? `wh-${sku}` : ref, qty })),
      })),
    })),
  };
}
