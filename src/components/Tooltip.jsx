import { useCallback, useState } from "react";

// Instant tooltip for the matrix (the browser's title attribute takes about a second to show).
// Any element with data-tip="…" inside the area gets it; "\n" starts a new line.
export function useTooltip() {
  const [tip, setTip] = useState(null);
  const onMouseOver = useCallback((e) => {
    const el = e.target.closest?.("[data-tip]");
    if (!el || !el.dataset.tip) return setTip(null);
    const r = el.getBoundingClientRect();
    setTip({ text: el.dataset.tip, x: r.left + r.width / 2, top: r.top, bottom: r.bottom });
  }, []);
  const onMouseLeave = useCallback(() => setTip(null), []);
  return { tip, handlers: { onMouseOver, onMouseLeave } };
}

export function Tooltip({ tip }) {
  if (!tip) return null;
  const below = tip.top < 140; // near the top of the screen → show it under the element
  const style = {
    left: Math.min(Math.max(tip.x, 170), window.innerWidth - 170),
    top: below ? tip.bottom + 8 : tip.top - 8,
    transform: below ? "translateX(-50%)" : "translate(-50%, -100%)",
  };
  return <div className="mx-tip" role="tooltip" style={style}>{tip.text}</div>;
}
