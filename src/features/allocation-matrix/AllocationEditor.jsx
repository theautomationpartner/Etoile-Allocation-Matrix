import { useEffect, useRef } from "react";
import { fmt } from "../../lib/format.js";
import { usedOf } from "../../lib/allocation.js";

// Step 3 — allocation editor of one sale line (PDF §8.1, §10), opened right below its row.
// Same markup as the mockup: tr.ed > .ap (header, draft notice, one row per source, footer, rule note).
export function AllocationEditor({ ed, state, nCol, onChange, onSuggest, onClear, onCancel, onSave }) {
  const { values, focus, notice, error, saving } = state;
  const used = usedOf(values);
  const rootRef = useRef(null);
  const empty = !ed.rows.length || ed.rows.every((r) => r.max <= 0 && !(values[r.id] > 0));

  // §15.3 — the field of the source that was clicked gets the focus (else the first one that can be used).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const el = (focus && root.querySelector(`input[data-apr="${CSS.escape(String(focus))}"]:not([disabled])`)) || root.querySelector(".ap-rows input:not([disabled])");
    el?.focus({ preventScroll: true });
    el?.select?.();
  }, [ed.line.lineId, focus]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <tr className="ed">
      <td colSpan={nCol}>
        <div className="ap" ref={rootRef}>
          <div className="ap-h">
            <div className="ap-t"><b>{ed.title}</b><i>{ed.sub}</i></div>
            <div className="ap-btns">
              <button type="button" className="btn" onClick={onSuggest} disabled={saving}>Suggest a split</button>
              <button type="button" className="btn" onClick={onClear} disabled={saving}>Clear</button>
            </div>
          </div>
          {ed.hasDraft && <div className="ap-draft"><b>Draft</b> These quantities are a proposal. Nothing is allocated until you click Allocate.</div>}
          {empty ? (
            <div className="ap-empty">There is nothing to assign. This product has no stock on hand, nothing travelling and nothing on order — it has to be purchased before this line can be covered.</div>
          ) : (
            <div className="ap-rows">
              {ed.rows.map((r) => {
                const v = values[r.id] || 0;
                const off = r.max <= 0 && v <= 0;
                return (
                  <div key={r.id} className={`apr ${off ? "off" : ""}`}>
                    <span className={`apk ${r.k}`} />
                    <span className="apn">
                      <b>{r.title}</b><i>{r.meta}</i>
                      {r.lines.map((t, i) => <i key={i} className="apl">{t}</i>)}
                    </span>
                    <span className="apav">{fmt(r.max)} available</span>
                    <input type="number" inputMode="numeric" min="0" max={r.max} value={v || ""} placeholder="0"
                      data-apr={r.id} disabled={off || saving} aria-label={`Units from ${r.title}`}
                      onChange={(e) => onChange(r, e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onSave(); } }} />
                  </div>
                );
              })}
            </div>
          )}
          <div className="ap-f">
            <span className="ap-sum">
              <b>{fmt(used)}</b> of {fmt(ed.goal)} units to cover assigned · <b>{fmt(Math.max(0, ed.goal - used))}</b> left
              {notice ? ` · ${notice}` : ""}
            </span>
            <span className="sp" />
            <button type="button" className="btn" onClick={onCancel} disabled={saving}>Cancel</button>
            <button type="button" className="btn on" onClick={onSave} disabled={saving}>{saving ? "Allocating…" : "Allocate"}</button>
          </div>
          {error && <div className="ap-err" role="alert" style={{ marginLeft: 0, marginTop: 8 }}>{error}</div>}
          <p className="ap-note">{ed.note}</p>
        </div>
      </td>
    </tr>
  );
}
