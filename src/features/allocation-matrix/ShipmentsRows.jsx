import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fmt, dayMonth, dayMonthYear } from "../../lib/format.js";
import { shipUnits } from "../../lib/shipments.js";

// "···" menu of a shipment: a floating panel placed under the button. It is rendered into <body>
// (portal): inside the table it would share the sticky cells' stacking context and could be painted
// under them. Closes on a click outside or Escape; on scroll it follows its button.
function ShipMenu({ open, confirmDelete, onToggle, onClose, onRename, onDelete }) {
  const btn = useRef(null), panel = useRef(null);
  const [pos, setPos] = useState(null);
  useEffect(() => {
    if (!open) return undefined;
    // Placed under the button; on scroll it follows the button, and closes only if the button leaves the screen.
    const place = () => {
      const r = btn.current?.getBoundingClientRect();
      if (!r || r.bottom < 0 || r.top > window.innerHeight) return onClose();
      setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.right - 190, window.innerWidth - 198)) });
    };
    place();
    const outside = (e) => !panel.current?.contains(e.target) && !btn.current?.contains(e.target) && onClose();
    const esc = (e) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", esc);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span className="mnu">
      <button ref={btn} type="button" className="shm" onClick={onToggle} aria-label="More actions" aria-haspopup="menu" aria-expanded={open} title="More actions">
        <DotsIcon />
      </button>
      {open && pos && createPortal(
        <span ref={panel} className="mnu-p float" role="menu" style={pos}>
          <button type="button" role="menuitem" onClick={onRename}>Rename</button>
          <button type="button" role="menuitem" className="dng" onClick={onDelete}>{confirmDelete ? "Click again to delete" : "Delete shipment"}</button>
        </span>,
        document.body,
      )}
    </span>
  );
}

// Drawn icons (a text "···" or "✓" sits off-centre depending on the font).
const DotsIcon = () => (
  <svg className="ico-dots" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
    <circle cx="3" cy="8" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="13" cy="8" r="1.5" />
  </svg>
);
const CheckIcon = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3.5 8.5 6.5 11.5 12.5 5" />
  </svg>
);
const SpinIcon = () => (
  <svg className="spin" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
  </svg>
);
const PencilIcon = () => (
  <svg className="ico-edit" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10.5 3.5 12.5 5.5 6 12H4v-2z" />
  </svg>
);

// Rename field: focused with the whole name selected, so typing replaces it. The selection is applied
// again after focus settles (the browser may move the caret to the end right after focusing).
function RenameInput({ value, onDone, onCancel }) {
  const ref = useRef(null);
  const cancelled = useRef(false);
  useEffect(() => {
    const el = ref.current;
    const selectAll = () => document.activeElement === el && el.setSelectionRange(0, el.value.length);
    el.focus();
    selectAll();
    const t = setTimeout(selectAll, 0);
    const raf = requestAnimationFrame(selectAll);
    return () => {
      clearTimeout(t);
      cancelAnimationFrame(raf);
    };
  }, []);
  return (
    <input ref={ref} className="shname" defaultValue={value} maxLength={60} aria-label="Shipment name"
      onBlur={(e) => !cancelled.current && onDone(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          cancelled.current = true;
          onCancel();
        }
      }} />
  );
}

// Ship date shown in English ("21 Dec 2026" / "Set a date") whatever the browser's language — the
// native date field would show the system's own placeholder (e.g. "dd/mm/aaaa"). Clicking it opens the
// native date picker; "×" clears the date.
function ShipDateField({ value, min, onChange }) {
  const ref = useRef(null);
  const open = () => {
    const el = ref.current;
    try {
      el.showPicker();
    } catch {
      el.focus();
      el.click();
    }
  };
  return (
    <span className="shd">
      <span className="lbl">Ship date</span>
      <span className="date-field">
        <button type="button" className={`date-btn ${value ? "" : "empty"}`} onClick={open} aria-label={value ? `Ship date ${dayMonthYear(value)}, change` : "Set a ship date"}>
          <CalendarIcon /> {value ? dayMonthYear(value) : "Set a date"}
        </button>
        {value && <button type="button" className="date-clear" onClick={() => onChange("")} aria-label="Clear ship date" title="Clear ship date">×</button>}
        <input ref={ref} type="date" className="date-native" tabIndex={-1} aria-hidden="true" value={value || ""} min={min}
          onChange={(e) => onChange(e.target.value)} />
      </span>
    </span>
  );
}
const CalendarIcon = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" /><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
  </svg>
);

const TrashIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.6 8.5h4.8l.6-8.5" />
  </svg>
);

// §16 — the Shipments tab of an open order: one block per shipment (same markup as the mockup).
export function ShipmentsRows({ group, cols, nCol, sh: S }) {
  const orderId = String(group.key);
  const ships = S.shipsOf(orderId);
  const order = S.orderInfo(orderId);
  const a = S.actions;

  if (!ships.length) {
    return (
      <tr className="shnote sticky-note">
        <td colSpan={nCol}>
          <div>No shipments yet. <b>Copy remaining to ship</b> brings in every allocated unit, or start from <b>+ New shipment</b> and fill in quantities.</div>
        </td>
      </tr>
    );
  }

  return ships.map((sh) => {
    const opened = !S.ui.closed[sh.id];
    const units = shipUnits(sh);
    const late = S.lateUnitsOf(orderId, sh);
    const saving = S.ui.saving[sh.id];
    const error = S.ui.errors[sh.id];
    const splits = Object.fromEntries(sh.skus.map((k) => [k, S.splitOf(orderId, ships, k)[sh.id] || {}]));
    return (
      <Fragment key={sh.id}>
        <tr className="shc">
          <td colSpan={nCol}>
            <div className="shc-in">
              <button type="button" className="cv" onClick={() => a.toggleShip(sh.id)} aria-label={opened ? "Collapse" : "Expand"}>{opened ? "▼" : "▶"}</button>
              {S.ui.rename === sh.id ? (
                <RenameInput value={sh.name}
                  onDone={(v) => a.finishRename(orderId, sh.id, v)} onCancel={() => a.finishRename(orderId, sh.id, "", true)} />
              ) : (
                <button type="button" className="shn shn-edit" onClick={() => a.startRename(sh.id)} title="Click to rename">{sh.name}<PencilIcon /></button>
              )}
              <span className="badge">Draft</span>
              <span className="shs">
                <b>{fmt(units)}</b> / {fmt(order.toShip)} units
                {sh.dirty ? <span className="unsaved"> · not saved yet</span> : sh.savedAt ? <span className="saved"> · saved {sh.savedAt}</span> : null}
              </span>
              {late > 0 && <span className="shw">{fmt(late)} units land after the ship date</span>}
              {sh.target && order.cancelDate && sh.target > order.cancelDate && <span className="shw">after the {dayMonth(order.cancelDate)} cancel date</span>}
              {/* Controls follow the shipment's status, separated by a divider (not pushed to the far right). */}
              <span className="sh-controls">
                <ShipDateField value={sh.target} min={S.today} onChange={(v) => a.setDate(orderId, sh.id, v)} />
                <button type="button" className={`btn save ${sh.dirty ? "dirty" : ""}`} disabled={saving || !sh.dirty} onClick={() => a.save(orderId, sh.id)}
                  title={sh.dirty ? "Save this shipment to Monday" : "Saved in Monday"}>
                  {saving ? <><SpinIcon /> Saving…</> : sh.dirty ? "Save" : <><CheckIcon /> Saved</>}
                </button>
                <ShipMenu open={S.ui.menu === sh.id} confirmDelete={S.ui.confirmDelete === sh.id}
                  onToggle={() => a.toggleMenu(sh.id)} onClose={() => a.closeMenu()}
                  onRename={() => a.startRename(sh.id)} onDelete={() => a.deleteShip(orderId, sh.id)} />
              </span>
              {error && <span className="ap-err sh-err" role="alert">{error}</span>}
            </div>
          </td>
        </tr>
        {opened && (
          <>
            <tr className="shth">
              <td className="s1"><div className="rh">SKU · Product name</div></td>
              <td className="s2"><div className="nn n4"><span>Order qty</span><span>Allocated</span><span>To ship in this shipment</span><span>Remaining to ship</span><span className="rm-slot" aria-hidden="true" /></div></td>
              {cols.map((c) => <td key={c.id} className={`shcol ${c.k}`}><span>{c.label}</span><i>{c.meta || ""}</i></td>)}
              <td className="end" />
            </tr>
            {!sh.skus.length && (
              <tr className="shnote"><td colSpan={nCol}><div>Nothing in {sh.name}. Delete it, or use Copy remaining to ship.</div></td></tr>
            )}
            {sh.skus.map((sku) => {
              const line = S.lineOf(orderId, sku);
              if (!line) return null;
              const q = sh.qty[sku] || 0;
              const max = S.maxOf(orderId, sh, sku);
              const sp = splits[sku];
              return (
                <tr key={sku} className={`rw shr ${q ? "" : "zero"}`}>
                  <td className="s1"><div className="rh"><div className="t"><b>{sku} - {line.productName}</b></div></div></td>
                  <td className="s2">
                    <div className="nn n4">
                      <span className="n mid">{fmt(line.toShip)}</span>
                      <span className="n mid">{fmt(line.allocated)}</span>
                      <span className="n">
                        <input key={`${sh.id}-${sku}-${q}`} className="qin" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={7}
                          defaultValue={q} aria-label={`Units of ${sku} in ${sh.name}`}
                          onFocus={(e) => { const el = e.target; el.select(); setTimeout(() => document.activeElement === el && el.select(), 0); }}
                          onInput={(e) => { const v = e.target.value.replace(/[^0-9]/g, ""); if (v !== e.target.value) e.target.value = v; }}
                          title={`Up to ${fmt(max)} allocated units not in another shipment`}
                          onBlur={(e) => Number(e.target.value) !== q && a.setQty(orderId, sh.id, sku, e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
                      </span>
                      <span className="n">{fmt(S.remainingOf(orderId, sh, sku))}</span>
                      <span className="rm-slot">
                        <button type="button" className="rmx" onClick={() => a.removeRow(orderId, sh.id, sku)} aria-label={`Remove ${sku} from ${sh.name}`} title={`Remove from ${sh.name}`}>
                          <TrashIcon />
                        </button>
                      </span>
                    </div>
                  </td>
                  {cols.map((c) => {
                    const v = sp[c.id] || 0;
                    const lt = v && sh.target && S.srcDate(c.id) > sh.target;
                    return v ? (
                      <td key={c.id} className={`cl a ${lt ? "lt" : c.k}`}>
                        <span title={`${fmt(v)} of ${sku} from ${c.label}${lt ? ` — lands ${dayMonthYear(S.srcDate(c.id))}, after the ship date` : ""}`}>{fmt(v)}</span>
                      </td>
                    ) : <td key={c.id} className="cl" />;
                  })}
                  <td className="end" />
                </tr>
              );
            })}
          </>
        )}
      </Fragment>
    );
  });
}
