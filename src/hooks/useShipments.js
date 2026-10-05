import { useCallback, useEffect, useMemo, useState } from "react";
import { fmt, dayMonth, dayMonthYear } from "../lib/format.js";
import { orderParts } from "../lib/matrix.js";
import { lateUnits, leftToShip, localToday, maxFor, nextShip, overShipped, remainingAfter, shipSplit, shipUnits, trimShips } from "../lib/shipments.js";
import { mondayApi } from "../config.js";
import { deleteShipment, linkLines, saveShipment } from "../lib/shipmentsSync.js";
import { containerCode } from "../lib/matrix.js";

const todayISO = () => localToday();
// ISO date-time (UTC) → "Oct 1, 08:06 AM" in the viewer's own time zone.
const savedLabel = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
};

// Step 4 — shipments of every open order (PDF §16): loaded from monday, edited locally, saved with "Save".
export function useShipments({ data, model, write, toast, patchData }) {
  // Keep the loaded data (and its cache) in step with what was just written to monday.
  const persistSaved = (orderId, ship) => patchData?.((d) => {
    const rest = (d.shipments || []).filter((s) => s.mondayId !== ship.mondayId);
    const prev = (d.shipments || []).find((s) => s.mondayId === ship.mondayId);
    const entry = { mondayId: ship.mondayId, orderId: String(orderId), name: ship.name, target: ship.target, createdAt: prev?.createdAt || new Date().toISOString(), savedAt: new Date().toISOString(),
      lines: ship.skus.map((k) => ({ subId: ship.subIds[k], sku: k, qty: ship.qty[k] || 0 })) };
    return { ...d, shipments: [...rest, entry].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) };
  });
  const persistDeleted = (mondayId) => patchData?.((d) => ({ ...d, shipments: (d.shipments || []).filter((s) => s.mondayId !== mondayId) }));
  const [byOrder, setByOrder] = useState({});
  const [ui, setUi] = useState({ tab: {}, closed: {}, rename: null, menu: null, confirmDelete: null, saving: {}, errors: {} });

  // ── lookups ──
  const lines = useMemo(() => {
    const m = new Map();
    if (!model || !data) return m;
    const ledgerOf = new Map(data.orders.flatMap((o) => o.lines.map((l) => [String(l.id), l.ledgerItemId])));
    for (const l of model.lines) {
      m.set(`${l.orderId}|${l.sku}`, {
        lineId: l.lineId, ledgerItemId: ledgerOf.get(String(l.lineId)) || null, allocated: l.allocated, toShip: l.toShip,
        entries: l.entries, productName: data.warehouse[l.sku]?.name || l.sku,
      });
    }
    return m;
  }, [data, model]);
  const lineOf = useCallback((orderId, sku) => lines.get(`${orderId}|${sku}`) || null, [lines]);
  const allocatedOf = useCallback((orderId, sku) => lineOf(orderId, sku)?.allocated || 0, [lineOf]);

  const srcInfo = useMemo(() => {
    const m = new Map([["warehouse", { date: todayISO(), label: "Warehouse" }]]);
    for (const c of data?.containers || []) m.set(String(c.id), { date: c.eta || todayISO(), label: containerCode(c.name) });
    for (const p of data?.pos || []) m.set(String(p.id), { date: p.eta || todayISO(), label: p.name });
    return m;
  }, [data]);
  const srcDate = useCallback((k) => srcInfo.get(k)?.date || todayISO(), [srcInfo]);
  const srcLabel = useCallback((k) => srcInfo.get(k)?.label || k, [srcInfo]);

  const splitOf = useCallback((orderId, ships, sku, override) => shipSplit(ships, lineOf(orderId, sku)?.entries || [], sku, srcDate, override), [lineOf, srcDate]);

  // ── load from monday (and §16.4: trim what no longer fits the allocation, last shipment first) ──
  useEffect(() => {
    if (!data || !model) return;
    const openIds = new Set(model.orders.map((o) => String(o.id)));
    const next = {};
    for (const s of data.shipments || []) {
      if (!openIds.has(s.orderId)) continue;
      const skus = [...new Set(s.lines.map((l) => l.sku))];
      (next[s.orderId] ||= []).push({
        id: s.mondayId, mondayId: s.mondayId, name: s.name, target: s.target, skus, savedAt: savedLabel(s.savedAt),
        qty: Object.fromEntries(skus.map((k) => [k, s.lines.filter((l) => l.sku === k).reduce((a, l) => a + l.qty, 0)])),
        subIds: Object.fromEntries(s.lines.map((l) => [l.sku, l.subId])), dirty: false,
      });
    }
    const notes = [];
    for (const [orderId, ships] of Object.entries(next)) {
      let cur = ships;
      for (const sku of new Set(ships.flatMap((s) => s.skus))) {
        const { ships: trimmed, cut } = trimShips(cur, sku, allocatedOf(orderId, sku));
        if (cut) notes.push(`${fmt(cut)} units of ${sku} came out of ${orderParts(model.orders.find((o) => String(o.id) === orderId)?.name).number}'s shipments: its allocation is lower now. Save to keep the change.`);
        cur = trimmed;
      }
      next[orderId] = cur;
    }
    setByOrder(next);
    if (notes.length) toast(notes.join(" "));
    // Re-initialise only when monday was read again, not when a local save patches the data.
  }, [data?.loadedAt?.getTime?.(), Boolean(model)]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── helpers ──
  const shipsOf = (orderId) => byOrder[orderId] || [];
  const update = (orderId, fn) => setByOrder((cur) => ({ ...cur, [orderId]: fn(cur[orderId] || []) }));
  const patchShip = (orderId, shipId, patch) => update(orderId, (ships) => ships.map((s) => (s.id === shipId ? { ...s, ...patch, dirty: true } : s)));
  const setUiKey = (key, value) => setUi((u) => ({ ...u, [key]: typeof value === "function" ? value(u[key]) : value }));
  const orderSkus = (orderId) => model.lines.filter((l) => String(l.orderId) === String(orderId)).map((l) => l.sku);
  const orderInfo = (orderId) => {
    const o = model.orders.find((x) => String(x.id) === String(orderId));
    return { id: String(orderId), number: orderParts(o?.name).number, toShip: model.lines.filter((l) => String(l.orderId) === String(orderId)).reduce((a, l) => a + l.toShip, 0), cancelDate: o?.cancelDate || "" };
  };
  const remainingToCopy = (orderId) => orderSkus(orderId).reduce((a, k) => a + leftToShip(shipsOf(orderId), k, allocatedOf(orderId, k)), 0);

  // ── actions (§16.3) ──
  const actions = {
    setTab: (orderId, tab) => setUi((u) => ({ ...u, tab: { ...u.tab, [orderId]: tab }, menu: null })),
    toggleShip: (shipId) => setUi((u) => ({ ...u, closed: { ...u.closed, [shipId]: !u.closed[shipId] } })),
    toggleMenu: (shipId) => setUi((u) => ({ ...u, menu: u.menu === shipId ? null : shipId, confirmDelete: null })),
    closeMenu: () => setUi((u) => (u.menu ? { ...u, menu: null, confirmDelete: null } : u)),

    newShip(orderId, copy) {
      const ships = shipsOf(orderId);
      const skus = orderSkus(orderId).filter((k) => leftToShip(ships, k, allocatedOf(orderId, k)) > 0);
      const { number } = orderInfo(orderId);
      if (!skus.length) return toast(`Every allocated unit of ${number} is already in a shipment.`);
      const s = nextShip(ships, orderId);
      s.skus = skus;
      s.qty = Object.fromEntries(skus.map((k) => [k, copy ? leftToShip(ships, k, allocatedOf(orderId, k)) : 0]));
      update(orderId, (cur) => [...cur, s]);
      setUi((u) => ({ ...u, tab: { ...u.tab, [orderId]: "ships" }, menu: null }));
      toast(copy ? `${s.name} created with the ${fmt(shipUnits(s))} allocated units not in a shipment yet. Add a ship date and lower what isn't ready.`
        : `${s.name} created. Type how many units of each SKU go in it.`);
    },

    setQty(orderId, shipId, sku, raw) {
      const ships = shipsOf(orderId), sh = ships.find((s) => s.id === shipId);
      let v = parseInt(raw, 10);
      if (Number.isNaN(v) || v < 0) v = 0;
      const max = maxFor(ships, sh, sku, allocatedOf(orderId, sku));
      if (v > max) {
        toast(`Only ${fmt(max)} allocated units of ${sku} aren't in another shipment.`);
        v = max;
      }
      if (sh.target) {
        const late = lateUnits(sh, splitOf(orderId, ships, sku, { id: shipId, q: v })[shipId], srcDate);
        if (late) {
          v -= late;
          toast(`${fmt(late)} of those units would come from a source that lands after ${dayMonthYear(sh.target)}. ${sh.name} takes ${fmt(v)}.`);
        }
      }
      patchShip(orderId, shipId, { qty: { ...sh.qty, [sku]: v } });
    },

    setDate(orderId, shipId, v) {
      const ships = shipsOf(orderId), sh = ships.find((s) => s.id === shipId);
      if (!v) return patchShip(orderId, shipId, { target: "" });
      if (v < todayISO()) return toast(`The ship date can't be before today.`);
      const late = [];
      for (const k of sh.skus) {
        for (const [r, q] of Object.entries(splitOf(orderId, ships, k)[shipId] || {})) {
          if (q && srcDate(r) > v) late.push(`${srcLabel(r)} (${dayMonth(srcDate(r))})`);
        }
      }
      if (late.length) return toast(`Can't ship ${sh.name} on ${dayMonthYear(v)}: ${[...new Set(late)].join(", ")} lands later. Lower those quantities first.`);
      patchShip(orderId, shipId, { target: v });
      toast(`${sh.name} ships ${dayMonthYear(v)}.`);
    },

    // §16.4 — after the allocation of a line goes down: what no longer fits comes out of the order's
    // shipments, last shipment first. Those shipments are left unsaved. Returns the units taken out.
    fitAllocation(orderId, sku, allocated) {
      const { ships, cut } = trimShips(shipsOf(orderId), sku, allocated);
      if (cut) update(orderId, () => ships);
      return cut;
    },

    startRename: (shipId) => setUi((u) => ({ ...u, rename: shipId, menu: null })),
    finishRename(orderId, shipId, value, cancel) {
      const v = String(value || "").trim();
      if (!cancel && v) patchShip(orderId, shipId, { name: v });
      setUiKey("rename", null);
    },

    removeRow(orderId, shipId, sku) {
      const sh = shipsOf(orderId).find((s) => s.id === shipId), n = sh.qty[sku] || 0;
      const qty = { ...sh.qty };
      delete qty[sku];
      patchShip(orderId, shipId, { skus: sh.skus.filter((k) => k !== sku), qty });
      toast(`${sku} removed from ${sh.name}.${n ? ` ${fmt(n)} units are back in "remaining to ship".` : ""}`);
    },

    async deleteShip(orderId, shipId) {
      if (ui.confirmDelete !== shipId) return setUiKey("confirmDelete", shipId); // second click confirms
      const ships = shipsOf(orderId), sh = ships.find((s) => s.id === shipId), n = shipUnits(sh);
      setUi((u) => ({ ...u, menu: null, confirmDelete: null, saving: { ...u.saving, [shipId]: true } }));
      try {
        await deleteShipment(write, sh);
        const rest = ships.filter((s) => s.id !== shipId);
        if (sh.mondayId) await linkLines(write, rest, sh.skus, (k) => lineOf(orderId, k));
        update(orderId, () => rest);
        if (sh.mondayId) persistDeleted(sh.mondayId);
        toast(`${sh.name} deleted.${n ? ` Its ${fmt(n)} units are back in "remaining to ship".` : ""}`);
      } catch (e) {
        setUi((u) => ({ ...u, errors: { ...u.errors, [shipId]: `Could not delete: ${e.message}` } }));
      } finally {
        setUi((u) => ({ ...u, saving: { ...u.saving, [shipId]: false } }));
      }
    },

    async save(orderId, shipId) {
      const ships = shipsOf(orderId);
      let sh = ships.find((s) => s.id === shipId);
      // §16.4 — per SKU, Σ in all shipments ≤ Allocated (the inputs already cap it; re-check before writing).
      const over = sh.skus.filter((k) => ships.reduce((a, s) => a + (s.qty[k] || 0), 0) > allocatedOf(orderId, k));
      if (over.length) return setUi((u) => ({ ...u, errors: { ...u.errors, [shipId]: `More units than allocated for ${over.join(", ")}. Lower them before saving.` } }));
      setUi((u) => ({ ...u, saving: { ...u.saving, [shipId]: true }, errors: { ...u.errors, [shipId]: "" } }));
      try {
        // §10 concurrency: someone else may have saved shipments of this order since the page was loaded.
        const latestRaw = (await mondayApi.loadShipments()).filter((s) => s.orderId === String(orderId));
        const latest = latestRaw.map((s) => ({ mondayId: s.mondayId, qty: s.lines.reduce((m, l) => ({ ...m, [l.sku]: (m[l.sku] || 0) + l.qty }), {}) }));
        if (sh.mondayId) {
          const mine = latestRaw.find((s) => s.mondayId === sh.mondayId);
          if (!mine) throw new Error("This shipment was deleted in Monday by someone else. Refresh to see the current shipments.");
          // Lines deleted by hand in monday are created again instead of failing.
          sh = { ...sh, subIds: Object.fromEntries(mine.lines.map((l) => [l.sku, l.subId])) };
        }
        const local = ships.filter((s) => s.id !== shipId && !s.mondayId); // unsaved ones of this user count too
        const conflict = overShipped([...latest, ...local], sh, (k) => allocatedOf(orderId, k));
        if (conflict.length) {
          const c = conflict[0];
          throw new Error(`${c.sku}: ${fmt(c.others)} units are already in other shipments in Monday and only ${fmt(c.allocated)} are allocated. Someone else may have changed this order — refresh and try again.`);
        }
        const order = orderInfo(orderId);
        const ctx = {
          order,
          lineOf: (k) => lineOf(orderId, k),
          remaining: (k) => remainingAfter(ships, sh, k, allocatedOf(orderId, k)),
          splitText: (k) => Object.entries(splitOf(orderId, ships, k)[shipId] || {}).map(([r, q]) => `${srcLabel(r)}: ${fmt(q)}`).join(" · "),
        };
        const { mondayId, subIds } = await saveShipment(write, sh, ctx);
        const savedShip = { ...sh, id: sh.id, mondayId, subIds, dirty: false, savedAt: savedLabel(new Date().toISOString()) };
        const nextShips = ships.map((s) => (s.id === shipId ? savedShip : s));
        await linkLines(write, nextShips, [...sh.skus, ...Object.keys(sh.subIds || {})], (k) => lineOf(orderId, k));
        update(orderId, () => nextShips);
        persistSaved(orderId, savedShip);
        toast(`${sh.name} saved to Monday.`);
      } catch (e) {
        // Keep what was already created in monday so a retry updates it instead of duplicating it.
        if (e.partial?.mondayId) update(orderId, (cur) => cur.map((s) => (s.id === shipId ? { ...s, mondayId: e.partial.mondayId, subIds: e.partial.subIds, dirty: true } : s)));
        setUi((u) => ({ ...u, errors: { ...u.errors, [shipId]: `Not saved: ${e.message}` } }));
      } finally {
        setUi((u) => ({ ...u, saving: { ...u.saving, [shipId]: false } }));
      }
    },
  };

  return {
    ui, actions, shipsOf, allocatedOf, lineOf, splitOf, srcDate, orderInfo, remainingToCopy,
    hasUnsaved: Object.values(byOrder).some((ships) => ships.some((s) => s.dirty)),
    lateUnitsOf: (orderId, sh) => sh.skus.reduce((a, k) => a + lateUnits(sh, splitOf(orderId, shipsOf(orderId), k)[sh.id], srcDate), 0),
    maxOf: (orderId, sh, sku) => maxFor(shipsOf(orderId), sh, sku, allocatedOf(orderId, sku)),
    remainingOf: (orderId, sh, sku) => remainingAfter(shipsOf(orderId), sh, sku, allocatedOf(orderId, sku)),
    today: todayISO(),
  };
}
