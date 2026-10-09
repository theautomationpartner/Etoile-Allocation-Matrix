import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// A date field with its own calendar, always in English. The browser's native date picker can't be used: inside
// monday the app runs in a cross-origin iframe, where opening it (showPicker) is blocked. The calendar is rendered
// into <body> (portal) under its button, so tables and side panels never clip it. Closes on a click outside or Esc.
//   value / min: "YYYY-MM-DD" · onChange(value) · className: the button's class · children: the button's content.
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const todayIso = () => { const t = new Date(); return iso(t.getFullYear(), t.getMonth(), t.getDate()); };

export function DatePicker({ value, onChange, min, className = "", ariaLabel, children }) {
  const btn = useRef(null), panel = useRef(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => monthOf(value || todayIso()));
  const [pos, setPos] = useState(null);

  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const w = 252, h = 300;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const top = r.bottom + 4 + h > window.innerHeight && r.top - 4 - h > 0 ? r.top - 4 - h : r.bottom + 4;
    setPos({ left, top });
  };
  useLayoutEffect(() => { if (open) place(); }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (e) => { if (!panel.current?.contains(e.target) && !btn.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); btn.current?.focus(); } };
    document.addEventListener("mousedown", outside);
    window.addEventListener("keydown", esc, true);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", esc, true);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  const toggle = () => { if (!open) setView(monthOf(value || todayIso())); setOpen((o) => !o); };
  const pick = (d) => { onChange(d); setOpen(false); btn.current?.focus(); };
  const { y, m } = view;
  const first = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  const cells = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  const today = todayIso();
  const step = (k) => setView(({ y: yy, m: mm }) => { const t = mm + k; return { y: yy + Math.floor(t / 12), m: ((t % 12) + 12) % 12 }; });

  return (
    <>
      <button ref={btn} type="button" className={className} onClick={toggle} aria-label={ariaLabel} aria-haspopup="dialog" aria-expanded={open}>
        {children}
      </button>
      {open && pos && createPortal(
        <div ref={panel} className="dp" role="dialog" aria-label="Choose a date" style={{ left: pos.left, top: pos.top }}>
          <div className="dp-h">
            <button type="button" className="dp-nav" onClick={() => step(-1)} aria-label="Previous month">‹</button>
            <b>{MONTHS[m]} {y}</b>
            <button type="button" className="dp-nav" onClick={() => step(1)} aria-label="Next month">›</button>
          </div>
          <div className="dp-g">
            {DAYS.map((d) => <span key={d} className="dp-w">{d}</span>)}
            {cells.map((d, i) => {
              if (!d) return <span key={`e${i}`} />;
              const v = iso(y, m, d);
              const off = Boolean(min && v < min);
              return (
                <button key={v} type="button" disabled={off} onClick={() => pick(v)} aria-label={`${d} ${MONTHS[m]} ${y}`} aria-pressed={v === value}
                  className={`dp-d ${v === value ? "on" : ""} ${v === today ? "today" : ""}`}>{d}</button>
              );
            })}
          </div>
          <div className="dp-f">
            <button type="button" onClick={() => pick(today)} disabled={Boolean(min && today < min)}>Today</button>
            {value && <button type="button" onClick={() => pick("")}>Clear</button>}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function monthOf(s) {
  const [y, m] = String(s).split("-").map(Number);
  return { y, m: m - 1 };
}
