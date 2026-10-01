import { useCallback, useRef } from "react";
import { useStoredState } from "./useStoredState.js";

// Resizable matrix columns, like monday: drag the right edge of a header to widen or narrow it,
// double-click the edge to go back to the default. Widths are remembered by the browser (per viewer).
export const DEFAULT_WIDTHS = { s1: 300, s2: 290, src: 116, end: 104 };
const MIN = { s1: 180, s2: 220, src: 72, end: 84 };

export function useColumnWidths() {
  const [widths, setWidths] = useStoredState("etoile-col-widths", {});
  const drag = useRef(null);

  const kind = (key) => (key === "s1" || key === "s2" || key === "end" ? key : "src");
  const widthOf = useCallback((key) => widths[key] || DEFAULT_WIDTHS[kind(key)], [widths]);

  // invert: the handle is on the left edge (the Impossible column, fixed to the right).
  const startResize = useCallback((key, e, invert = false) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX, startW = widths[key] || DEFAULT_WIDTHS[kind(key)];
    drag.current = { key, startX, startW, sign: invert ? -1 : 1 };
    const move = (ev) => {
      const d = drag.current;
      if (!d) return;
      const w = Math.max(MIN[kind(d.key)], Math.round(d.startW + d.sign * (ev.clientX - d.startX)));
      setWidths((cur) => ({ ...cur, [d.key]: w }));
    };
    const up = () => {
      drag.current = null;
      document.body.classList.remove("col-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    document.body.classList.add("col-resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [widths, setWidths]);

  const reset = useCallback((key) => setWidths((cur) => {
    const next = { ...cur };
    delete next[key];
    return next;
  }), [setWidths]);

  return { widthOf, startResize, reset };
}
