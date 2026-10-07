import { useState } from "react";
import { REVIEW_TYPES } from "../../lib/review.js";

// Review (client, 2026-10-07): what needs a decision, above the matrix. Closed by default; the count is
// always visible. Only "Allocated above what is left to ship" has an action (Release); the other cases are
// left in view so they can be followed up in monday.
export function ReviewPanel({ items, busyKey, onRelease }) {
  const [open, setOpen] = useState(false);
  if (!items) return null;
  const groups = Object.entries(REVIEW_TYPES).map(([type, label]) => ({ type, label, items: items.filter((i) => i.type === type) })).filter((g) => g.items.length);
  return (
    <section className={`rv ${open ? "open" : ""}`} aria-label="Needs review">
      <button type="button" className="rv-h" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="rv-t">Needs review</span>
        <span className={`rv-n ${items.length ? "" : "zero"}`}>{items.length}</span>
        <span className="rv-s">{items.length ? groups.map((g) => `${g.items.length} ${g.label.toLowerCase()}`).join(" · ") : "Nothing to review"}</span>
        <span className="rv-c" aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && items.length > 0 && (
        <div className="rv-b">
          {groups.map((g) => (
            <div key={g.type} className="rv-g">
              <div className="rv-gl">{g.label}</div>
              {g.items.map((i) => (
                <div key={i.key} className="rv-i">
                  <div className="rv-x">
                    <b>{i.title}</b> <span>{i.text}</span>
                    {i.detail && <i>{i.detail}</i>}
                  </div>
                  {i.action && (
                    <button type="button" className="btn" disabled={Boolean(busyKey)} onClick={() => onRelease(i)}>
                      {busyKey === i.key ? "Releasing…" : i.action}
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
