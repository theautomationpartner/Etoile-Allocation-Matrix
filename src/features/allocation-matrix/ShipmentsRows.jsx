import { Fragment } from "react";
import { fmt, dayMonth, dayMonthYear } from "../../lib/format.js";
import { shipUnits } from "../../lib/shipments.js";

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
                <input className="shname" defaultValue={sh.name} autoFocus onFocus={(e) => e.target.select()} aria-label="Shipment name"
                  onBlur={(e) => a.finishRename(orderId, sh.id, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") a.finishRename(orderId, sh.id, "", true);
                  }} />
              ) : (
                <button type="button" className="shn shn-edit" onClick={() => a.startRename(sh.id)} title="Click to rename">{sh.name}</button>
              )}
              <span className="badge">Draft</span>
              <span className="shs"><b>{fmt(units)}</b> / {fmt(order.toShip)} units{sh.dirty ? " · not saved yet" : ""}</span>
              {late > 0 && <span className="shw">{fmt(late)} units land after the ship date</span>}
              {sh.target && order.cancelDate && sh.target > order.cancelDate && <span className="shw">after the {dayMonth(order.cancelDate)} cancel date</span>}
              {error && <span className="ap-err">{error}</span>}
              <span className="sp" />
              <label className="shd">
                Ship date{" "}
                <input type="date" value={sh.target || ""} min={S.today} onChange={(e) => a.setDate(orderId, sh.id, e.target.value)} />
              </label>
              <button type="button" className={`btn save ${sh.dirty ? "dirty" : ""}`} disabled={saving || !sh.dirty} onClick={() => a.save(orderId, sh.id)}
                title={sh.dirty ? "Save this shipment to Monday" : "Saved in Monday"}>
                {saving ? "Saving…" : sh.dirty ? "Save" : "Saved"}
              </button>
              <span className="mnu">
                <button type="button" className="shm" onClick={() => a.toggleMenu(sh.id)} aria-label="More actions" aria-expanded={S.ui.menu === sh.id} title="More actions">···</button>
                {S.ui.menu === sh.id && (
                  <span className="mnu-p">
                    <button type="button" onClick={() => a.startRename(sh.id)}>Rename</button>
                    <button type="button" className="dng" onClick={() => a.deleteShip(orderId, sh.id)}>
                      {S.ui.confirmDelete === sh.id ? "Click again to delete" : "Delete shipment"}
                    </button>
                  </span>
                )}
              </span>
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
                        <input key={`${sh.id}-${sku}-${q}`} className="qin" type="number" min="0" max={max} defaultValue={q}
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
